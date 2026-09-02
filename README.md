# CoCodex Backend

CoCodex Backend 是一个独立的 Express 服务，用于管理 OpenAI 账号并提供 OpenAI 兼容接口。可以保存多个账号，但所有代理请求只使用当前活动账号，不进行轮转或自动故障转移。

仓库不包含前端、Cloud Mail、Team 账号、第三方 OAuth、Addon、Inbox、翻译、Signup、上游代理池或音频转写功能。

## 模块

- `src/server`：Express 路由、鉴权、计费校验、账号选择和请求编排
- `src/database`：PostgreSQL 数据访问和初始化 Schema
- `src/openai-api`：OpenAI/Codex 上游协议与流式传输
- `sql`：全新部署使用的数据库 Schema

## 本地运行

安装依赖：

```bash
pnpm install
```

创建环境变量文件：

```bash
cp .env.example .env
```

至少需要配置：

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/cocodex
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
ADMIN_JWT_SECRET=replace-with-a-random-secret
```

启动开发服务：

```bash
pnpm dev
```

默认监听 `http://localhost:53141`，健康检查地址为 `GET /health`。

## 端到端测试

创建仅供本机使用的 E2E 配置：

```bash
cp .env.e2e.example .env.e2e
```

填写测试 PostgreSQL 和上游账号的完整 Token 后运行：

```bash
pnpm e2e
```

脚本会为每次执行创建独立 PostgreSQL schema，启动本地 Express 服务，并依次验证
管理登录、账号新增与连通性、API Key、模型列表、Responses SSE/WebSocket、Images、
异步计费、请求日志和小时聚合；结束后会停止服务并删除该 schema，不依赖
OpenResty。日常快速回归可设置 `E2E_SKIP_IMAGES=true`，排查失败时可设置
`E2E_KEEP_SCHEMA=true` 暂时保留测试数据。如果测试库已有可用账号，可设置
`E2E_SOURCE_FIXTURE_EMAIL`，脚本会只读获取该账号的 Account ID、Access Token 和
Refresh Token，避免重复填充测试凭据。

## OpenAI 兼容接口

