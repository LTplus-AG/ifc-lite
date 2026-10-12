FROM node:24-bookworm-slim AS build
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig*.json ./
COPY scripts ./scripts
COPY patches ./patches
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples
RUN pnpm install --frozen-lockfile && pnpm build --filter=@ifc-lite/report-service... \
    && pnpm --filter=@ifc-lite/report-service deploy --legacy --prod /service
FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3005
WORKDIR /service
COPY --from=build --chown=node:node /service ./
USER node
EXPOSE 3005
CMD ["node", "dist/bin.js"]
