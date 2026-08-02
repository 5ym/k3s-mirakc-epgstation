FROM docker.io/chinachu/mirakurun:latest

# pcscd はベースイメージに入っているが起動されない。procps は pgrep のため
RUN apt-get update && apt-get -y install curl procps && \
    cd /tmp && \
    curl -OL https://github.com/kazuki0824/recisdb-rs/releases/download/1.2.4/recisdb_1.2.4-1_amd64.deb && \
    apt-get -y install ./recisdb_1.2.4-1_amd64.deb && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /tmp/*

# 設定は PVC (/app-config) に置く。チャンネルスキャンの結果が残るようにするため。
# イメージには「初回に入れる雛形」として別の場所に持たせ、
# entrypoint が /app-config に無いものだけ写す
COPY channels.yml tuners.yml /app-config-defaults/

# B-CASカードを読めるようにしてから Mirakurun を起動する
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
