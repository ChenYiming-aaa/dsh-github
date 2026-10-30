# dsh-github — DeepSeek Harness 的 GitHub 集成插件

对标 opencode 的 GitHub MCP server：**一次配置认证，长期可用**。模型在对话中直接调用
`github_*` 工具完成建仓、推送、提 PR、管 issue、搜索代码等 GitHub 事务，**不再每次操作
都要求临时授权**。

- 零依赖（只用 Node 22+ 内置模块），45 个工具，全部走 GitHub REST API v3
- 认证持久化：`GITHUB_TOKEN`（环境变量 / DSH credentials 服务）或 OAuth Device Flow
  （浏览器授权一次，token 自动写入 `$DSH_HOME/.credentials.yaml`，重启 DSH 依然有效）
- 审批策略：读操作 + 常规写操作直接放行；删除仓库/文件/分支、force push、合并 PR、
  关闭 issue/PR 保留审批门
- DNS 韧性：系统解析（hosts）把 github 域名指向 127.0.0.1（屏蔽/坏条目）时自动改用
  DNS 直查绕过，`github_*` 工具不因 hosts 文件被改坏而失效
- 安全：token 只进 `Authorization` 请求头，绝不落日志；错误信息与工具输出做防御性脱敏

## 兼容性

- 需要 `@deepseek-ai/dsh-tools` `>=0.1.0-rc.1 <0.3.0-0`（即 DSH 0.1.x 与 0.2.x）
- 已在 **dsh 0.2.1-rc.5** 上跑通全部测试：45 个工具经真实 dsh-tools 的 schema 编译/校验
- 运行时版本不满足 peer 范围时，DSH 会跳过本插件并提示 exact-version exemption；
  确认风险后可用 `dsh plugin --profile <profile> allow-version dsh-github@<ver> --dsh-version <当前版本> --accept-risk` 强制加载

## 快速开始

### 1. 安装插件（web + desktop 两个 profile）

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
# 只装一个 profile：powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profiles desktop
```

安装脚本会：
1. 把插件包复制到 `%USERPROFILE%\.dsh\profiles\node_modules\dsh-github\`
2. 在 `web` 与 `desktop` 两个 profile 的 `cordis.patch.yml` 追加注册条目（幂等）

**重启 DSH Desktop**（或重载 web profile）后生效。

### 2. 配置认证（二选一，均持久生效）

**方式 A — Personal Access Token（推荐先试这个）**

```powershell
# 1) 在 GitHub → Settings → Developer settings → Personal access tokens 生成
#    （需要 repo、read:org、user 权限）
# 2a) 环境变量（最简单）
setx GITHUB_TOKEN "ghp_xxx"        # 新开的终端/重启 DSH 后生效
# 2b) 或写入 DSH credentials（$DSH_HOME/.credentials.yaml，密码学托管、不落日志）
#     DSH 设置页 → 凭据 → 新增 GITHUB_TOKEN → 粘贴 token
```

**方式 B — OAuth Device Flow（浏览器授权一次）**

1. 在 GitHub 创建一个 OAuth App（Settings → Developer settings → OAuth Apps），
   Authorization callback URL 填任意合法 URL（如 `https://github.com`）
2. 把 Client ID 填入插件配置（两个 profile 的 `cordis.patch.yml`）：

```yaml
- insert:
    - id: github
      name: dsh-github
      config:
        tokenRef: GITHUB_TOKEN
        approvalGate: true
        timeoutMs: 30000
        oauthClientId: Ov23liXXXXXXXX
        oauthClientSecretRef: GITHUB_OAUTH_CLIENT_SECRET   # 推荐：凭据引用
        # 或直接内联（不推荐明文）：oauthClientSecret: xxxx
```

3. 设置 Client Secret 凭据：DSH 设置页新增 `GITHUB_OAUTH_CLIENT_SECRET`
   （或环境变量 `GITHUB_OAUTH_CLIENT_SECRET`）。GitHub 的 device flow 换取 token
   必须携带 client secret。
4. 重启 DSH，新会话中对模型说「**用 github_auth_login 登录 GitHub**」，
   浏览器打开返回的网址、输入用户码，授权一次即可；token 自动持久化，之后长期可用。

> GitHub device-flow 的 access token 长期有效、没有 refresh token 机制；
> 若失效（表现为 401），调用 `github_auth_logout` 清除后重新登录即可。

### 3. 验证

新会话中让模型执行：

- `github_get_me` —— 应返回当前 GitHub 用户（等价 opencode 的 get_me）
- `github_auth_status` —— 认证来源与有效性

## 常用流程示例

