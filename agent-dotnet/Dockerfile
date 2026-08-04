# ---------------------------------------------------------------------------
# チューナーエージェント (.NET)。
#
# **Native AOT で実行ファイル1個。** 別のPCへ置くときに「まず何かを入れて
# ください」が要らないことが条件なので、ここは外せない (docs/roadmap.md)。
#
# bun 版 (agent/) と**同じ口**を持ち、同じ適合テスト
# (agent/conformance.test.ts) を通る。入れ替えは像のタグを変えるだけ。
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/dotnet/sdk:10.0-trixie AS build
WORKDIR /build
# AOT のリンクに clang と zlib が要る
RUN apt-get update && \
    apt-get -y --no-install-recommends install clang zlib1g-dev && \
    rm -rf /var/lib/apt/lists/*
COPY agent-dotnet/Denpa.Agent/ Denpa.Agent/
RUN dotnet publish Denpa.Agent/Denpa.Agent.csproj -c Release -r linux-x64 -o /out

# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim

# recisdb          … 選局と ARIB STD-B25 の復号
# pcscd/pcsc-tools … B-CASカードを読む。denpa 側からは触れない
# util-linux       … setsid。選局をプロセスグループごと終わらせるのに要る
ARG RECISDB_VERSION=1.2.4
RUN apt-get update && \
    apt-get -y --no-install-recommends install curl ca-certificates procps util-linux \
        pcscd pcsc-tools tzdata && \
    cd /tmp && \
    curl -fsSLO https://github.com/kazuki0824/recisdb-rs/releases/download/${RECISDB_VERSION}/recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get -y --no-install-recommends install ./recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# 設定は PVC (/app-config) に置く。
#
# **どちらも無くて構わない。** tuners.yml が無ければ刺さっている機材を
# 自分で見つけるし、channels.json はスキャンするまで空でよい。
ENV TUNERS_FILE=/app-config/tuners.yml \
    CHANNELS_FILE=/app-config/channels.json
COPY --from=build /out/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 40773
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
