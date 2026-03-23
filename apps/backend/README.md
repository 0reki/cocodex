# backend

Express backend for OpenAI account management.

## Env

- `PORT` (default `53141`)
- `HOST` (default `localhost`)
- `DATABASE_URL` (required)
- `PG_POOL_MAX` (optional)
- `PG_IDLE_TIMEOUT_MS` (optional)
- `PG_SSL_MODE` (`require` for SSL)

## APIs

- `GET /health`
- `GET /api/openai-accounts?limit=100`
- `GET /api/openai-accounts/:email`
- `POST /api/openai-accounts`
