/**
 * GitHub REST API v3 客户端（零依赖，基于 node:https）。
 *
 * DNS 韧性（对应本机 hosts 被工具改写、把 github 域名指向 127.0.0.1 的问题）：
 * 默认传输层使用自定义 lookup —— 先按系统解析（尊重 hosts 加速/企业映射），
 * 若解析结果被指到本机（127.0.0.1 / ::1）或解析失败，则改用 `dns.resolve4`
 * 直查 DNS，绕过 hosts 文件中的屏蔽条目，保证 github_* 工具不因 hosts 被改坏而失效。
 *
 * 安全约定（对应验收标准 5：token 不出现于日志与工具输出）：
 *  - token 只进入 `Authorization: Bearer` 请求头，绝不进 URL、请求体、日志；
 *  - 跨域重定向时丢弃 Authorization，避免 token 外泄；
 *  - 日志只记录方法 + 路径 + 状态码；
 *  - 构造错误信息时对任何可能回显的内容做 `redact()` 防御性脱敏。
 *
 * @module dsh-github/client
 */

import { request as httpsRequest } from "node:https";
import dns from "node:dns";

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_WEB_BASE = "https://github.com";

/** 插件统一的 GitHub API 版本头。 */
export const GITHUB_API_VERSION = "2022-11-28";

/** 插件自身的 User-Agent（GitHub 要求自定义 UA，空 UA 会被拒绝）。 */
export const USER_AGENT = "dsh-github-plugin/1.0";

/** 默认最大重定向次数。 */
const MAX_REDIRECTS = 3;

/** 工具错误基类：code 用于模型识别（如 GITHUB_AUTH_REQUIRED）。 */
export class GithubError extends Error {
	constructor(message, code = "GITHUB_ERROR", info = {}) {
		super(message);
		this.name = "GithubError";
		this.code = code;
		if (info.status !== void 0) this.status = info.status;
		if (info.path !== void 0) this.path = info.path;
		if (info.rateLimit !== void 0) this.rateLimit = info.rateLimit;
	}
}

/** 认证缺失 / 401：提示重新登录。 */
export class GithubAuthError extends GithubError {
	constructor(message = "GitHub 未认证或 token 已失效：请配置 GITHUB_TOKEN 或调用 github_auth_login 完成 OAuth Device Flow 登录。") {
		super(message, "GITHUB_AUTH_REQUIRED");
		this.name = "GithubAuthError";
	}
}

/** GitHub API 4xx/5xx。 */
export class GithubApiError extends GithubError {
	constructor(status, message, path, rateLimit) {
		super(message, `GITHUB_HTTP_${status}`, { status, path, rateLimit });
		this.name = "GithubApiError";
	}
}

/** 防御性脱敏：把 token 从任意文本中抹掉（错误信息、渲染文本兜底）。 */
export function redact(text, token) {
	if (typeof text !== "string" || typeof token !== "string" || token.length === 0) return text;
	return text.split(token).join("***");
}

/**
 * 生成「系统解析优先、DNS 直查兜底」的 lookup 函数（供 node:https 的 lookup 选项）。
 * 当 hosts 把目标域名指向 127.0.0.1/::1（屏蔽/坏条目）或系统解析失败时，
 * 用 `dns.resolve4` 绕过 hosts 直接查询 DNS 返回真实 IP。
 * @param {object} [options] - 可注入解析器（测试用）；缺省用 node:dns。
 * @param {Function} [options.lookup] - (hostname, options, cb) => void，默认 dns.lookup。
 * @param {Function} [options.resolve4] - (hostname, cb) => void，默认 dns.resolve4。
 * @returns {Function} (hostname, options, callback(err, address, family)) => void
 */
