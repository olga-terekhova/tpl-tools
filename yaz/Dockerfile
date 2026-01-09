FROM debian:trixie-slim

ARG YAZ_VERSION=5.36.0
ARG YAZ_BASE_URL=https://ftp.indexdata.com/pub/yaz/debian/trixie/

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/yaz

# Download required YAZ packages
RUN wget -q \
    ${YAZ_BASE_URL}/libyaz5_${YAZ_VERSION}-1.indexdata_amd64.deb \
    ${YAZ_BASE_URL}/yaz_${YAZ_VERSION}-1.indexdata_amd64.deb \
    ${YAZ_BASE_URL}/yaz-icu_${YAZ_VERSION}-1.indexdata_amd64.deb

# Install YAZ

RUN dpkg -i *.deb || apt-get update && apt-get -f install -y \
    && rm -rf /var/lib/apt/lists/* /tmp/yaz

# Sanity check
RUN yaz-client -V

ENTRYPOINT ["yaz-client"]
