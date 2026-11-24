# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/
RUN pnpm install --frozen-lockfile && pnpm --dir web install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV BOTNOTE_HOST=0.0.0.0
ENV BOTNOTE_PORT=4280
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --prod --frozen-lockfile && pnpm store prune
COPY --from=build /app/dist dist
COPY --from=build /app/web/dist web/dist
COPY --from=build /app/packages/cli/dist packages/cli/dist
COPY LICENSE LICENSING.md ./
USER node
EXPOSE 4280
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BOTNOTE_PORT||4280)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.js"]
