# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# 依存の解決だけを分ける。ソースを変えてもここは再実行されない
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1-debian AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install

# ---------------------------------------------------------------------------
# 開発用。compose からソースを bind mount して使う
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1-debian AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
EXPOSE 5173
CMD ["bun", "run", "dev", "--host", "0.0.0.0", "--port", "5173"]

# ---------------------------------------------------------------------------
# E2E用。Playwright のブラウザを焼き込む
# ---------------------------------------------------------------------------
FROM dev AS test
ENV CI=1
RUN bunx playwright install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/*
CMD ["bun", "run", "test"]

# ---------------------------------------------------------------------------
# ffmpeg。EPGStation 用に組んでいたものと同じ構成
# (ARIB字幕 libaribcaption + AV1 libsvtav1 + Opus)
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim AS ffmpeg
SHELL ["/bin/bash", "-c"]

# ダウンロードは CI で切られることがあるので必ずリトライさせる。
# 一度これで ffmpeg の取得に失敗してデプロイが止まった
ENV CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"

ENV DEV="curl ca-certificates build-essential cmake pkg-config nasm zlib1g-dev libfreetype6-dev libopus-dev libsvtav1enc-dev libx264-dev libdav1d-dev libfontconfig-dev"
ENV FFMPEG_VERSION=8.1

RUN apt-get update && \
    apt-get -y --no-install-recommends install $DEV && \
    mkdir -p /usr/share/fonts/truetype/rounded-mplus-arib && \
    $CURL https://raw.githubusercontent.com/5ym/arib-font/main/rounded-mplus-1m-arib.ttf \
      -o /usr/share/fonts/truetype/rounded-mplus-arib/rounded-mplus-1m-arib.ttf && \
    mkdir /tmp/arib && cd /tmp/arib && \
    $CURL https://github.com/xqq/libaribcaption/archive/refs/heads/master.tar.gz | tar -xz --strip-components=1 && \
    mkdir build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release && cmake --build . -j$(nproc) && cmake --install . && \
    mkdir /tmp/ffmpeg_sources && cd /tmp/ffmpeg_sources && \
    $CURL https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 | tar -xj --strip-components=1 && \
    ./configure \
      --enable-gpl \
      --enable-libopus \
      --enable-libaribcaption \
      --enable-libsvtav1 \
      --enable-libx264 \
      --enable-libdav1d \
    && \
    make -j$(nproc) && make install && \
    rm -rf /var/lib/apt/lists/* /tmp/*

# ---------------------------------------------------------------------------
# 本番ビルド
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY . .
RUN bun run build

# ---------------------------------------------------------------------------
# 本番イメージ
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Tokyo \
    FFMPEG=/usr/local/bin/ffmpeg \
    FFPROBE=/usr/local/bin/ffprobe

# recisdb はスクランブルが掛かったまま録れたTSを解くのに使う。カードは
# Mirakurun 側の pcscd が握っているので、こちらは libpcsclite でその socket に繋ぐだけ
# (/run/pcscd を両方の Pod で共有している)。チューナーには触らない
ARG RECISDB_VERSION=1.2.4
RUN apt-get update && \
    apt-get -y --no-install-recommends install \
      libopus0 libsvtav1enc2 libx264-164 libdav1d7 libfontconfig1 libfreetype6 \
      fontconfig ca-certificates tzdata libpcsclite1 curl && \
    curl -fsSLO https://github.com/kazuki0824/recisdb-rs/releases/download/${RECISDB_VERSION}/recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get -y --no-install-recommends install ./recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    rm -f recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get -y purge curl && apt-get -y autoremove && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# bun 本体。SvelteKit(adapter-node) の出力を bun で動かす
COPY --from=docker.io/oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun

COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg /usr/local/lib/libaribcaption.* /usr/local/lib/
COPY --from=ffmpeg /usr/share/fonts/truetype/rounded-mplus-arib /usr/share/fonts/truetype/rounded-mplus-arib
RUN ldconfig && fc-cache -f

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
CMD ["bun", "./build/index.js"]
