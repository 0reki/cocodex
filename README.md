# CoCodex Backend

CoCodex Backend 是一个独立的 Express 服务，用于管理 OpenAI 账号并提供 OpenAI 兼容接口。可以保存多个账号，每个用户必须由管理员分配一个上游账号；未分配时不能使用代理接口。

仓库不包含前端、Cloud Mail、Team 账号、第三方 OAuth、Addon、Inbox、翻译、上游代理池或音频转写功能。

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

启动开发服务：

```bash
pnpm dev
```

首次运行且尚未提供数据库与管理员配置时，后端进入初始化模式。打开前端
`/setup` 页面，填写 PostgreSQL 地址、管理员用户名和密码即可完成初始化。
JWT Secret 由后端自动生成；管理员密码只用于生成数据库中的密码哈希，不会写入
配置文件。生成的配置默认保存到 `./data/config.json`，也可通过以下变量修改位置：

```dotenv
COCODEX_CONFIG_PATH=/var/lib/cocodex/config.json
```

环境变量仍然可以覆盖 Setup 生成的配置，已有的纯环境变量部署无需迁移。
默认监听 `http://localhost:53141`，健康检查地址为 `GET /health`。

初始化接口：

- `GET /api/setup/status`
- `POST /api/setup/complete`

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
首次初始化、管理员与普通用户认证、用户启停、API Key 生命周期、账号管理与连通性、
模型列表、Responses SSE/WebSocket、Images、异步计费、请求日志筛选与游标分页以及
小时聚合；结束后会停止服务并删除该 schema 和临时配置，不依赖 OpenResty。
日常快速回归可设置 `E2E_SKIP_IMAGES=true`，排查失败时可设置
`E2E_KEEP_SCHEMA=true` 暂时保留测试数据。如果测试库已有可用账号，可设置
`E2E_SOURCE_FIXTURE_EMAIL`，脚本会只读获取该账号的 Account ID、ID Token、Access
Token 和 Refresh Token，避免重复填充测试凭据。

## OpenAI 兼容接口

- `GET /v1/models`
- `POST /v1/responses`
- `WS /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`

服务保留 Responses 协议适配，包括 Codex 请求体规范化。
`POST /v1/responses` 仅接受 `stream: true`，并以 SSE 形式透传上游事件；不提供
非流式结果组装。客户端端到端请求头和 WebSocket 查询参数会继续转发，服务只
替换上游 `Authorization` 并设置当前用户获分配账号对应的 `chatgpt-account-id`。计费和
请求日志旁路观察上游响应。

图像接口适配 Codex 客户端的 JSON 请求格式，并转发到订阅账号的 Codex Images
接口。图像生成与编辑使用非流式 JSON 响应；图片数据只向客户端透传，不写入日志。
图像请求体上限为 128 MiB，其他 JSON 请求体上限仍为 10 MiB。

## 管理接口

Setup 完成后可使用页面中创建的管理员登录。旧式纯环境变量部署仍会在首次登录时
根据 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员。认证接口包括：

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/invitations/:token`：公开校验注册链接
- `POST /api/auth/register`：通过邀请 Token 注册并登录

其余管理接口位于 `/api` 下，只接受登录接口返回的 Access Token 作为 Bearer Token。

当前包含：

- 用户管理：用户名、密码修改、启用/停用
- OpenAI 账号管理
- API Key 管理
- 账号连通性测试
- 上游账号用量与实时限额窗口

用户的 `role` 和 `balance` 暂时保留现有逻辑；用户资料不包含邮箱、头像、国家、
首次设置状态或币种字段。用户管理接口包括：

- `GET /api/users`
- `POST /api/users`
- `POST /api/user-invitations`：生成专属注册链接
- `GET /api/my-usage`：查询当前用户的标准与 Spark 独立额度
- `PUT /api/users/:id/upstream`：分配或取消用户的上游账号
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
原活动账号会自动转为 `inactive`。任一时刻最多只有一个 `active` 账号；该状态不覆盖
用户与上游账号的分配关系。
控制台默认通过 Codex 设备码登录添加账号：

- `POST /api/openai-accounts/device-auth/start`：申请一次性设备码
- `POST /api/openai-accounts/device-auth/poll`：查询授权结果并在成功后自动写入账号

OAuth Token 仅由后端向 OpenAI 交换，不会返回浏览器。设备码登录需要先在个人
ChatGPT 安全设置或工作区权限中启用。原 `POST /api/openai-accounts` 手工写入接口
仅作为兼容方式保留，要求同时提供 `email`、`accountId`、`idToken`、
`accessToken` 和 `refreshToken`。账号列表、详情及写入响应均不返回任何 Token。
批量移除和批量禁用接口继续保留：

- `POST /api/openai-accounts/bulk-remove`
- `POST /api/openai-accounts/bulk-disable`

`GET /api/openai-accounts/:email/usage` 实时读取当前限额窗口和逐日用量，按
`25 credits = $1` 返回美元金额。由于 credits 明细存在延迟，该接口不再反推周额度，
`weeklyEstimate.available` 固定为 `false`，实时限额百分比与重置时间仍原样返回。

标准与 Spark 使用独立额度池。Images 请求保留日志，但不扣费且不计入额度。
服务不会在限流或上游失败时切换账号，相关响应由用户被分配的上游账号直接返回。
服务不对限流、网络错误或其他上游失败重试。仅当同一分配账号收到上游 `401` 时，
使用保存的 OAuth Refresh Token 刷新认证并重放一次原请求；不会切换账号。
API Key、用户余额、上游分配和额度窗口会在进程开始监听前载入内存；通过管理接口
修改后会同步刷新相应状态。`/v1/responses` 的 HTTP 与 WebSocket 准入只读取内存，
不会查询 PostgreSQL。绕过管理接口直接修改数据库后，需要重启服务以重新载入状态。
单机部署中的并发 Token 刷新共享同一个刷新任务。

请求日志不保存 Prompt、模型输出、上游账号信息或完整 `usage.attribution`，仅保存
请求状态、耗时、最小 Token 汇总、费用、错误码与错误消息。

API Key 更新、撤销或用户停用会同步更新本进程状态。请求日志、Key 用量、用户余额
和上游额度用量均在响应后异步结算，不阻塞 HTTP 响应或 WebSocket 下一轮请求。
普通请求结算默认累计 200 条或等待 1 秒后批量落库，结算 ID 保证日志、Key 用量、
用户余额只结算一次。进程异常退出时，尚未刷新的内存批次可能丢失；正常收到
`SIGTERM`/`SIGINT` 时会停止接收新连接并刷新剩余批次。
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
| GPT-6 Astra | $10 | $1 | $50 |
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

Responses terminal event 会先写入并同步本地 WAL，再下发客户端和异步批量提交
PostgreSQL。WAL 默认与 `COCODEX_CONFIG_PATH` 位于同一目录，也可通过
`RESPONSE_SETTLEMENT_WAL_PATH` 覆盖；Docker 示例将其放在持久化的 `/data` 卷中。
进程启动时会自动重放未确认记录，达到
`RESPONSE_SETTLEMENT_WAL_COMPACT_AFTER_RECORDS` 后自动压缩。

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
