FROM rust:1-bookworm AS builder

WORKDIR /app
COPY sql ./sql
COPY scripts ./scripts
COPY crates/proxy/Cargo.toml crates/proxy/Cargo.lock ./crates/proxy/
COPY crates/proxy/src ./crates/proxy/src
RUN cargo build --release --locked --manifest-path crates/proxy/Cargo.toml

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/crates/proxy/target/release/cocodex /usr/local/bin/cocodex

# Runs as root like the previous image, so existing /data volumes stay writable.
ENV HOST=0.0.0.0 \
    PORT=53141 \
    COCODEX_CONFIG_PATH=/data/config.json \
    NODE_ENV=production

WORKDIR /data
EXPOSE 53141

CMD ["cocodex"]
