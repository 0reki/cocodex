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

```bash
./scripts/install-codex-gateway.sh http://<网关>:53141 --login
```

Windows：`./scripts/install-codex-gateway.ps1 http://<网关>:53141 -Login`

登录走网关自己的设备码 / OAuth，不把上游 ChatGPT 账号交给客户端：

- `POST /api/accounts/deviceauth/usercode`、`POST /api/accounts/deviceauth/token`
- `GET /oauth/authorize`、`POST /oauth/token`、`POST /oauth/revoke`
- 浏览器授权回调只允许 Codex 的本机地址 `http://localhost|127.0.0.1|[::1]:<端口>/auth/callback`

下发的 access token 绑定一个 Session，只有该 Session 仍有未过期的 refresh token
时才有效；refresh token 每次刷新都轮换，`/oauth/revoke` 或修改用户密码会让对应
Session 立即失效。

## 网关

Codex 的三种 base URL 写法都可以：`/backend-api/*`、`/api/codex/*`、`/v1/*`，
另支持 `WS /backend-api/codex/responses`。每个请求：

1. 按 `X-Cocodex-Platform` 或 User-Agent 识别客户端系统（windows / linux / darwin），识别不出拒绝
2. 校验 Codex token 与 Session、用户状态和美元额度
3. 找到管理员分配给用户的 ChatGPT 账号（按 `account_id`），未分配返回 403
4. 选该账号在此平台的登录（没有时用 `all` 登录），并换上该平台的真实 Codex User-Agent
5. 计费请求（Responses、Images）先检查上游周额度分摊，超出返回 429
6. 上游返回 401 时用 refresh token 刷新后重放一次；仍失败返回 502，避免客户端误以为自己的登录失效

WebSocket 的每一轮 `response.create` 都单独检查、单独结算。上游 access token 在过期
前两天由后台主动刷新。

## 上游账号与额度

同一个 ChatGPT 账号通常在三个平台各登录一次（`openai_accounts` 三行，`account_id`
相同）。用户按 `account_id` 分配，最多 4 个用户（席位含未用邀请）。

每个用户最多使用该账号周额度的 25%：用户占用 = 上游周窗口 `used_percent` ×
该用户本周用量（美元）/ 全部用户本周用量。周窗口每 30 秒（`UPSTREAM_QUOTA_REFRESH_INTERVAL_MS`）
从 `/wham/usage` 同步一次。

## 计费与结算

费用按内置价格（美元 / 百万 Token，可用 `OPENAI_MODEL_PRICING_JSON` 按 slug 覆盖）
计算，`service_tier: "priority"` 对 GPT-6 Astra、GPT-5.6 系列、GPT-5.5 按 2.5 倍、
GPT-5.4 按 2 倍计费；Images 和图片工具按 GPT-Image-2 的 text / image Token 计费。
Search 与其他请求只记日志不计费。

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

`PUT /api/users/:id/upstream` 接受 `accountId`（ChatGPT account id），也兼容旧的
`sourceAccountId`（某一行登录的 id）；`null` 取消分配。上游 OAuth Token 只在后端
使用，不会出现在任何响应中。

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
