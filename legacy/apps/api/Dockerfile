# syntax=docker/dockerfile:1
#
# Runs the API straight from TypeScript source with Bun — there is no separate
# compile step; Bun executes .ts natively, same as `bun run src/server.ts` in dev.
# The whole workspace is installed (pnpm-lock.yaml is authoritative) because
# apps/api depends on ~20 sibling packages under packages/.
#
# Build from the repo root: docker build -f apps/api/Dockerfile -t jellyswarm-api .

FROM oven/bun:1-slim AS base
WORKDIR /repo
RUN bun install -g pnpm@10

FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /repo /repo
RUN groupadd --system --gid 1001 jelly && useradd --system --uid 1001 --gid jelly jelly
USER jelly
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/server.ts"]