export function createGithubLookup(options = {}) {
	const lookupFn = options.lookup ?? dns.lookup.bind(dns);
	const resolve4Fn = options.resolve4 ?? dns.resolve4.bind(dns);
	return (hostname, nodeOptions, callback) => {
		// Node 20+ 的 autoSelectFamily（Happy Eyeballs）以 all:true 调用 lookup，
		// 期望回调返回地址数组；必须尊重该标志，否则 node 报 “Invalid IP address: undefined”。
		const wantAll = Boolean(nodeOptions?.all);
		lookupFn(hostname, { all: true }, (err, addresses) => {
			const usable = Array.isArray(addresses)
				? addresses.filter((entry) => entry.address !== "127.0.0.1" && entry.address !== "::1")
				: [];
			if (!err && usable.length > 0) {
				if (wantAll) return callback(null, usable);
				const picked = usable[0];
				return callback(null, picked.address, picked.family);
			}
			// 系统解析失败 / 被 hosts 指到本机 → DNS 直查绕过 hosts
			resolve4Fn(hostname, (err2, ips) => {
				if (err2 || !Array.isArray(ips) || ips.length === 0) {
					return callback(err ?? err2 ?? new Error(`DNS 解析失败：${hostname}`), null, 4);
				}
				const ip = ips.find((entry) => entry !== "127.0.0.1") ?? ips[0];
				const entries = [{ address: ip, family: 4 }];
				if (wantAll) return callback(null, entries);
				callback(null, ip, 4);
			});
		});
	};
}

/**
 * 默认传输层：node:https + DNS 兜底 lookup + 超时/中止 + 同源重定向跟随。
 * 可注入（测试用）：transport({ method, url, headers, body, signal })
 *   → Promise<{ status, statusText, headers, text }>。
 * @param {object} [options]
 * @param {number} [options.timeoutMs]
 * @param {Function} [options.lookup]
 * @returns {Function}
 */
export function createHttpsTransport(options = {}) {
	const { timeoutMs = 30000, lookup = createGithubLookup() } = options;

	const send = (ctx) => new Promise((resolve, reject) => {
		const { method, url, headers, body, signal } = ctx;
		const redirects = ctx.redirects ?? 0;
		const u = new URL(url);
		let timedOut = false;
		let settled = false;

		const req = httpsRequest(u, { method, headers, lookup }, (res) => {
			const status = res.statusCode ?? 0;
			// 跟随重定向（同源才保留 Authorization）
			if (status >= 300 && status < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
				res.resume();
				const next = new URL(res.headers.location, u).href;
				const nextHeaders = new URL(next).origin === u.origin ? headers : omit(headers, ["authorization", "Authorization"]);
				return send({ method, url: next, headers: nextHeaders, body, signal, redirects: redirects + 1 })
					.then(resolve, reject);
			}
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				settled = true;
				resolve({
					status,
					statusText: res.statusMessage ?? "",
					headers: res.headers,
					text: Buffer.concat(chunks).toString("utf8")
				});
			});
			res.on("error", (error) => {
				settled = true;
				reject(new GithubError(`GitHub 响应读取失败：${error?.message ?? String(error)}`, "GITHUB_NETWORK"));
			});
		});

		const onAbort = () => req.destroy(Object.assign(new Error("aborted"), { aborted: true }));
		if (signal !== void 0) {
			if (signal.aborted) {
				req.destroy(Object.assign(new Error("aborted"), { aborted: true }));
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
		const timer = setTimeout(() => {
			timedOut = true;
			req.destroy(new Error("timeout"));
		}, timeoutMs);
		if (typeof timer.unref === "function") timer.unref();

		req.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timedOut) {
				return reject(new GithubError(`GitHub 请求超时（${timeoutMs}ms）：${method} ${u.pathname}`, "GITHUB_TIMEOUT", { path: u.pathname }));
			}
			if (error?.aborted) {
				return reject(new GithubError("GitHub 请求已取消", "GITHUB_ABORTED", { path: u.pathname }));
			}
			reject(new GithubError(`GitHub 网络请求失败：${error?.message ?? String(error)}`, "GITHUB_NETWORK", { path: u.pathname }));
		});
		req.on("close", () => {
			clearTimeout(timer);
			signal?.removeEventListener?.("abort", onAbort);
		});

		if (body !== void 0) req.write(body);
		req.end();
	});

	return send;
}

/** 删除 headers 中指定键（重定向时剥离凭证）。 */
function omit(headers, keys) {
	const out = { ...headers };
	for (const key of keys) delete out[key];
	return out;
}

/**
 * 创建 GitHub API 客户端。
 * @param {object} options
 * @param {() => Promise<{token: string, source: string} | null>} options.resolveToken - 每次请求前解析 token。
 * @param {{warn?: Function, error?: Function}} [options.logger] - 可选日志器；只记录方法/路径/状态码。
 * @param {number} [options.timeoutMs] - 单请求超时。
 * @param {string} [options.baseUrl] - API 基址（测试可注入）。
 * @param {Function} [options.transport] - 传输层（测试注入），默认 https + DNS 兜底。
 * @returns {{request: Function, baseUrl: string, resolveToken: Function}}
 */
