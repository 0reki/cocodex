<div align="center">
  <img src="./public/codex-shell-logo.svg" width="64" alt="CoCodex" />
  <h1>CoCodex Web</h1>
  <p>轻量、直接的 CoCodex 管理控制台。</p>
</div>

## 技术栈

这是一个独立前端项目，不包含后端代码或 monorepo 工具：

- React 19
- React Router 8（Data Mode，页面级懒加载）
- Vite 8
- Tailwind CSS 4
- 按需引入的 Radix UI primitives
- Recharts（仅仪表盘懒加载）
- TypeScript
- pnpm

没有 Next.js、Turbo、monorepo 工具、全局状态管理库、motion 或 Shiki。生产输出是纯静态资源；内置的 Node 静态服务器负责 SPA fallback，并将管理接口与 HTTP OpenAI 接口反向代理到 CoCodex 后端。

## 本地开发

```bash
pnpm install
cp .env.example .env
pnpm dev
```

默认地址为 `http://localhost:53332`。Vite 会将 `/api` 和 `/v1` 转发到 `http://localhost:53141`。
后端尚未初始化时，任意页面都会自动进入 `/setup`，用于连接 PostgreSQL 并创建首个管理员。

环境变量：

- `VITE_API_PROXY_TARGET`：开发服务器的 `/api`、`/v1` 代理目标。
- `VITE_API_BASE_URL`：管理 API 基址；同源部署时留空。
- `API_PROXY_TARGET`：生产静态服务器的 `/api`、`/v1`、`/health` 代理目标。
- `WEB_HOST` / `WEB_PORT`：生产静态服务器监听地址与端口。

模型接口入口由运行时的 `public/config.json` 配置。复制
`public/config.example.json` 后填写实际入口；该文件已被 Git 忽略，生产环境也可以将
配置直接挂载到容器的 `/app/dist/config.json`。API Key 页面会展示所有入口，并让
Codex、curl 和 TypeScript 示例跟随当前选择切换。

```bash
cp public/config.example.json public/config.json
```

每个 `baseUrl` 填写入口的 HTTP(S) 基址，不包含末尾的 `/v1`。

## 验证与构建

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm start
```

构建产物位于 `dist/`。

## Docker

```bash
docker build -t cocodex-web .
docker run --rm -p 53332:53332 \
  -e API_PROXY_TARGET=http://host.docker.internal:53141 \
  --add-host=host.docker.internal:host-gateway \
  cocodex-web
```

## 当前页面

- 首次启动 Setup
- 登录与自动刷新会话
- 请求概览与 Token 趋势
- OpenAI 上游账号管理
- API Key 管理
- 请求日志与游标分页
- 用户管理

## License

MIT License
