FROM docker.io/mirakc/mirakc:debian

# recisdb          … 選局と ARIB STD-B25 の復号。mirakc のチューナーコマンドに使う
# pcscd/pcsc-tools … B-CASカードを読む。denpa 側からは触れない
# isdb-scanner     … チャンネルスキャン。mirakc には走査APIが無いので、recisdb で
#                    直接チューナーを叩くこれに任せる。mirakc の config.yml を
#                    そのまま出力してくれる
# python3          … agent.py (mirakc を抱えて denpa の窓口になる)
ARG RECISDB_VERSION=1.2.4
ARG ISDB_SCANNER_VERSION=v1.3.3
RUN apt-get update && \
    apt-get -y --no-install-recommends install \
      curl ca-certificates procps pcscd pcsc-tools python3-minimal python3-yaml && \
    cd /tmp && \
    curl -fsSLO https://github.com/kazuki0824/recisdb-rs/releases/download/${RECISDB_VERSION}/recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    apt-get -y --no-install-recommends install ./recisdb_${RECISDB_VERSION}-1_amd64.deb && \
    curl -fsSL https://github.com/tsukumijima/ISDBScanner/releases/download/${ISDB_SCANNER_VERSION}/isdb-scanner \
      -o /usr/local/bin/isdb-scanner && \
    chmod +x /usr/local/bin/isdb-scanner && \
    apt-get clean && rm -rf /var/lib/apt/lists/* /tmp/*

# 設定は PVC に置く。スキャン結果が書き戻され、Pod を作り直しても残る。
# イメージが持っているのは初回だけ写す雛形で、チャンネルもチューナーも空
COPY config.yml /app-config-defaults/config.yml
COPY agent.py /usr/local/bin/denpa-agent
RUN chmod +x /usr/local/bin/denpa-agent

# agent が PID 1 になり、mirakc を子として抱える。
# スキャンの間だけ mirakc を止められるようにするため
ENTRYPOINT ["/usr/local/bin/denpa-agent"]
