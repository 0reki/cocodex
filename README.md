<div align="center">
  <h1>CoCodex</h1>
  <p>Get the most out of Codex in the way that fits you best.</p>
</div>

## Overview

CoCodex is a self-hosted control panel and service layer for Codex-oriented workflows.

It is designed for people who want a practical way to operate Codex at scale, with one place to manage accounts, access, and operational workflows.

CoCodex gives you a web admin interface and backend APIs to manage:

- OpenAI accounts and team workspaces
- API keys and system settings
- signup / relogin flows
- inbox and operational tooling around your Codex setup

## Quick Start

### Local development

1. Install dependencies:

```bash
bun install
```

2. Create your local env file:

```bash
cp .env.example .env
```

Then update `.env` with real values for your environment. At minimum, local development needs a working `DATABASE_URL`. For full functionality, also configure the required OpenAI, Cloud Mail, OAuth, and other provider credentials.

3. Start PostgreSQL.

4. Start the development environment:

```bash
bun run dev
```

Default local endpoints:

- Web: `http://localhost:53332`
- Backend: `http://localhost:53141`

### Docker quick start

If you just want the stack running quickly, use Docker.

1. Copy the Docker environment file:

```bash
cp .env.docker.example .env.docker
```

2. Update `.env.docker` if needed.

The default values are enough to boot the app and database locally. For real feature usage, you still need to provide the external service credentials your setup depends on.

3. Start the stack:

```bash
bun run docker:up
```

4. Stop the stack:

```bash
bun run docker:down
```

Default ports:

- Web: `http://localhost:53332`
- Backend: `http://localhost:53141`
- PostgreSQL: `localhost:5432`

## Deployment

### systemd

The systemd units are under [`deploy/systemd`](./deploy/systemd).

They assume:

- Bun is installed under the runtime user's home directory
- the repository is located at `~/cocodex`
- the runtime env file is `~/cocodex/.env`

The main service uses `%h`, so paths follow the configured `User=` automatically. In practice, you usually only need to check:

- `User=`
- `Group=`
- `WorkingDirectory` if your checkout directory is not `~/cocodex`

Install and enable:

```bash
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo cp deploy/systemd/*.timer /etc/systemd/system/
sudo cp deploy/systemd/*.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cocodex.target
sudo systemctl enable --now cocodex-status-poll.timer
sudo systemctl enable --now cocodex-sync-openai-rate-limits.timer
```

Useful commands:

```bash
sudo systemctl status cocodex.service
sudo journalctl -u cocodex.service -f
sudo systemctl list-timers 'cocodex-*'
```

The deployment also includes two scheduled jobs running every 5 minutes:

- `status:poll`
- `sync:openai-rate-limits`

### Docker

The Docker setup is meant to be the fast path for getting the stack online locally or on a small server.

Files involved:

- [`docker-compose.yml`](./docker-compose.yml)
- [`Dockerfile`](./Dockerfile)
- [`.env.docker.example`](./.env.docker.example)

The compose stack starts:

- PostgreSQL
- backend
- web

To use it:

```bash
cp .env.docker.example .env.docker
```

Then edit `.env.docker` for your environment. In most cases you only need to care about:

- `DATABASE_URL`
- `APP_BASE_URL`
- `NEXT_PUBLIC_APP_BASE_URL`
- `PORTAL_PUBLIC_ORIGIN`
- `API_BASE_URL`
- `NEXT_PUBLIC_API_BASE_URL`
- any OpenAI / Cloud Mail / OAuth credentials you actually use

Start:

```bash
bun run docker:up
```

Stop:

```bash
bun run docker:down
```

The backend initializes the database schema automatically on startup, so you do not need a separate migration step just to boot the project.

## License

MIT License

## Acknowledgements

This project has been published in the [LINUX DO](https://linux.do/) community. Thanks to the community for the support and feedback.