- `GET /v1/models`
- `POST /v1/responses`
- `WS /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

服务保留 Responses 协议适配，包括 Codex 请求体规范化。
`POST /v1/responses` 仅接受 `stream: true`，并以 SSE 形式透传上游事件；不提供
非流式结果组装。客户端端到端请求头和 WebSocket 查询参数会继续转发，服务只
替换上游 `Authorization` 并设置活动账号对应的 `chatgpt-account-id`。计费和
请求日志旁路观察上游响应。

图像接口适配 Codex 客户端的 JSON 请求格式，并转发到订阅账号的 Codex Images
接口。图像生成与编辑使用非流式 JSON 响应；图片数据只向客户端透传，不写入日志。
图像请求体上限为 128 MiB，其他 JSON 请求体上限仍为 10 MiB。

## 管理接口

首次登录会根据 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员。认证接口包括：

- `POST /api/auth/login`
- `POST /api/auth/refresh`

其余管理接口位于 `/api` 下，只接受登录接口返回的 Access Token 作为 Bearer Token。

当前包含：

- 用户管理：用户名、密码修改、启用/停用
- OpenAI 账号管理
- API Key 管理
- 账号连通性测试
- 上游账号用量与周额度估算

用户的 `role` 和 `balance` 暂时保留现有逻辑；用户资料不包含邮箱、头像、国家、
首次设置状态或币种字段。用户管理接口包括：

- `GET /api/users`
- `POST /api/users`
- `PUT /api/users/:id/username`
- `PUT /api/users/:id/password`
- `POST /api/users/:id/enable`
- `POST /api/users/:id/disable`

停用用户后，该用户的管理 Access Token 和名下 API Key 都会立即拒绝鉴权。

请求日志提供以下只读接口：

- `GET /api/request-logs`：游标分页查询明细，支持 `limit`、`cursor`、`keyId`、
  `modelId`、`status`、`date`、`dateFrom` 和 `dateTo`
- `GET /api/request-logs/hourly`：查询小时聚合，支持 `lookbackHours` 和
  `maxModels`

管理员查询全部数据，普通用户只能查询自己 API Key 对应的数据。响应中的
`nextCursor` 用于读取下一页，不执行全表 `COUNT` 或深分页 `OFFSET`。日志、扣费
和小时聚合由内存批次通过一条 PostgreSQL 原子语句写入，HTTP 接口只读取数据。

第一个账号默认成为活动账号，后续新增账号默认是 `inactive`；更新已有账号时
保持原状态。`POST /api/openai-accounts/:email/activate` 可以切换活动账号，
原活动账号会自动转为 `inactive`。任一时刻最多只有一个 `active` 账号。
账号写入接口要求同时提供 `email`、`accountId`、`idToken`、`accessToken` 和
`refreshToken`。账号列表、详情及写入响应均不返回任何 Token。
批量移除和批量禁用接口继续保留：

- `POST /api/openai-accounts/bulk-remove`
- `POST /api/openai-accounts/bulk-disable`

`GET /api/openai-accounts/:email/usage` 实时读取当前限额窗口和逐日用量，按
`25 credits = $1` 返回美元金额。对于 7 天窗口，接口会给出近似周额度：同一进程、
同一窗口已有旧快照且百分比上升时使用用量与百分比差值估算，否则使用当前窗口累计
用量与百分比估算。百分比为 0、逐日用量为 0 或上游未返回 7 天窗口时只返回原始
用量状态，不伪造周额度。该查询按需执行，不启动后台轮询，也不保存上游身份字段。

服务不维护持久化账号额度快照或冷却状态；周额度估算仅在进程内保留最多 100 个账号
的临时对比快照。服务不会在限流或上游失败时切换账号，相关响应由当前活动账号的
上游请求直接返回。
服务不对限流、网络错误或其他上游失败重试。仅当同一活动账号收到上游 `401` 时，
使用保存的 OAuth Refresh Token 刷新认证并重放一次原请求；不会切换账号。
活动账号默认在进程内缓存 30 秒，账号新增、更新、激活、停用、删除及连通性测试后
会立即失效缓存。单机部署中的并发 Token 刷新共享同一个刷新任务。

请求日志不保存 Prompt、模型输出、上游账号信息或完整 `usage.attribution`，仅保存
请求状态、耗时、最小 Token 汇总、费用、错误码与错误消息。

API Key 首次鉴权时从 PostgreSQL 读取，随后进入进程内 LRU；Key 更新、撤销或用户
停用会同步失效本进程缓存。请求结算默认累计 200 条或等待 1 秒后批量落库，结算
ID 保证日志、Key 用量、用户余额只结算一次。进程异常退出时，尚未刷新的内存批次
可能丢失；正常收到 `SIGTERM`/`SIGINT` 时会停止接收新连接并刷新剩余批次。
结算队列默认最多保留 20000 条在途或待写记录，达到上限后会在请求进入上游前拒绝
新请求；数据库写入失败时最多退避 5 秒。余额以美元计费，默认允许软透支至
`-$10`，每个在途请求先预留 `$1`，完成后再按实际费用校正。并发中的请求可能让
最终余额略低于软透支线，但不会在达到软透支线后继续接收新请求。
费用计算、在途预留和待结算累计使用与 PostgreSQL `NUMERIC(20,8)` 一致的 8 位
美元定点整数，只有管理查询输出 JSON 时才转换为普通美元数值。
PostgreSQL 默认连接超时 5 秒、锁等待超时 5 秒、语句超时 15 秒、客户端查询超时
20 秒；结算超时后数据保留在内存队列并按退避策略重试。

SSE 在下游写缓冲区满时暂停读取上游；WebSocket 在目标连接出现待发送数据时暂停
对应来源连接，待发送完成后继续读取。两者都只传播传输层背压，不增加限流、丢包
或代理自定义的断开阈值。

上游 User-Agent 和客户端版本通过 `OPENAI_API_USER_AGENT`、
`CODEX_CLIENT_VERSION` 环境变量配置。内置价格已按 `25 credits = $1` 换算为
美元/百万 Token：

| 计费项 | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-5.6 Sol | $4 | $0.4 | $20 |
| Daybreak Blue | $4 | $0.4 | $20 |
| Daybreak Red | $12.5 | $1.25 | $75 |
| GPT-5.6 Terra | $2 | $0.2 | $12 |
| GPT-5.6 Luna | $0.2 | $0.02 | $1.2 |
| GPT-5.5 | $5 | $0.5 | $30 |
| GPT-5.4 | $2.5 | $0.25 | $15 |
| GPT-5.4 mini | $0.75 | $0.075 | $4.52 |
| GPT-5.3-Codex-Spark research preview | $0 | $0 | $0 |
| GPT-Image-2 image tokens | $8 | $2 | $30 |
| GPT-Image-2 text tokens | $5 | $1.25 | $10 |

`OPENAI_MODEL_PRICING_JSON` 可按 `slug` 覆盖或补充内置美元价格。Daybreak 价格按
请求中的 `access_programs.cyber` 选择；GPT-Image-2 按 usage 中的 text/image
Token 分类结算。`GET /v1/models` 实时读取 Codex 上游的
`/backend-api/codex/models`，不依赖本地模型配置，也不维护模型刷新任务。
服务不限制用户 RPM 或并发数。

## Docker

```bash
cp .env.docker.example .env.docker
pnpm docker:up
```

Compose 只启动 PostgreSQL 和 Express 后端：

- Backend：`http://localhost:53141`
- PostgreSQL：`localhost:5432`

停止：

```bash
pnpm docker:down
```

## 常用命令

```bash
pnpm typecheck
pnpm build
```

## License

MIT License
