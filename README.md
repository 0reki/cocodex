# CoCodex

CoCodex 是一个 Rust 单进程服务：既是 Codex 客户端的伪订阅网关，也是 Web 控制台的
后端 API。Codex 客户端把 ChatGPT / Codex 的 base URL 指到本网关后，按订阅协议访问
`/backend-api/*`；网关校验用户身份，换成该用户被分配的上游 ChatGPT 账号的凭证，
再转发到 `https://chatgpt.com`。

仓库不包含前端。

## 代码结构

`crates/proxy`（二进制名 `cocodex`）：

- `src/auth`：Codex 客户端登录（设备码 / 浏览器 OAuth、Session、JWT）、控制台 Token、密码
- `src/api`：控制台管理接口（Setup、登录、用户、上游账号、请求日志）
- `src/forwarder.rs`、`src/websocket.rs`、`src/interceptor`：网关转发、鉴权与计量
- `src/upstream`：OpenAI 侧调用（Token 刷新、设备码登录、用量）与客户端身份
- `src/billing`、`src/quota.rs`：计价、结算队列（WAL）与上游周额度分摊
- `src/db`：PostgreSQL 访问；Schema 在仓库根目录 `sql/init.sql`

## 本地运行

```bash
cp .env.example .env
cargo run --manifest-path crates/proxy/Cargo.toml
```

默认监听 `http://localhost:53141`（`PORT`），健康检查为 `GET /health`。

首次运行且未提供数据库与 Secret 时进入初始化模式：打开前端 `/setup` 页面填写
PostgreSQL 地址和管理员账号即可。Secret 自动生成，与数据库地址一起写入
`./data/config.json`（`COCODEX_CONFIG_PATH`，权限 0600）；管理员密码只以哈希形式
写入数据库。写入后网关自动连接数据库，无需重启。环境变量优先于配置文件，纯环境
变量部署无需迁移。初始化期间依赖数据库的接口返回 `503 setup_required`。

启动时执行 `sql/init.sql`（幂等）；只有文件内容变化时才会重新执行，避免每次重启都
对在线的表加排他锁。

## Codex 客户端接入

网关自己提供安装脚本，脚本里的网关地址由服务端填好，用户不用传参：

```bash
curl -fsSL https://api.cocodex.app/install.sh | sh
```

Windows：`irm https://api.cocodex.app/install.ps1 | iex`

脚本改写 `~/.codex/config.toml` 的 `openai_base_url` / `chatgpt_base_url`，并关闭
Codex 自带的遥测（`[analytics]`、`[feedback]` 的 `enabled = false`，`[otel]` 各导出器为
`"none"`、`log_user_prompt = false`；已有的这三个表连同子表整段替换），再设置
三个 Codex 只从环境变量读的登录地址：`CODEX_APP_SERVER_LOGIN_ISSUER`（= 网关地址）、
`CODEX_REFRESH_TOKEN_URL_OVERRIDE`、`CODEX_REVOKE_TOKEN_URL_OVERRIDE`。

安装脚本还会设置 `[features]` 下的 `apps = false` 和 `daemon_auto_start = false`，
保留其它功能开关。内置 Apps / Connectors 不能用网关 Token 登录；CLI 默认使用内嵌
app-server，避免新版默认自动安装、启动共享后台 daemon。用户自己配置的 MCP 服务仍可使用。

- macOS / Linux：写进 `~/.codex/cocodex-gateway.env`，挂进登录 shell 的 rc 文件（zsh 用
  `$ZDOTDIR/.zshrc`，bash 用 `.bashrc`，macOS 上另外挂一份到 `.bash_profile` 这类登录
  文件，fish 用 `config.fish`，其余回落 `.profile`）。桌面应用不读 rc，所以 macOS 另外
  `launchctl setenv` 并装一个 LaunchAgent（`~/Library/LaunchAgents/app.cocodex.gateway-env.plist`）
  在每次登录时重设；Linux 写 `~/.config/environment.d/cocodex-gateway.conf`。
- Windows：写成用户级环境变量（`HKCU\Environment`），从开始菜单启动的桌面端也能继承；
  旧版脚本写在 PowerShell profile 里的块会被清掉。

设置好后，Codex 桌面端 / IDE 插件完全退出再打开，点 “Sign in with ChatGPT” 即走网关的
浏览器授权码登录（`/oauth/authorize` → 控制台确认 → 回调 `localhost:1455`），不需要设备码。
CLI 的 `codex login` 浏览器模式不认自定义 issuer，所以 CLI 仍走设备码：写完后若终端
可交互且 `codex` 在 PATH 上，会直接进入 `codex login --device-auth`；`--no-login` 可以跳过。

