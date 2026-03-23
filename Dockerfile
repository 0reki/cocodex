FROM oven/bun:1.3.10 AS base

WORKDIR /app

FROM base AS builder

COPY package.json bun.lock turbo.json tsconfig.json .eslintrc.js ./
COPY apps ./apps
COPY packages ./packages
COPY docker ./docker

RUN BUN_TMPDIR=/tmp BUN_INSTALL=/tmp/bun bun install --frozen-lockfile
RUN bunx --bun turbo run build --filter=backend --filter=web

FROM base AS runtime-deps

COPY package.json bun.lock turbo.json tsconfig.json .eslintrc.js ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/cloud-mail/package.json ./packages/cloud-mail/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/eslint-config/package.json ./packages/eslint-config/package.json
COPY packages/inbox-translation/package.json ./packages/inbox-translation/package.json
COPY packages/openai-api/package.json ./packages/openai-api/package.json
COPY packages/openai-codex-auth/package.json ./packages/openai-codex-auth/package.json
COPY packages/openai-signup/package.json ./packages/openai-signup/package.json
COPY packages/typescript-config/package.json ./packages/typescript-config/package.json
COPY packages/ui/package.json ./packages/ui/package.json

RUN BUN_TMPDIR=/tmp BUN_INSTALL=/tmp/bun bun install --production --ignore-scripts

FROM base AS runner

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV HOSTNAME=0.0.0.0
ENV PORT=53141
ENV WEB_PORT=53332

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/backend/dist ./apps/backend/dist
COPY --from=builder /app/packages/cloud-mail ./packages/cloud-mail
COPY --from=builder /app/packages/database ./packages/database
COPY --from=builder /app/packages/openai-api ./packages/openai-api
COPY --from=builder /app/packages/openai-codex-auth ./packages/openai-codex-auth
COPY --from=builder /app/packages/openai-signup ./packages/openai-signup
COPY --from=builder /app/docker ./docker
COPY --from=runtime-deps /app/node_modules ./node_modules

EXPOSE 53141 53332

CMD ["sh", "./docker/start.sh"]
