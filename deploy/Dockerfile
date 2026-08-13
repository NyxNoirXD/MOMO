# Single image for the whole stack: official OpenWA image + our bot + router +
# backup tooling. Used by Render, Oracle, Railway and local docker compose alike.
FROM node:22-slim AS bot-build

WORKDIR /bot
COPY bot/package.json bot/package-lock.json ./
RUN npm ci
COPY bot/tsconfig.json ./
COPY bot/src ./src
RUN npm run build && npm prune --omit=dev

FROM ghcr.io/rmyndharis/openwa:latest

USER root

ARG ARCH=amd64
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://downloads.rclone.org/rclone-current-linux-${ARCH}.zip -o /tmp/rclone.zip \
    && unzip -q /tmp/rclone.zip -d /tmp/rclone \
    && cp /tmp/rclone/rclone-*-linux-${ARCH}/rclone /usr/local/bin/rclone \
    && chmod +x /usr/local/bin/rclone \
    && rm -rf /tmp/rclone /tmp/rclone.zip

COPY --from=bot-build /bot/dist /bot/dist
COPY --from=bot-build /bot/node_modules /bot/node_modules
COPY deploy/router.js /usr/local/bin/momo-router.js
COPY deploy/start.sh /usr/local/bin/momo-start.sh
COPY deploy/backup/backup-upload.sh /usr/local/bin/backup-upload.sh
COPY deploy/backup/restore-download.sh /usr/local/bin/restore-download.sh

RUN chmod +x /usr/local/bin/momo-start.sh /usr/local/bin/momo-router.js \
    /usr/local/bin/backup-upload.sh /usr/local/bin/restore-download.sh

ENV BOT_PORT=3001 \
    OPENWA_PORT=2790 \
    ENGINE_TYPE=baileys \
    AUTO_START_SESSIONS=true

EXPOSE 2785

CMD ["/usr/local/bin/momo-start.sh"]