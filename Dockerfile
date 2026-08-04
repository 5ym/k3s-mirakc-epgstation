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
# join_logo_scp 一式 (CM検出。設定画面の「CMの探し方」の既定)
#
# Amatsukaze と同じ考え方で CM を判定する道具。無音とシーンチェンジ
# (chapter_exe) に加えて**局ロゴが出ているか** (logoframe) を見て、
# join_logo_scp が本編とCMを分ける。
#
# 本家は Windows + AviSynth+ 前提で、Linux 移植も AviSynth+ と
# L-SMASH Works と Node の上に載っていた。いまの tobitti0 版は
# **dtvindex (FFmpeg) で TS を直接読める**ので、そのどれも要らない。
# WITH_AVISYNTH=no で組んで、ビルドは30秒ほどで終わる。
#
# **持ってくるのが5つあるのは、道具が5つあるからではない。**
#   dtvindex            … 下の2つが TS を読むための静的ライブラリ (実行ファイルではない)
#   chapter_exe         ┐
#   logoframe           ├ 実行ファイル3つ。この順で呼ぶ (cm-jls.ts)
#   join_logo_scp       ┘
#   join_logo_scp_trial … **判定規則 (JL/*.txt) だけ。**組まない
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim AS jls
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && \
    apt-get -y --no-install-recommends install \
      git ca-certificates build-essential pkg-config \
      libavformat-dev libavcodec-dev libavutil-dev libswscale-dev libswresample-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 https://github.com/tobitti0/dtvindex.git && \
    git clone --depth 1 https://github.com/tobitti0/chapter_exe.git && \
    git clone --depth 1 https://github.com/tobitti0/logoframe.git && \
    git clone --depth 1 https://github.com/tobitti0/join_logo_scp.git && \
    git clone --depth 1 https://github.com/tobitti0/join_logo_scp_trial.git

RUN make -C dtvindex build/libdtvindex.a && \
    make -C chapter_exe/src WITH_AVISYNTH=no DTVINDEX_DIR=/src/dtvindex && \
    make -C logoframe/src WITH_AVISYNTH=no DTVINDEX_DIR=/src/dtvindex && \
    make -C join_logo_scp/src && \
    mkdir -p /opt/jls/bin && \
    cp chapter_exe/src/chapter_exe logoframe/src/logoframe join_logo_scp/src/join_logo_scp /opt/jls/bin/ && \
    cp -r join_logo_scp_trial/JL /opt/jls/JL

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

# B-CASカードは触らない。掛かったまま録れたTSの解除はチューナーエージェントに
# 投げる(あちらにしか pcscd が居ないため)。recisdb も libpcsclite も要らない
# libav* は join_logo_scp 一式のため。あちらは Debian の共有ライブラリに繋いである
# (denpa 自身の ffmpeg は下で入れる自前ビルド)
RUN apt-get update && \
    apt-get -y --no-install-recommends install \
      libopus0 libsvtav1enc2 libx264-164 libdav1d7 libfontconfig1 libfreetype6 \
      libavformat61 libavcodec61 libavutil59 libswscale8 libswresample5 \
      fontconfig ca-certificates tzdata && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# bun 本体。SvelteKit(adapter-node) の出力を bun で動かす
COPY --from=docker.io/oven/bun:1-debian /usr/local/bin/bun /usr/local/bin/bun

COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg /usr/local/lib/libaribcaption.* /usr/local/lib/
COPY --from=ffmpeg /usr/share/fonts/truetype/rounded-mplus-arib /usr/share/fonts/truetype/rounded-mplus-arib
RUN ldconfig && fc-cache -f

# CM検出の一式。**これが既定** (設定画面の「CMの探し方」で「無音だけ」に戻せる)。
# 3つのコマンドは denpa (src/lib/server/cm-jls.ts) から直接起動する
COPY --from=jls /opt/jls /opt/jls

COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

EXPOSE 3000
CMD ["bun", "./build/index.js"]
