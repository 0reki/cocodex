# @workspace/database

Reusable PostgreSQL package for apps in this monorepo.

## Environment

- `DATABASE_URL` (required)
- `PG_POOL_MAX` (optional, default `10`)
- `PG_IDLE_TIMEOUT_MS` (optional, default `30000`)
- `PG_SSL_MODE` (optional, set `require` to enable ssl)

## Usage

```ts
import { ensureDatabaseSchema, getOpenAIAccountStats } from "@workspace/database"

await ensureDatabaseSchema()
const stats = await getOpenAIAccountStats()
```