**一键上传项目**（建仓 → 推送 → 开 PR 全流程，常规操作无审批弹窗）：

```
github_upload_project(repo: "my-app", description: "我的应用",
  files: [{path: "README.md", content: "# my-app"}, {path: "src/main.js", content: "..."}],
  create_pull_request: true)
```

**手把手流程**（等价 opencode push 多文件的体验）：

```
1. github_create_repository(name: "my-app", private: true)
2. github_create_branch(owner, repo, branch: "feature/init")
3. github_push_files(owner, repo, branch: "feature/init", message: "init", files: [...])
4. github_create_pull_request(owner, repo, title: "init", head: "feature/init", base: "main")
5. github_merge_pull_request(owner, repo, pull_number: 1, merge_method: "squash")  # 🔒 需审批
```

## 工具清单

见 [TOOLS.md](./TOOLS.md)（45 个工具分 9 类，含危险操作清单）。

## 审批门规则

| 操作 | 工具/参数 | 审批 |
|---|---|---|
| 删除仓库 | `github_delete_repository` | 🔒 |
| 删除文件 | `github_delete_file` | 🔒 |
| 删除分支 | `github_delete_branch` | 🔒 |
| force push | `github_push_files` + `force: true` | 🔒 |
| 合并 PR | `github_merge_pull_request` | 🔒 |
| 关闭 issue / 关闭 PR | `github_update_issue` / `github_update_pull_request` + `state: closed` | 🔒 |
| 其余读/写 | — | ✅ 直接放行 |

审批通过 `tools/pre-execute` → `ctx.approval` 实现（与 DSH 内置 `dsh-user-approval`
一致）：`allowed-once` 才放行，拒绝/取消/无审批通道一律 fail closed。
`config.approvalGate: false` 可关闭审批门（不推荐）。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `tokenRef` | `GITHUB_TOKEN` | PAT 凭据引用名（env / credentials 键名） |
| `oauthClientId` | — | GitHub OAuth App Client ID（Device Flow） |
| `oauthClientSecret` | — | Client Secret（直接内联，不推荐） |
| `oauthClientSecretRef` | `GITHUB_OAUTH_CLIENT_SECRET` | Client Secret 凭据引用（推荐） |
| `oauthScope` | `repo,read:org,user` | Device Flow 申请的 scope |
| `approvalGate` | `true` | 危险操作审批门开关 |
| `timeoutMs` | `30000` | GitHub 请求超时 |

## 开发与测试

```powershell
node tests/run-all.mjs    # 首次运行会自动从本机 DSH Desktop 的 app.asar 提取 dsh-tools
```

测试需要真实版本的 `@deepseek-ai/dsh-tools`（随 DSH Desktop 打包在 `resources/app.asar` 里）。
`tests/run-all.mjs` 会自动调用 `tests/asar-extract.mjs`，按依赖闭包把它提取到 `<repo>/.dsh-runtime/node_modules`（已 gitignore）；
如需指定其它运行时：

```powershell
$env:DSH_APP_ASAR = 'D:\DeepSeek Harness\resources\app.asar'   # 指定 app.asar
$env:DSH_RUNTIME_NODE_MODULES = 'D:\somewhere\node_modules'    # 或直接指定已解包的 node_modules（跳过提取）
node tests/run-all.mjs
```

测试覆盖：
- `validate-tools.mjs` — 45 个工具经 DSH 真实 dsh-tools 的 schema 编译/校验、render 健壮性
- `validate-apply.mjs` — apply() 生命周期 + 审批门行为（危险→ask、常规→放行）
- `approval-gate.mjs` — 危险操作分类单测
- `redaction.mjs` — 验收：token 不出现在日志/错误/工具输出
- `dns-fallback.mjs` — 单测 DNS 回退逻辑；带 `GITHUB_TOKEN` 时端到端打真实 GitHub API（无 token 自动跳过 E2E）
- `push-upload.mjs` — 内存版 GitHub API 上的多文件推送与一键上传流程（建仓→推送→开 PR）

## 架构

```
index.js                插件入口：apply() 注册审批门 + systemPrompt 引导 + 45 个工具
lib/client.js           GitHub REST 客户端（fetch、错误映射、token 脱敏）
lib/auth.js             PAT/credentials 解析 + OAuth Device Flow 状态机
lib/approval.js         危险操作分类 + tools/pre-execute 审批门
lib/push.js             共享推送实现（blob→tree→commit→ref）
lib/format.js           输出渲染 / presentCall 辅助
lib/tools/*.js          分域工具定义（auth/repos/issues/pulls/commits/search/releases/orgs/workflow）
```

## 许可

MIT
