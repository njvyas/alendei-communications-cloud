# ACC console image (first release, controlled MVP). Built from the repository root:
#
#   docker build -f deploy/web.Dockerfile \
#     --build-arg NEXT_PUBLIC_API_BASE_URL=https://<host>/api/v1 \
#     --build-arg NEXT_PUBLIC_APP_ENV=staging \
#     -t acc-web:<version> .
#
# NEXT_PUBLIC_* values are compiled into the browser bundle, so an image is
# built per environment; they are public by nature and never carry a secret.
FROM node:24-bookworm-slim

ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_APP_ENV=staging
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_PUBLIC_APP_ENV=${NEXT_PUBLIC_APP_ENV} \
    NEXT_TELEMETRY_DISABLED=1 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci --include=dev --no-audit

COPY packages packages
COPY apps/web apps/web
RUN test -n "$NEXT_PUBLIC_API_BASE_URL" || (echo "NEXT_PUBLIC_API_BASE_URL build argument is required" >&2; exit 1) \
 && npm run build:packages \
 && NODE_ENV=production npm run build --workspace @acc/web \
 && chown -R node:node /app

ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "node_modules/next/dist/bin/next", "start", "apps/web", "--port", "3000"]
