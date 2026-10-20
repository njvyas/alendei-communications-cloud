# ACC API image (first release, controlled MVP). Built from the repository root:
#
#   docker build -f deploy/api.Dockerfile -t acc-api:<version> .
#
# One image serves the API and every operator step of the release runbook
# (docs/RELEASE.md): `db:migrate` (schema only, history-verified, Task G),
# `db:roles:reconcile`, `db:seed` and `bootstrap` run from it with
# `docker compose run`. Those CLIs run through tsx, so the image keeps the
# workspace's development dependencies; slimming it is deliberate later work.
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false
WORKDIR /app

# Dependencies first, from the lockfile only, so a source change reuses this layer.
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
RUN npm ci --include=dev --no-audit

COPY packages packages
COPY apps/api apps/api
RUN npm run build:packages && npm run build --workspace @acc/api \
 && chown -R node:node /app

USER node
EXPOSE 3001
# Readiness: PostgreSQL and Redis reachable (GET /health/ready, unprefixed).
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# Exec form: SIGTERM reaches Node directly, which drains in-flight work, waits
# for the dispatch cycle in progress and closes the pools (SHUTDOWN_TIMEOUT_SECONDS).
CMD ["node", "apps/api/dist/main.js"]
