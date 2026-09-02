FROM node:24-alpine AS builder

WORKDIR /app
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.2.1 --activate

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV WEB_HOST=0.0.0.0
ENV WEB_PORT=53332
ENV API_PROXY_TARGET=http://host.docker.internal:53141

COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/server.mjs ./server.mjs

USER node
EXPOSE 53332
CMD ["node", "server.mjs"]