脚本也能从仓库直接跑，此时网关地址是第一个参数：

```bash
./scripts/install.sh http://127.0.0.1:53141 --login
```

`GET /install.sh`、`GET /install.ps1` 填入的地址来自 `PUBLIC_GATEWAY_URL`；没配
时用请求的 Host 和 `X-Forwarded-Proto` 推导。

登录走网关自己的设备码 / OAuth，不把上游 ChatGPT 账号交给客户端：

- `POST /api/accounts/deviceauth/usercode`、`POST /api/accounts/deviceauth/token`
- `GET /oauth/authorize`、`POST /oauth/token`、`POST /oauth/revoke`
- 浏览器授权回调只允许 Codex 的本机地址 `http://localhost|127.0.0.1|[::1]:<端口>/auth/callback`；
  `/oauth/authorize` 对其它 `redirect_uri` 直接 400，不跳转；缺 PKCE（`code_challenge` +
  `S256`）或 `response_type` 不是 `code` 时按 OAuth 规范带 `error` 跳回回调地址。未知参数原样
  透传给控制台确认页
- `/oauth/token` 支持 `authorization_code`（校验 PKCE）和 `refresh_token`；Codex 登录后顺带
  发的 API key token-exchange 返回 `unsupported_grant_type`，客户端会忽略
- `/oauth/revoke` 接受 JSON（Codex）和表单（RFC 7009）

下发的 access token 绑定一个 Session，只有该 Session 仍有未过期的 refresh token
时才有效；refresh token 每次刷新都轮换，`/oauth/revoke` 或修改用户密码会让对应
Session 立即失效。

## 网关

Codex 的两种 base URL 写法都可以：`/backend-api/*`、`/api/codex/*`，
另支持 `WS /backend-api/codex/responses`。每个请求：

1. 按 User-Agent 识别客户端系统（windows / linux / darwin），识别不出拒绝；macOS
   客户端由该账号的 Linux 登录服务，对上游呈现为 Linux 机器；
   完全不带 User-Agent 的请求（如 `/accounts/verified_access`）与设备无关，使用该账号任一平台的登录。
   不带 `Authorization` 的 `/ps/mcp` 及其子路径（Codex 只把 ChatGPT token 发给 chatgpt.com，
   对网关会把 `codex_apps` 当成 OAuth MCP：先探测 `.well-known` 元数据再无凭证建会话）由网关
   直接返回与 chatgpt.com 相同的 451 `no_biscuit_no_service`，不转发上游——上游账号的 Connectors 不对用户开放。
   这会让对应 MCP 连接失败；安装脚本通过关闭内置 Apps 消除这类请求
2. 校验 Codex token 与 Session、用户状态
3. 找到管理员分配给用户的 ChatGPT 账号（按 `account_id`），未分配返回 403
4. 选该账号在此平台的登录（没有时用 `all` 登录），并换上该平台的真实 Codex User-Agent
5. 计费请求（Responses、Images）先检查上游周额度分摊，超出返回 429
6. 上游返回 401 时用 refresh token 刷新后重放一次；仍失败返回 502，避免客户端误以为自己的登录失效

WebSocket 的每一轮 `response.create` 都单独检查、单独结算。上游 access token 在过期
前两天由后台主动刷新。

### Turn state

上游在每轮 Responses 返回一个 `x-codex-turn-state`，Codex 客户端之后每轮都会带上它
（HTTP 放在请求头，WebSocket 放在 `response.create` 的 `client_metadata` 里）。网关原样
转发，不做替换；请求日志记录每个响应带回的 state 长度（`turnStateLen`）。

## 上游账号与额度

同一个 ChatGPT 账号通常在三个平台各登录一次（`openai_accounts` 三行，`account_id`
相同）。用户按 `account_id` 分配，最多 4 个用户（席位含未用邀请）。

每个用户最多使用该账号周额度的 25%：用户占用 = 上游周窗口 `used_percent` ×
该用户本周用量（美元）/ 全部用户本周用量。周窗口每 30 秒（`UPSTREAM_QUOTA_REFRESH_INTERVAL_MS`）
从 `/wham/usage` 同步一次。

## 计费与结算

网关不额外限制 HTTP 请求体或客户端发来的 WebSocket 消息 / 帧大小，控制台和登录接口
也不设置请求体大小上限。反向代理需相应设置 `client_max_body_size 0;`。
从上游接收的 WebSocket 响应沿用 Codex 客户端默认限制：单条消息 64 MiB、单帧 16 MiB；
上游服务和模型自身的限制仍由上游决定。

