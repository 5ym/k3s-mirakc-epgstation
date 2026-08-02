# ---------------------------------------------------------------------------
# エージェントを1つの実行ファイルに固める。
# こうすると mirakc のイメージにランタイムを足さずに済む
# ---------------------------------------------------------------------------
FROM docker.io/oven/bun:1-debian AS agent
WORKDIR /build
# TSの解析は denpa と共通 (src/lib/ts)。二重に持つと片方だけ直して食い違う。
# テストは agent.ts から辿れないので束ねられない
COPY mirakc/*.ts mirakc/
COPY src/lib/ts/*.ts src/lib/ts/
RUN bun build --compile --minify mirakc/agent.ts --outfile denpa-agent

# ---------------------------------------------------------------------------
FROM docker.io/mirakc/mirakc:debian

# recisdb          … 選局と ARIB STD-B25 の復号。mirakc のチューナーコマンドに使う
# pcscd/pcsc-tools … B-CASカードを読む。denpa 側からは触れない
ARG RECISDB_VERSION=1.2.4
RUN apt-get update && \
    apt-get -y --no-install-recommends install curl ca-certificates procps pcscd pcsc-tools && \
    cd /tmp && \
    curl -fsSLO https://github.com/kazuki0824/recisdb-rs/releases/download/${RECISDB_VERSION}/recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get -y --no-install-recommends install ./recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# 設定は PVC (/app-config) に置く。スキャン結果が書き戻され、Pod を作り直しても残る。
# /etc/mirakc は使わない。あそこには mirakc 自身の strings.yml が居て、
# PVC を被せると隠れてしまう。
# イメージが持っているのは初回だけ写す雛形で、チャンネルは空
ENV MIRAKC_CONFIG=/app-config/config.yml
COPY mirakc/config.yml /app-config-defaults/config.yml
COPY --from=agent /build/denpa-agent /usr/local/bin/denpa-agent

# エージェントが PID 1 になり、mirakc を子として抱える。
# スキャンの間だけ mirakc を止められるようにするため
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
