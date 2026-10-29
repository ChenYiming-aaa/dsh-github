/**
 * 认证类工具：get_me（token 校验）、auth_login（OAuth Device Flow）、
 * auth_status（认证状态）、auth_logout（清除凭据）。
 *
 * @module dsh-github/tools/auth
 */

import { defineTool } from "@deepseek-ai/dsh-tools";
import { createDeviceFlowPoller, resolveToken, startDeviceFlow, DEFAULT_SCOPES, DEVICE_FLOW_STATUS } from "../auth.js";
import { renderText, renderUser, presentCall, pick } from "../format.js";
import { s } from "./common.js";

/** 认证状态输出 schema。 */
const AUTH_STATUS_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		configured: { type: "boolean", required: true },
		source: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
		valid: { type: "boolean", required: true },
		username: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
		user: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true },
		error: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
		deviceFlow: { oneOf: [{ type: "object", additionalProperties: true }, { type: "null" }], required: true }
	}
};

/** Device flow 登录输出 schema。 */
const LOGIN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		status: { type: "string", required: true, enum: [...new Set(["already_configured", ...Object.values(DEVICE_FLOW_STATUS)])] },
		userCode: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
		verificationUri: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
		expiresIn: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
		interval: { oneOf: [{ type: "integer" }, { type: "null" }], required: true },
		note: { type: "string", required: true },
		existingSource: { oneOf: [{ type: "string" }, { type: "null" }], required: true }
	}
};

/** 解析 OAuth Client Secret：config → credentials/env 引用的 ref。 */
async function resolveOauthSecret(runtime) {
	const { config, ctx } = runtime;
	if (typeof config.oauthClientSecret === "string" && config.oauthClientSecret.length > 0) return config.oauthClientSecret;
	const ref = String(config.oauthClientSecretRef ?? "GITHUB_OAUTH_CLIENT_SECRET");
	const credentials = ctx.get?.("credentials");
	if (credentials !== void 0 && typeof credentials.resolve === "function") {
		try {
			const resolved = await credentials.resolve(ref);
			if (resolved?.value) return resolved.value;
		} catch { /* fallthrough */ }
	}
	return process.env[ref];
}

