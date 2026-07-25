FROM chinachu/mirakurun:4.1.3

RUN cd /tmp && \
    curl -OL https://github.com/kazuki0824/recisdb-rs/releases/download/1.2.4/recisdb_1.2.4-1_amd64.deb && \
    apt-get update && apt-get -y install ./recisdb_1.2.4-1_amd64.deb && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    rm -rf /tmp/*

# /app-config is a PVC-backed volume seeded by an initContainer (see
# k3s/deployment.yaml), so the defaults live at a separate path here and get
# copied onto the volume only on first boot (if not already present).
COPY server.yml channels.yml tuners.yml /app-config.default/