费用按内置价格（美元 / 百万 Token，可用 `OPENAI_MODEL_PRICING_JSON` 按 slug 覆盖）
计算，`service_tier: "priority"` 对 GPT-6 系列、GPT-5.6 系列、GPT-5.5 按 2.5 倍、
GPT-5.4 按 2 倍计费。只有 Responses 的标准 Token 计费并计入上游额度；Responses 中
图片工具的用量（`image_generation`）只记录不计费，Images、Search 与其他请求只记日志，
不扣费也不计入额度。

| 计费项 | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-6 Astra | $10 | $1 | $50 |
| GPT-6 Sol | $2 | $0.2 | $10 |
| GPT-6.1 Terra | $1 | $0.05 | $5 |
| GPT-6 Luna | $0.1 | $0.01 | $0.5 |
| GPT-5.6 Sol | $4 | $0.4 | $20 |
| Daybreak Blue | $4 | $0.4 | $20 |
| Daybreak Red | $12.5 | $1.25 | $75 |
| GPT-5.6 Terra | $2 | $0.2 | $12 |
| GPT-5.6 Luna | $0.2 | $0.02 | $1.2 |
| GPT-Rosalind-Research | $5 | $0.5 | $25 |
| GPT-5.5 | $5 | $0.5 | $30 |
| GPT-5.4 | $2.5 | $0.25 | $15 |
| GPT-5.4 mini | $0.75 | $0.075 | $4.52 |
| GPT-Image-2 image tokens | $8 | $2 | $30 |
| GPT-Image-2 text tokens | $5 | $1.25 | $10 |