export function buildAuthTools(runtime) {
	const { api, config, state, ctx } = runtime;
	const tokenRef = String(config.tokenRef ?? "GITHUB_TOKEN");

	const persistToken = async (token) => {
		const credentials = ctx.get?.("credentials");
		if (credentials !== void 0 && typeof credentials.set === "function") {
			try {
				await credentials.set(tokenRef, token);
				return { stored: true, where: "credentials" };
			} catch (error) {
				ctx.logger?.warn?.("dsh-github: 无法写入凭据 %s（可能被环境变量遮蔽）：%s", tokenRef, error?.message ?? String(error));
				return { stored: false, where: null };
			}
		}
		return { stored: false, where: null };
	};

	return [
		defineTool({
			name: "github_get_me",
			description: "校验 GitHub 认证并返回当前登录用户信息（等价于 opencode 的 get_me）。首次使用或不确定认证是否生效时先调用本工具；任何 github_* 工具返回认证错误时也应调用本工具确认 token 状态。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						user: { type: "object", additionalProperties: true, required: true },
						source: { type: "string", required: true },
						login: { type: "string", required: true },
						htmlUrl: { type: "string", required: true }
					}
				},
				render: (args, value) => renderText(`${renderUser(value.user ?? {})}\n认证来源：${value.source ?? "?"}`)
			},
			presentCall: (args) => presentCall("GitHub: 当前用户"),
			async execute() {
				const resolved = await resolveToken(ctx, config);
				if (resolved === null) throw new Error("GitHub 未认证：请先配置 GITHUB_TOKEN（环境变量或 DSH 设置）或调用 github_auth_login 完成 OAuth Device Flow 登录。");
				const { data } = await api.request("GET", "/user");
				state.authInfo = data;
				return {
					user: data,
					source: resolved.source,
					login: data.login,
					htmlUrl: data.html_url
				};
			}
		}),

		defineTool({
			name: "github_auth_login",
			description: "启动 GitHub OAuth Device Flow 登录：返回验证网址与用户码，请让用户在浏览器打开网址并输入用户码；插件在后台自动轮询，授权完成后把 token 持久化到 DSH credentials 服务（重启仍有效）。需要插件配置 oauthClientId（与 oauthClientSecret）。已配置认证时直接返回当前状态。",
			parameters: {
				scope: s("申请的 scope（可选），默认 repo,read:org,user")
			},
			output: {
				schema: LOGIN_SCHEMA,
				render: (args, value) => {
					if (value.status === "already_configured") {
						return renderText(`GitHub 已配置认证（来源：${value.existingSource}）。如需重新登录，请先调用 github_auth_logout。`);
					}
					if (value.status === DEVICE_FLOW_STATUS.COMPLETED) {
						return renderText("Device Flow 已完成，token 已持久化。调用 github_auth_status 或 github_get_me 确认。");
					}
					return renderText([
						`Device Flow 已启动（状态：${value.status}）。`,
						`请在浏览器打开：${value.verificationUri}`,
						`输入用户码：${value.userCode}`,
						`（${Math.round(value.expiresIn / 60)} 分钟内有效，后台每 ${value.interval} 秒轮询一次）`,
						`完成后 token 会自动写入 DSH credentials，无需再次登录。`,
						`可用 github_auth_status 查询进度。`
					].join("\n"));
				}
			},
			presentCall: (args) => presentCall("GitHub: OAuth 登录"),
			async execute() {
				const existing = await resolveToken(ctx, config);
				if (existing !== null) {
					return {
						status: "already_configured",
						userCode: null,
						verificationUri: null,
						expiresIn: null,
						interval: null,
						note: "已配置认证，无需重复登录。",
						existingSource: existing.source
					};
				}
				const clientSecret = await resolveOauthSecret(runtime);
				const flow = await startDeviceFlow({
					clientId: config.oauthClientId,
					clientSecret,
					scope: args.scope ?? config.oauthScope ?? DEFAULT_SCOPES
				});
				state.pendingFlow?.stop?.();
				const poller = createDeviceFlowPoller({
					clientId: config.oauthClientId,
					clientSecret,
					deviceCode: flow.deviceCode,
					interval: flow.interval,
					expiresIn: flow.expiresIn,
					onToken: (token) => {
						void persistToken(token).then((result) => {
							state.deviceFlowStatus = DEVICE_FLOW_STATUS.COMPLETED;
							state.authInfo = null;
							ctx.logger?.info?.("dsh-github: device flow 完成，token 已%s", result.stored ? "持久化到 credentials" : "仅保存在内存（无法写入凭据存储）");
						});
					},
					onStatus: (status) => { state.deviceFlowStatus = status; }
				});
				state.pendingFlow = poller;
				state.deviceFlowStatus = DEVICE_FLOW_STATUS.PENDING;
				state.lastFlowPublic = { userCode: flow.userCode, verificationUri: flow.verificationUri };
				return {
					status: DEVICE_FLOW_STATUS.PENDING,
					userCode: flow.userCode,
					verificationUri: flow.verificationUri,
					expiresIn: flow.expiresIn,
					interval: flow.interval,
					note: "请在浏览器中打开 verificationUri 并输入 userCode；后台会自动完成授权与 token 持久化。",
					existingSource: null
				};
			}
		}),

		defineTool({
			name: "github_auth_status",
			description: "查询 GitHub 认证状态：是否已配置、来源（env/credentials）、token 是否有效（实时调用 get_me 校验）、当前登录用户、进行中的 Device Flow 状态。",
			parameters: {},
			output: {
				schema: AUTH_STATUS_SCHEMA,
				render: (args, value) => {
					if (!value.configured) {
						return renderText("GitHub 未配置认证。请配置 GITHUB_TOKEN（环境变量或 DSH 设置）或调用 github_auth_login 完成 OAuth 登录。");
					}
					const flow = value.deviceFlow ?? null;
					const flowLine = flow ? `\nDevice Flow：${flow.status}${flow.userCode ? `（用户码 ${flow.userCode}，${flow.verificationUri}）` : ""}` : "";
					if (!value.valid) {
						return renderText(`GitHub 已配置（来源：${value.source}）但 token 校验失败：${value.error ?? "未知错误"}。请重新配置或调用 github_auth_logout 后重新登录。${flowLine}`);
					}
					return renderText(`GitHub 认证有效（来源：${value.source}）。\n当前用户：${value.username ?? "?"}${flowLine}`);
				}
			},
			presentCall: (args) => presentCall("GitHub: 认证状态"),
			async execute() {
				const resolved = await resolveToken(ctx, config);
				// state.pendingFlow 初始为 null（index.js），注销/流程结束后也会被置为
				// null 或 undefined；用 == null 同时覆盖两种空值，否则 .status() 会抛
				// TypeError 并让整个工具在“未配置认证”的场景下也失败。
				const flow = state.pendingFlow == null ? null : {
					status: state.deviceFlowStatus ?? state.pendingFlow.status?.() ?? null,
					...(state.lastFlowPublic ?? {})
				};
				if (resolved === null) {
					return { configured: false, source: null, valid: false, username: null, user: null, error: null, deviceFlow: flow };
				}
				let user = null;
				let valid = false;
				let error = null;
				try {
					const { data } = await api.request("GET", "/user");
					user = data;
					valid = true;
					state.authInfo = data;
				} catch (err) {
					error = err?.message ?? String(err);
				}
				return {
					configured: true,
					source: resolved.source,
					valid,
					username: user?.login ?? null,
					user: user ? pick(user, ["login", "name", "email", "avatar_url", "html_url", "bio", "company", "location", "public_repos", "followers", "following"]) : null,
					error,
					deviceFlow: flow
				};
			}
		}),

		defineTool({
			name: "github_auth_logout",
			description: "清除 GitHub 认证：删除 credentials 存储中的 token（若 token 来自环境变量则无法删除，会给出提示），并停止进行中的 Device Flow。",
			parameters: {},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						cleared: { type: "boolean", required: true },
						source: { oneOf: [{ type: "string" }, { type: "null" }], required: true },
						message: { type: "string", required: true }
					}
				},
				render: (args, value) => renderText(value.message)
			},
			presentCall: (args) => presentCall("GitHub: 退出登录"),
			async execute() {
				state.pendingFlow?.stop?.();
				state.pendingFlow = null;
				state.deviceFlowStatus = null;
				state.lastFlowPublic = null;
				state.authInfo = null;
				const resolved = await resolveToken(ctx, config);
				const credentials = ctx.get?.("credentials");
				if (resolved === null) {
					return { cleared: false, source: null, message: "当前未配置 GitHub 认证，无需退出。" };
				}
				if (resolved.source === "env") {
					return { cleared: false, source: "env", message: "token 来自启动环境（env），无法由插件删除；请在启动 DSH 的环境中移除 GITHUB_TOKEN。" };
				}
				if (credentials !== void 0 && typeof credentials.unset === "function") {
					await credentials.unset(tokenRef);
					return { cleared: true, source: resolved.source, message: `已从 DSH credentials 删除 ${tokenRef}。` };
				}
				return { cleared: false, source: resolved.source, message: "没有可写的 credentials 服务，无法删除 token。" };
			}
		})
	];
}
