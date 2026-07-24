FROM docker.io/library/debian:trixie-slim
SHELL ["/bin/bash", "-c"]

ENV DEV="curl ca-certificates build-essential cmake pkg-config nasm zlib1g-dev libfreetype6-dev libopus-dev libsvtav1enc-dev libx265-dev libdav1d-dev libfontconfig-dev"
ENV FFMPEG_VERSION=8.1

RUN apt-get update && \
    apt-get -y --no-install-recommends install $DEV libopus0 libsvtav1enc2 libx265-215 libdav1d7 libfontconfig1 libfreetype6 && \
    mkdir -p /usr/share/fonts/truetype/rounded-mplus-arib && \
    curl -fsSL https://raw.githubusercontent.com/5ym/arib-font/main/rounded-mplus-1m-arib.ttf \
      -o /usr/share/fonts/truetype/rounded-mplus-arib/rounded-mplus-1m-arib.ttf && \
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.5/install.sh | bash && \
    source /root/.nvm/nvm.sh && nvm install 20 && \
    mkdir /tmp/arib && cd /tmp/arib && \
    curl -fsSL https://github.com/xqq/libaribcaption/archive/refs/heads/master.tar.gz | tar -xz --strip-components=1 && \
    mkdir build && cd build && cmake .. -DCMAKE_BUILD_TYPE=Release && cmake --build . -j$(nproc) && cmake --install . && \
    mkdir /tmp/ffmpeg_sources && \
    cd /tmp/ffmpeg_sources && \
    curl -fsSL http://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.bz2 | tar -xj --strip-components=1 && \
    ./configure \
      --enable-gpl \
      --enable-libopus \
      --enable-libaribcaption \
      --enable-libsvtav1 \
      --enable-libx265 \
      --enable-libdav1d \
    && \
    make -j$(nproc) && \
    make install && \
    apt-get -y purge $DEV && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /tmp/*

COPY --from=docker.io/l3tnun/epgstation /app /app/
COPY --from=docker.io/l3tnun/epgstation /app/client /app/client/

COPY config.yml enc.js rec.js epgUpdaterLogConfig.yml operatorLogConfig.yml serviceLogConfig.yml /app/config/

EXPOSE 8888
WORKDIR /app
CMD bash -c "source /root/.nvm/nvm.sh && npm start"