export function createClient(options = {}) {
	const {
		resolveToken,
		logger,
		timeoutMs = 30000,
		baseUrl = GITHUB_API_BASE,
		transport
	} = options;
	const send = transport ?? createHttpsTransport({ timeoutMs });

	/**
	 * 发一次 GitHub REST 请求。
	 * @param {string} method - HTTP 方法。
	 * @param {string} path - API 路径，如 `/repos/owner/repo`。
	 * @param {object} [opts]
	 * @param {object} [opts.query] - 查询参数（跳过 undefined/null/空串）。
	 * @param {object} [opts.body] - JSON 请求体。
	 * @param {boolean} [opts.raw] - true 时返回原始文本（diff 等）。
	 * @param {string} [opts.accept] - Accept 覆盖（如 diff）。
	 * @param {AbortSignal} [opts.signal] - 外部取消信号（exec.signal）。
	 * @param {string} [opts.token] - 显式 token（默认走 resolveToken）。
	 * @returns {Promise<{data?: any, text?: string, rateLimit?: object}>}
	 */
	async function request(method, path, opts = {}) {
		const { query, body, raw = false, accept, signal, token: explicitToken } = opts;
		let token = explicitToken;
		if (token === void 0) {
			const resolved = await resolveToken();
			if (resolved === null) throw new GithubAuthError();
			token = resolved.token;
		}
		const url = new URL(baseUrl + path);
		if (query !== void 0) {
			for (const [key, value] of Object.entries(query)) {
				if (value === void 0 || value === null || value === "") continue;
				url.searchParams.set(key, String(value));
			}
		}
		const wireBody = body !== void 0 ? JSON.stringify(body) : void 0;
		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: accept ?? "application/vnd.github+json",
			"X-GitHub-Api-Version": GITHUB_API_VERSION,
			"User-Agent": USER_AGENT,
			...(wireBody !== void 0
				? {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(wireBody, "utf8"))
				}
				: {})
		};

		let response;
		try {
			response = await send({
				method,
				url: url.href,
				headers,
				body: wireBody,
				signal
			});
		} catch (error) {
			throw error instanceof GithubError ? error : new GithubError(`GitHub 网络请求失败：${error?.message ?? String(error)}`, "GITHUB_NETWORK", { path });
		}

		const lower = {};
		for (const [key, value] of Object.entries(response.headers ?? {})) lower[key.toLowerCase()] = value;
		const rateLimit = {
			remaining: lower["x-ratelimit-remaining"],
			limit: lower["x-ratelimit-limit"],
			reset: lower["x-ratelimit-reset"]
		};
		logger?.warn?.(`github api ${method} ${path} -> ${response.status} (rate ${rateLimit.remaining}/${rateLimit.limit})`);

		if (response.status < 200 || response.status >= 300) {
			let message = `GitHub API ${response.status} ${response.statusText ?? ""}`;
			if (typeof response.text === "string" && response.text.length > 0) {
				try {
					const data = JSON.parse(response.text);
					if (typeof data?.message === "string") message = redact(data.message, token);
					if (Array.isArray(data?.errors) && data.errors.length > 0) {
						const detail = data.errors.map((entry) => entry?.message ?? JSON.stringify(entry)).join("; ");
						message = `${message}（${detail}）`;
					}
				} catch { /* 非 JSON 错误体：保留默认文案 */ }
			}
			if (response.status === 401) throw new GithubAuthError(`GitHub 认证失败（401）：${message}`);
			throw new GithubApiError(response.status, message, path, rateLimit);
		}
		if (raw) return { text: response.text ?? "", rateLimit };
		if (response.status === 204 || String(lower["content-length"] ?? "") === "0" || response.text.length === 0) {
			return { data: void 0, rateLimit };
		}
		let data;
		try {
			data = JSON.parse(response.text);
		} catch (error) {
			throw new GithubError(`GitHub 响应不是合法 JSON：${error?.message ?? String(error)}`, "GITHUB_BAD_RESPONSE", { path });
		}
		return { data, rateLimit };
	}

	return { request, baseUrl, resolveToken };
}
