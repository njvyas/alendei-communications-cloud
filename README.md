# Alendei Communications Cloud (ACC)

Multi-tenant communications control plane. `/docs` is the architecture contract
and the source of truth; this README covers only how to run what is built.

**Current phase: 1 — Foundation** (`docs/ROADMAP.md` §4). Identity, tenancy,
authorization, events and observability. Messaging, providers, routing, fallback,
campaigns, billing and the inbox belong to later phases and are not implemented.

## Repository layout

```
apps/
  api/        NestJS modular monolith (ARCHITECTURE.md §4)
  web/        Next.js admin console shell
packages/
  contracts/  Cross-boundary types: tenant context, permissions, event envelope, errors
  db/         Drizzle schema, SQL migrations, RLS policies, tenant-scoped client
infra/        Local observability configuration
scripts/      Repository tooling (dependency-audit gate)
security/     Reviewed, dated dependency-advisory exceptions
docs/         Architecture contract — read before changing anything
```

## Prerequisites

- Node.js 24 (see `.nvmrc`), npm 10+
- Docker with Compose v2

## Setup

```bash
npm install
cp .env.example .env
# Replace the placeholder development secret with your own:
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

`.env` is git-ignored and must never be committed.

## Local infrastructure

```bash
npm run infra:up        # PostgreSQL, Redis, Redpanda
npm run infra:logs
npm run infra:down
npm run infra:reset     # destroys volumes and starts fresh
```

Optional profiles:

```bash
docker compose --profile observability up -d   # OTel collector, Prometheus, Grafana
docker compose --profile tooling up -d         # Redpanda Console
```

## Database

Migrations run as the schema owner; the application never connects as a
principal that can bypass Row-Level Security.

```bash
npm run db:migrate      # apply migrations, then grant LOGIN to acc_app/acc_auth/acc_relay
npm run db:seed         # permission catalogue, platform roles, default reseller
npm run db:reset        # drop, migrate and seed (development/test only)
npm run db:generate     # regenerate a Drizzle migration after a schema change
```

`db:generate` emits table DDL only. RLS policies, triggers and grants are
hand-written SQL appended to the same migration file, so a table and its policies
always ship in one change set — see `docs/DATABASE.md` §14.

## Development

```bash
npm run dev:api         # http://localhost:3001  (prefix /api/v1)
npm run dev:web         # http://localhost:3000
```

| Endpoint            | Purpose                                    |
| ------------------- | ------------------------------------------ |
| `GET /health/live`  | Liveness — touches no dependency           |
| `GET /health/ready` | Readiness — requires PostgreSQL            |
| `GET /health`       | Aggregate health                           |
| `GET /metrics`      | Prometheus scrape (bounded labels only)    |
| `GET /api/v1/docs`  | Swagger UI, when `OPENAPI_UI_ENABLED=true` |

## Quality gates

```bash
npm run lint
npm run format:check
npm run typecheck
npm run test:unit
npm run test:integration    # requires the Docker stack
npm run test:security       # requires the Docker stack
npm run build
npm run audit               # blocks unaccepted high/critical advisories
```

## Configuration

Every variable is documented in `.env.example` and validated at startup; the
process refuses to boot on invalid configuration rather than starting degraded.

Secrets are resolved through `SecretsPort` from `<backend>:<locator>` references.
Only the `env` backend is implemented, and `APP_ENV=production` together with
`SECRETS_BACKEND=env` is rejected by design (`docs/SECURITY.md` §3) — production
is deliberately not yet runnable until a managed backend adapter exists.

## Database principals

| Role               | Used by                                              | Reach                               |
| ------------------ | ---------------------------------------------------- | ----------------------------------- |
| owner (`postgres`) | migrations, seeding                                  | full; never used by the running API |
| `acc_app`          | all tenant-scoped queries                            | RLS-enforced on `org_id`            |
| `acc_auth`         | credential verification before tenant context exists | identity tables only                |
| `acc_relay`        | transactional-outbox publisher                       | outbox only                         |

## Contributing

Branch from `develop` (`docs/DEPLOYMENT.md` §5). Before every commit: `git status`,
`git diff`, then lint, typecheck and the relevant tests.
