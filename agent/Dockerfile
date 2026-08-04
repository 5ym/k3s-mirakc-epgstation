# ---------------------------------------------------------------------------
# チューナーエージェント。
#
# **mirakc はもう入っていない。** 選局と取り合いはこのプロセスが持つ
# (docs/roadmap.md)。ここに残っているのは「denpa から触れないもの」だけ —
# チューナーデバイスと B-CASカード。**中身は読まない。**
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1-debian AS build
WORKDIR /build
# **持って行くのは agent/ だけ。** TS の中身は1バイトも読まないので、
# denpa 側の解析 (src/lib/ts) は要らない。テストは server.ts から辿れないので
# 束ねられない
COPY agent/*.ts agent/
RUN bun build --compile --minify agent/server.ts --outfile denpa-agent

# ---------------------------------------------------------------------------
FROM docker.io/library/debian:trixie-slim

# recisdb          … 選局と ARIB STD-B25 の復号
# pcscd/pcsc-tools … B-CASカードを読む。denpa 側からは触れない
ARG RECISDB_VERSION=1.2.4
RUN apt-get update && \
    apt-get -y --no-install-recommends install curl ca-certificates procps pcscd pcsc-tools tzdata && \
    cd /tmp && \
    curl -fsSLO https://github.com/kazuki0824/recisdb-rs/releases/download/${RECISDB_VERSION}/recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get -y --no-install-recommends install ./recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# 設定は PVC (/app-config) に置く。**どちらも denpa が書く。**
#
# チューナーの定義とスキャン結果を分けてあるのは、片方を書き換えるときに
# もう片方を巻き添えにしないため
ENV TUNERS_FILE=/app-config/tuners.json \
    CHANNELS_FILE=/app-config/channels.json
COPY --from=build /build/denpa-agent /usr/local/bin/denpa-agent

EXPOSE 25252
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
