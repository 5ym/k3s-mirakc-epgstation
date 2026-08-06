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

# renovate: datasource=github-tags depName=FFmpeg/FFmpeg extractVersion=^n(?<version>.*)$
ENV FFMPEG_VERSION=9.0
# renovate: datasource=github-tags depName=xqq/libaribcaption
ARG LIBARIBCAPTION_VERSION=v1.1.2
# renovate: datasource=git-refs depName=https://github.com/5ym/arib-font branch=main
ARG ARIB_FONT_SHA=a9c834099818c59ba9c3721a2b1a860f6c0af61a

RUN apt-get update && \
    apt-get -y --no-install-recommends install $DEV && \
    mkdir -p /usr/share/fonts/truetype/rounded-mplus-arib && \
    $CURL https://raw.githubusercontent.com/5ym/arib-font/${ARIB_FONT_SHA}/rounded-mplus-1m-arib.ttf \
      -o /usr/share/fonts/truetype/rounded-mplus-arib/rounded-mplus-1m-arib.ttf && \
    mkdir /tmp/arib && cd /tmp/arib && \
    $CURL https://github.com/xqq/libaribcaption/archive/refs/tags/${LIBARIBCAPTION_VERSION}.tar.gz | tar -xz --strip-components=1 && \
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
# **持ってくるのが4つあるのは、道具が4つあるからではない。**
#   dtvindex      … 下の2つが TS を読むための静的ライブラリ (実行ファイルではない)
#   chapter_exe   ┐ 本家 (nekopanda) の Linux 移植。tobitti0 版
#   logoframe     ┘
#   join_logo_scp … 実行ファイルと判定規則 (JL/)。**yobibi 版**
#
# **join_logo_scp だけ出どころが違う。** tobitti0 版は ver4.0 で 2021年に
# 止まっているが、本家筋の yobibi 版は ver5.1.1 (2026年) まで続いていて、
# **ver5.1 で Linux が本流に入った** — 移植版を使う理由がもう無い。
# 効くのは 5.1.1 の「15秒単位からの差認識が正常にできていなかった所を修正」で、
# ここは CM判定の芯にあたる。
#
# **実行ファイルと JL は必ず対で採る。** JL の文字コードが違い (4.0 は Shift-JIS、
# 5.x は BOM付きUTF-8)、取り違えると `error: wrong command in` で
# 「何も切らない」結果になる。実際に組んで確かめた。
# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim AS jls
ENV DEBIAN_FRONTEND=noninteractive
ENV CURL="curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors --connect-timeout 20"
RUN apt-get update && \
    apt-get -y --no-install-recommends install \
      curl ca-certificates build-essential pkg-config \
      libavformat-dev libavcodec-dev libavutil-dev libswscale-dev libswresample-dev && \
    rm -rf /var/lib/apt/lists/*

# **どれも版で固定する。** master を追っていた頃は、同じコミットから焼いても
# 中身が違いえた。この3つは実際に毎週書き換わっているので、次のデプロイで
# CM検出の中身が黙って変わる。Renovate が新しいコミットを見つけて PR を出す
# ので、上げるのは意識してやる (renovate.json の customManagers)。
WORKDIR /src
# renovate: datasource=git-refs depName=https://github.com/tobitti0/dtvindex branch=main
ARG DTVINDEX_SHA=196272d2e1b8d8aa0d960b4245a8f3a419debfae
# renovate: datasource=git-refs depName=https://github.com/tobitti0/chapter_exe branch=master
ARG CHAPTER_EXE_SHA=a32c8f06c3207f8d144b6be37110c63221d7e79a
# renovate: datasource=git-refs depName=https://github.com/tobitti0/logoframe branch=master
ARG LOGOFRAME_SHA=8185bafc281e86d847d8084de53c7ae42acfb532
# renovate: datasource=github-tags depName=yobibi/join_logo_scp extractVersion=^v(?<version>.*)$
ARG JOIN_LOGO_SCP_VERSION=5.1.1
RUN mkdir -p dtvindex chapter_exe logoframe join_logo_scp && \
    $CURL https://github.com/tobitti0/dtvindex/archive/${DTVINDEX_SHA}.tar.gz \
      | tar -xz --strip-components=1 -C dtvindex && \
    $CURL https://github.com/tobitti0/chapter_exe/archive/${CHAPTER_EXE_SHA}.tar.gz \
      | tar -xz --strip-components=1 -C chapter_exe && \
    $CURL https://github.com/tobitti0/logoframe/archive/${LOGOFRAME_SHA}.tar.gz \
      | tar -xz --strip-components=1 -C logoframe && \
    $CURL https://github.com/yobibi/join_logo_scp/archive/refs/tags/v${JOIN_LOGO_SCP_VERSION}.tar.gz \
      | tar -xz --strip-components=1 -C join_logo_scp

RUN make -C dtvindex build/libdtvindex.a && \
    make -C chapter_exe/src WITH_AVISYNTH=no DTVINDEX_DIR=/src/dtvindex && \
    make -C logoframe/src WITH_AVISYNTH=no DTVINDEX_DIR=/src/dtvindex && \
    make -C join_logo_scp/src && \
    mkdir -p /opt/jls/bin && \
    cp chapter_exe/src/chapter_exe logoframe/src/logoframe join_logo_scp/src/join_logo_scp /opt/jls/bin/ && \
    cp -r join_logo_scp/JL /opt/jls/JL && \
    test -f /opt/jls/JL/JL_標準.txt

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
# ライブ視聴の WebSocket を受ける入口。中身の理由はファイルの頭に書いてある
COPY --from=build /app/server.js ./server.js

EXPOSE 3000
CMD ["bun", "./server.js"]
