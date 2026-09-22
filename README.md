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
- `src/turn_state`：按上游登录托管 `x-codex-turn-state`，含探测与代理池
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

脚本改写 `~/.codex/config.toml` 的 `openai_base_url` / `chatgpt_base_url`，把
刷新 / 注销 URL 写进 `~/.codex/cocodex-gateway.env`，再把这个 env 文件挂进登录
shell 的 rc 文件（zsh 用 `$ZDOTDIR/.zshrc`，bash 用 `.bashrc`，macOS 上另外挂一份
到 `.bash_profile` 这类登录文件，fish 用 `config.fish`，其余回落 `.profile`）。
写完后若终端可交互且 `codex` 在 PATH 上，会直接进入设备码登录；`--no-login`
可以跳过。

脚本也能从仓库直接跑，此时网关地址是第一个参数：

```bash
./scripts/install.sh http://127.0.0.1:53141 --login
```

`GET /install.sh`、`GET /install.ps1` 填入的地址来自 `PUBLIC_GATEWAY_URL`；没配
时用请求的 Host 和 `X-Forwarded-Proto` 推导。

登录走网关自己的设备码 / OAuth，不把上游 ChatGPT 账号交给客户端：

- `POST /api/accounts/deviceauth/usercode`、`POST /api/accounts/deviceauth/token`
- `GET /oauth/authorize`、`POST /oauth/token`、`POST /oauth/revoke`
- 浏览器授权回调只允许 Codex 的本机地址 `http://localhost|127.0.0.1|[::1]:<端口>/auth/callback`

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
   直接返回与 chatgpt.com 相同的 451 `no_biscuit_no_service`，不转发上游——上游账号的 Connectors 不对用户开放
2. 校验 Codex token 与 Session、用户状态和美元额度
3. 找到管理员分配给用户的 ChatGPT 账号（按 `account_id`），未分配返回 403
4. 选该账号在此平台的登录（没有时用 `all` 登录），并换上该平台的真实 Codex User-Agent
5. 计费请求（Responses、Images）先检查上游周额度分摊，超出返回 429
6. 上游返回 401 时用 refresh token 刷新后重放一次；仍失败返回 502，避免客户端误以为自己的登录失效

WebSocket 的每一轮 `response.create` 都单独检查、单独结算。上游 access token 在过期
前两天由后台主动刷新。

### Turn state

上游在每轮 Responses 返回一个 `x-codex-turn-state`（Fernet token，有效期 1 小时），
Codex 客户端之后每轮都会带上它：HTTP 放在请求头，WebSocket 放在 `response.create`
的 `client_metadata` 里。这个 state 属于被服务的那个上游登录，不属于客户端——同一个
上游账号可能同时服务多个用户，用户的账号分配也可能变——所以网关接管它：

1. 按 (`account_id`, 平台, 模型) 缓存上游签发的 state，来源包括响应头、SSE /
   WebSocket 的 `codex.response.metadata` 事件
2. 只要是格式合法、仍在有效期内的 state 就收下，并且只有更新的才会替换已有的。
   `preferredBlocks` 是可选的偏好（默认留空）：填了之后探测会去找这个块数的 state，
   已持有的偏好 state 不会被其他形状顶掉，但找不到也不会让网关空手——实测 Pro 账号
   当前签发的是 11 块 / 312 字符，把某个块数当成唯一合法值会导致一个都收不下
3. 受管模型（默认只有 `gpt-6-astra`）的请求一律替换成网关持有的那份；网关没有时，
   客户端自带的 state 会被丢掉而不是发给别的账号（真实客户端在拿到 state 之前也不发这个头）
4. 不受管的模型完全不动，关掉开关后行为与以前一致

打开探测（probe）后，网关会为每个上游登录 × 受管模型持有一份 state（不必等真实流量先用到），
并在 state 到期前 5 分钟、或上游返回 429/5xx 之后，
用一个只发 `ping` 的最小 Responses 请求主动取一份新的 state，请求轮流从代理池的出口
发出（业务流量仍走网关自己的出口）。探测只维护有真实流量用到的 (账号, 平台, 模型)，
6 小时无人使用就连同缓存一起丢弃；账号额度耗尽（`usage_limit_reached`）默认退避 900 秒。
代理池支持 `http`、`https`、`socks4`、`socks4a`、`socks5`、`socks5h`，URL 里的 `{session}` 每次拨号会替换成
8 位随机十六进制（供按会话换 IP 的代理使用）。代理地址可以直接写 `url`，也可以用
`urlEnv` 放在环境变量里，或者用 `urlFile` 指向一个文件——**文件里每行一个代理**（`#`
开头和空行忽略，解析不了的行跳过），一个 `urlFile` 就是一整个代理池，每次探测重新读取，
换表不用重启。`scripts/fetch-proxy-pool.py` 可以按国家抓取公开代理生成这样的文件。

