FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep curl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

WORKDIR /app
COPY extensions /app/extensions
COPY test /app/test

# Container-local pi agent home (isolated from host).
ENV HOME=/root

CMD ["bash", "/app/test/run-in-container.sh"]
