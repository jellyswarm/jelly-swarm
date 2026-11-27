FROM oven/bun:1.4.5-alpine AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS runner
ENV NODE_ENV=production
ARG APP_COMMIT_SHA=unknown
ENV APP_COMMIT_SHA=${APP_COMMIT_SHA}
ENV APP_VERSION=${APP_COMMIT_SHA}
LABEL org.opencontainers.image.source="https://github.com/jellyswarm/jelly-swarm"
LABEL org.opencontainers.image.revision=${APP_COMMIT_SHA}
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 3001
USER bun
CMD ["bun", "run", "start"]
