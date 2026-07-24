FROM docker.io/mirakc/mirakc:3.4.74

RUN cd /tmp && \
    curl -OL https://github.com/kazuki0824/recisdb-rs/releases/download/1.2.4/recisdb_1.2.4-1_amd64.deb && \
    apt-get update && apt-get -y install ./recisdb_1.2.4-1_amd64.deb pcscd && \
    cd /var/lib && mkdir miraview && cd miraview && \
    curl -L https://github.com/maeda577/miraview/releases/download/v0.1.2/build.tar.gz | tar -zxvf - && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /tmp/*

# config.yml is rewritten at runtime by scan.sh/collect-logos.sh (channels:/
# resource.logos: blocks), so it's seeded onto a PVC by an initContainer
# instead of being mounted directly from this image (see k3s/deployment.yaml).
COPY config.yml /etc/mirakc.default/config.yml
COPY scan.sh /scan.sh
COPY collect-logos.sh /collect-logos.sh
COPY scheduled-collect-logos.sh /scheduled-collect-logos.sh
RUN chmod +x /scan.sh /collect-logos.sh /scheduled-collect-logos.sh

