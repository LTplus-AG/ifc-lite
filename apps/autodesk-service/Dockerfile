# Linux service + native Forma importer. Data Exchange uses the Windows SDK host.
FROM rust:1.92-bookworm AS converter
WORKDIR /build
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
RUN rustup show
COPY rust ./rust
COPY apps/server ./apps/server
RUN cargo build --locked --release -p ifc-lite-cloud-import

FROM node:24-bookworm-slim AS service
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig*.json ./
COPY scripts ./scripts
COPY patches ./patches
COPY packages ./packages
COPY apps ./apps
COPY examples ./examples
RUN pnpm install --frozen-lockfile && pnpm build --filter=@ifc-lite/autodesk-service... \
    && pnpm --filter=@ifc-lite/autodesk-service deploy --legacy --prod /service

FROM node:24-bookworm-slim
ENV NODE_ENV=production AUTODESK_SERVICE_HOST=0.0.0.0 AUTODESK_FORMA_CONVERTER=/usr/local/bin/ifc-lite-cloud-import
WORKDIR /service
COPY --from=service --chown=node:node /service ./
COPY --from=converter /build/target/release/ifc-lite-cloud-import /usr/local/bin/
USER node
EXPOSE 3002
CMD ["node", "dist/bin.js"]
