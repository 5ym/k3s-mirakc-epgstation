# ---------------------------------------------------------------------------
# チューナーエージェント (.NET)。
#
# **Native AOT で実行ファイル1個。** 別のPCへ置くときに「まず何かを入れて
# ください」が要らないことが条件なので、ここは外せない (docs/roadmap.md)。
#
# denpa から見える口は agent/conformance.test.ts が押さえている
# (本物を起こして HTTP で当てる)。入れ替えは像のタグを変えるだけ。
# ---------------------------------------------------------------------------
# 既定の像がそのまま trixie (`-trixie` という札は無い)
FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /build
# AOT のリンクに clang と zlib が要る
RUN apt-get update && \
    apt-get -y --no-install-recommends install clang zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*
COPY agent/Denpa.Agent/ Denpa.Agent/
RUN dotnet publish Denpa.Agent/Denpa.Agent.csproj -c Release -r linux-x64 -o /out

# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim

# **`recisdb` は入れません。** 選局は自分でやり (ioctl)、B25 も自分で解きます。
#
# libaribb25       … B25 の復号。`recisdb` が中で使っていたものと同じ実装
# pcscd/pcsc-tools … B-CASカードを読む。denpa 側からは触れない
# util-linux       … setsid。設定に選局コマンドを書いたときだけ使う逃げ道
# renovate: datasource=github-releases depName=tsukumijima/libaribb25 extractVersion=^v(?<version>.*)$
ARG ARIBB25_VERSION=0.2.10
RUN apt-get update && \
    apt-get -y --no-install-recommends install curl ca-certificates procps util-linux \
        pcscd pcsc-tools tzdata && \
    cd /tmp && \
    curl -fsSLO https://github.com/tsukumijima/libaribb25/releases/download/v${ARIBB25_VERSION}/libaribb25_${ARIBB25_VERSION}_amd64.deb && \
    apt-get -y --no-install-recommends install ./libaribb25_${ARIBB25_VERSION}_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# 設定は PVC (/app-config) に置く。**どちらも denpa の画面が書く。**
#
# **どちらも無くて構わない。** tuners.json が無ければ刺さっている機材を
# 自分で見つけるし、channels.json はスキャンするまで空でよい。
ENV TUNERS_FILE=/app-config/tuners.json \
    CHANNELS_FILE=/app-config/channels.json
COPY --from=build /out/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 25252
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