## 上游账号与额度

同一个 ChatGPT 账号通常在三个平台各登录一次（`openai_accounts` 三行，`account_id`
相同）。用户按 `account_id` 分配，最多 4 个用户（席位含未用邀请）。

每个用户最多使用该账号周额度的 25%：用户占用 = 上游周窗口 `used_percent` ×
该用户本周用量（美元）/ 全部用户本周用量。周窗口每 30 秒（`UPSTREAM_QUOTA_REFRESH_INTERVAL_MS`）
从 `/wham/usage` 同步一次。

## 计费与结算

费用按内置价格（美元 / 百万 Token，可用 `OPENAI_MODEL_PRICING_JSON` 按 slug 覆盖）
计算，`service_tier: "priority"` 对 GPT-6 Astra、GPT-5.6 系列、GPT-5.5 按 2.5 倍、
GPT-5.4 按 2 倍计费。只有 Responses 的标准 Token 计费并计入上游额度；Responses 中
图片工具的用量（`image_generation`）只记录不计费，Images、Search 与其他请求只记日志，
不扣费也不计入额度。

| 计费项 | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-6 Astra | $10 | $1 | $50 |
| GPT-5.6 Sol | $4 | $0.4 | $20 |
| Daybreak Blue | $4 | $0.4 | $20 |
| Daybreak Red | $12.5 | $1.25 | $75 |
| GPT-5.6 Terra | $2 | $0.2 | $12 |
| GPT-5.6 Luna | $0.2 | $0.02 | $1.2 |
| GPT-5.5 | $5 | $0.5 | $30 |
| GPT-5.4 | $2.5 | $0.25 | $15 |
| GPT-5.4 mini | $0.75 | $0.075 | $4.52 |
| GPT-Image-2 image tokens | $8 | $2 | $30 |
| GPT-Image-2 text tokens | $5 | $1.25 | $10 |

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
    `PUT /api/users/:id/{upstream,username,quota,password}`、`POST /api/users/:id/{enable,disable}`
  - 上游账号：`GET|POST /api/openai-accounts`、`GET|DELETE /api/openai-accounts/:email`、
    `POST /api/openai-accounts/:email/{disable,activate,test}`、`GET /api/openai-accounts/:email/usage`、
    `POST /api/openai-accounts/{bulk-remove,bulk-disable}`、
    `POST /api/openai-accounts/device-auth/{start,poll}`
  - Turn state：`GET|PUT /api/turn-state`、`POST /api/turn-state/refresh`、
    `POST /api/turn-state/clear`

`PUT /api/users/:id/upstream` 接受 `accountId`（ChatGPT account id），也兼容旧的
`sourceAccountId`（某一行登录的 id）；`null` 取消分配。上游 OAuth Token 只在后端
使用，不会出现在任何响应中。

`GET /api/turn-state` 返回 `{ settings, status }`：`status` 列出每个 (账号, 平台, 模型)
持有的 state 的块数、长度、签发/到期时间、下次刷新时间和最近一次探测结果，但不返回
state 本身；`settings` 里代理 URL 的密码会被替换成 `***`，原样写回即保留已存的密码。
`PUT` 只需要提交改动的字段（会与当前配置逐层合并），配置存在 `gateway_settings` 表：

```json
{
  "enabled": true,
  "models": ["gpt-6-astra"],
  "preferredBlocks": [],
  "injectExpired": false,
  "probe": {
    "enabled": false,
    "timeoutSeconds": 30,
    "retrySeconds": 60,
    "refreshBeforeSeconds": 300,
    "maxAttempts": 2,
    "quotaBackoffSeconds": 900,
    "maxHunts": 3,
    "allowDirect": false,
    "proxyPool": [{ "urlEnv": "COCODEX_TURN_STATE_PROXY_URL" }]
  }
}
```

`POST /api/turn-state/refresh` 排队一次提前探测，`POST /api/turn-state/clear` 清理缓存
（默认 `scope=expired` 只清过期的，`scope=all` 需要显式 `all=true`）；两者都可以用
`accountIds` / `models` / `platforms` 限定范围，不限定时必须传 `all=true`。

## Codex 版本

`CODEX_CLIENT_VERSION=auto`（默认）在后台查询 GitHub 最新稳定版（最多每 6 小时一次，
ETag 条件请求，失败至少 1 小时后重试，从不阻塞请求），首次查询完成前使用
`0.153.4`；也可填写具体版本号固定。`CODEX_GITHUB_TOKEN` 可选，只发给 GitHub。

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
