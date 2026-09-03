FROM node:24-alpine AS builder

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY sql ./sql
RUN pnpm build

FROM node:24-alpine

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY --from=builder /app/dist ./dist
COPY sql ./sql

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=53141

EXPOSE 53141

CMD ["node", "dist/src/server.js"]