GPT-6.1 Terra 的 Standard 价格按[官方订阅积分价目表](https://learn.chatgpt.com/docs/pricing#token-rates)
每百万 Token 的输入 25、缓存输入 1.25、输出 125 credits，以项目现有的
$0.04 / credit 折算；订阅额度 Fast 模式按 2.5 倍计费，缓存写入不单独收费。

每个响应先写入并 fsync 本地 WAL（默认与配置文件同目录，`RESPONSE_SETTLEMENT_WAL_PATH`
可覆盖），再按批（默认 200 条或 1 秒）用一条 SQL 原子写入日志、用户花费和按用户的
小时汇总；失败指数退避重试。启动时重放未确认记录（兼容旧 Node 版写下的 WAL），
收到 `SIGTERM` / `SIGINT` 时停止接收连接并写完剩余记录。

## 控制台接口

公开：`GET /health`、`GET /api/setup/status`、`POST /api/setup/complete`、
`POST /api/auth/login|refresh|logout|register`、`GET /api/auth/invitations/:token`。

其余接口需要登录返回的 access token（Bearer）：

- 所有用户：`GET /api/my-usage`、`GET /api/request-logs`、`GET /api/request-logs/hourly`
  （普通用户只能看到自己的数据）
- 管理员：
  - 用户：`GET|POST /api/users`、`POST /api/user-invitations`、
    `PUT /api/users/:id/{upstream,username,password}`、`POST /api/users/:id/{enable,disable}`
  - 上游账号：`GET|POST /api/openai-accounts`、`GET|DELETE /api/openai-accounts/:email`、
    `POST /api/openai-accounts/:email/{disable,activate,test}`、`GET /api/openai-accounts/:email/usage`、
    `POST /api/openai-accounts/{bulk-remove,bulk-disable}`、
    `POST /api/openai-accounts/device-auth/{start,poll}`

`PUT /api/users/:id/upstream` 接受 `accountId`（ChatGPT account id），也兼容旧的
`sourceAccountId`（某一行登录的 id）；`null` 取消分配。上游 OAuth Token 只在后端
使用，不会出现在任何响应中。

## Codex 版本

`CODEX_CLIENT_VERSION=auto`（默认）在后台查询 GitHub 最新稳定版（最多每 6 小时一次，
ETag 条件请求，失败至少 1 小时后重试，从不阻塞请求），首次查询完成前使用
`0.167.0`；也可填写具体版本号固定。`CODEX_GITHUB_TOKEN` 可选，只发给 GitHub。

2026-11-09 核对上游源码：`main` 为 `ffdf2daddb`，最新稳定版 tag 为 `rust-v0.167.0`。
本地 `codex/` 从原有的 `b1e72963c3`（2026-09-29）更新到该 main；该目录不纳入本网关的 Git。

| 新版相关变化 | 网关处理与剩余范围 |
| --- | --- |
| `daemon_auto_start` 默认开启，CLI 可连接独立安装的共享 app-server | 安装脚本关闭自动启动；后台服务的安装、更新、启动时环境和 socket 状态由 Codex 管理。关闭自动启动不会停止已运行的 daemon，也不阻止发现现有 daemon |
| 内置 Apps 默认启用，经 `/ps/mcp` 发现 Connectors / 托管插件工具 | 安装脚本关闭 `apps`；上游账号的 Connectors 与托管插件工具未提供用户隔离，保持不可用 |
| 远程控制通过 `/wham/remote/control/server/*` 注册、刷新、配对，另有环境客户端接口 | 整个 `/wham/remote/control` 子树及 `/api/codex` 别名返回 403，沿用旧 executor 注册接口的拦截策略 |
| Terra、Responses Lite、增量工具及新的 turn metadata | Terra 已有计价；Lite 仍使用 Responses 路径及请求头 / metadata，现有转发保留这些字段，未增加路径白名单 |
| 语音与 realtime sideband | 已有 `/v1/live`、`/v1/realtime` 路由及 `experimental_realtime_ws_base_url`，本次未发现需要新增的路径；未实测音视频通话 |
| OAuth 登录来源持久化与刷新协调 | 现有 issuer / refresh / revoke 覆盖仍存在；新 provider 向导是另一套接入方式，当前安装脚本仍用原有登录流程 |
| Codex Cloud tasks / environments 等账号级资源 | 现有通用转发可到达，尚无类似 ChatGPT 对话 / 项目的用户归属隔离，不能据此视为已支持共享账号下的云端资源 |

若启动时出现 `Managed app-server stderr ... HTTP 451 no_biscuit_no_service`，随后报
`app-server-control.sock: No such file or directory`，需要分开判断：451 是 MCP 连接被拒；
最终失败表示 CLI 未连接到本地 daemon。stderr 摘要可以包含此前多次启动留下的日志，
不能据此认定 451 导致 daemon 退出。
0.167.0 若检测到 daemon PID 仍有效，即使控制 socket 不可用，也会走等待就绪分支；
因此“已有实例运行”与新 CLI 报 socket 缺失并不矛盾。普通 CLI 进程或使用另一个
`CODEX_HOME` 的 app-server 也不能说明当前路径上的 daemon 可连接。

本地使用官方 0.167.0 包和隔离 `CODEX_HOME` 实测：健康 daemon 的第二次 start 返回
`alreadyRunning`；模拟 `/ps/mcp` 返回上述 451 后，daemon 仍可接受新连接。仅在手动
删除测试实例的 socket 后，才重现“stderr 尾部带 451，最终 socket 缺失”的错误，同时
原有连接仍能调用 `thread/list`。这验证了进程存活、旧连接正常、新连接失败可以同时
发生。问题机器随后确认整个 `/tmp/codex-daemon-0` 目录丢失，daemon 与终端处于同一
挂载命名空间，重启 app-server 后恢复；目录丢失的来源尚未确定。关闭 Apps 或绕过
daemon 不等于修复 socket 丢失的根因。

Unix 上该路径是符号链接，真正的监听 socket 固定放在 `/tmp/codex-daemon-<uid>/<hash>`；
设置 `TMPDIR` 不会改变其位置。保留符号链接、仅删除测试实例的实际 socket 也能复现
相同错误。遇到这种情况，检查 `ls -lL` 是否能解析链接目标，并比较 daemon 的
`/proc/<pid>/root/tmp/codex-daemon-<uid>` 与当前终端的 `/tmp` 视图，区分文件被删除和
挂载命名空间差异。updater 的 `daemon_not_ready` 表示探测失败，不是自动修复成功。

可先保留原命令及参数，加上 `--no-daemon --disable apps` 启动，例如：

```bash
codex --no-daemon --disable apps
codex resume --last --no-daemon --disable apps
```

升级网关并重新运行安装脚本后会写入上述两个功能开关。若要继续使用共享 daemon，
先用 `codex app-server daemon version` 核对 CLI 与后台版本，再检查
`$CODEX_HOME/app-server-daemon/daemon.stderr.log`（默认 `~/.codex`）与 socket 目录状态；
通过 `codex app-server daemon restart` 重启会影响连接它的会话，应在当前任务结束后进行。

## Docker

```bash
cp .env.docker.example .env.docker
docker compose --env-file .env.docker up --build
```

Compose 启动 PostgreSQL 和 CoCodex（`http://localhost:53141`），配置和 WAL 在
`/data` 卷中。

## 开发

```bash
cd crates/proxy
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

集成测试需要 PostgreSQL：默认连接 `postgres://postgres:postgres@127.0.0.1:55432/cocodex_test`，
可用 `TEST_DATABASE_URL` 覆盖；每个测试使用独立 schema。

## License

MIT License
