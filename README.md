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

## OpenAI 兼容接口

- `GET /v1/models`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `WS /v1/responses`

服务保留 Responses 协议适配，包括 Codex 请求体规范化、Compact 请求处理，以及
非流式 Responses 的结果组装。客户端端到端请求头和 WebSocket 查询参数会继续
转发，服务只替换上游 `Authorization` 并设置活动账号对应的
`chatgpt-account-id`。计费和请求日志旁路观察上游响应。

## 管理接口

首次登录会根据 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 创建管理员。认证接口包括：

- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `GET /api/auth/session`

其余管理接口位于 `/api` 下，使用登录接口返回的 Access Token 作为 Bearer Token。

当前包含：

- OpenAI 账号管理
- API Key 管理
- 账号连通性测试

第一个账号默认成为活动账号，后续新增账号默认是 `inactive`；更新已有账号时
保持原状态。`POST /api/openai-accounts/:email/activate` 可以切换活动账号，
原活动账号会自动转为 `inactive`。任一时刻最多只有一个 `active` 账号。

服务不维护账号额度快照或冷却状态，也不会在限流或上游失败时切换账号；相关响应由当前活动账号的上游请求直接返回。

上游 User-Agent 和客户端版本通过 `OPENAI_API_USER_AGENT`、
`CODEX_CLIENT_VERSION` 环境变量配置。计费价格通过
`OPENAI_MODEL_PRICING_JSON` 提供。`GET /v1/models` 实时读取 Codex 上游的
`/backend-api/codex/models`，不依赖本地模型配置，也不维护模型刷新任务。
服务不限制用户 RPM 或并发数，也不执行可配置的上游请求重试。

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
