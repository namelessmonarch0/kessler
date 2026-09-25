# Kessler API

FastAPI + Postgres backend for kessler.kudayyurter.dev. Design: `../docs/superpowers/specs/2026-09-22-leo-debris-design.md`.

## Local setup

```bash
cd api
cp .env.example .env            # add Space-Track credentials if you have them
docker compose up -d db         # Postgres 16 with pgvector on localhost:5432
uv sync
uv run alembic upgrade head
uv run python -m app.jobs all   # ~1–2 min: SATCAT, stats, GP + globe snapshots
uv run uvicorn app.api.main:create_app --factory --reload
```

Then open http://localhost:8000/docs.

## Jobs

| Command | What it does | Production schedule |
|---|---|---|
| `python -m app.jobs ingest-satcat` | CelesTrak SATCAT → `objects`, then rebuilds `yearly_stats` | daily at 05:17 UTC |
| `python -m app.jobs ingest-gp` | Space-Track GP (CelesTrak fallback) → archives changed element sets to `history/gp/`, then `gp_elements` + a new globe generation | every 6 h at minute 41 |
| `python -m app.jobs rebuild-stats` | Recomputes `yearly_stats` from `objects` | after SATCAT |
| `python -m app.jobs publish-globe` | Republishes the globe from `gp_elements` as a new generation, fetching nothing | after each deploy's migrations; by hand to repair a failed publication |
| `python -m app.jobs all` | SATCAT, stats and GP (not `publish-globe`: the GP ingest publishes) | — |

Every run is recorded in `ingest_runs`. A failed run never replaces good data. A job prints its
counts as JSON; `ingest_gp` is the number of element sets changed (inserted or with a newer epoch),
not the catalog size. How many incoming records matched the catalog is logged, not stored.

**Globe snapshots** are published as immutable generations (id `YYYYMMDDTHHMMSSZ-r<run id>`):
`globe/gen/<id>/` holds `LEO.bin.gz`, `HIGH.bin.gz`, `names-LEO.json.gz` and `names-HIGH.json.gz`,
and only once all four exist does `globe/current.json` switch to the new generation
(`GET /api/globe/current`).
Each publication removes generations older than 48 hours, except the current and previous ones.
A database with no element sets publishes nothing. The legacy `globe/LEO.bin.gz` and
`globe/HIGH.bin.gz` are no longer written but are left in place, so a rolled-back API still has
(stale) snapshots.

`ingest-gp` and `publish-globe` take one Postgres advisory lock (`kessler.globe`), transaction-scoped
on a dedicated connection so it works through Neon's pooled endpoint. A run that overlaps another
waits for it, for at most 8 minutes, then fails with `QueryCanceled` (recorded in `ingest_runs`).

`python -m app.history dump --from YYYY-MM-DD --to YYYY-MM-DD` prints the archived element sets for
that UTC date range as JSON Lines.

## Tests

`uv run pytest` (needs Docker for testcontainers, or set `TEST_DATABASE_URL` to an empty database).
Tests marked `pgbouncer` run the lock through a PgBouncer container in transaction mode; they skip,
giving the reason, if that container cannot start or reach the database (`-m "not pgbouncer"`
leaves them out).

## Container images (AWS Lambda)

`Dockerfile` builds two images from shared layers:

| Target | Lambda | Runs |
|---|---|---|
| `api` | `kessler-api` (Function URL, streaming) | uvicorn behind the AWS Lambda Web Adapter |
| `jobs` | `kessler-jobs` (scheduled) | `app.lambda_jobs.handler`, event `{"job": "migrate" \| "ingest-satcat" \| "ingest-gp" \| "rebuild-stats" \| "publish-globe" \| "all"}` |

Always build with `--platform linux/amd64 --provenance=false`, because Lambda rejects manifests that carry attestations.
`./scripts/smoke-images.sh` builds both and checks them against the local compose database.

In Lambda, `SSM_PREFIX=/kessler/` loads secrets from SSM Parameter Store at cold start, and `SNAPSHOT_BUCKET` switches globe snapshots to S3.

## Health checks

`GET /api/health` is liveness only — the process answers, no database access — so it's cheap for
anyone to call. `GET /api/ready` is readiness — it runs `SELECT 1` and returns
`gp_age_hours`, and answers 503 when the database is unavailable. Both are open paths: they never
require the origin secret. The Vercel proxy (`web/src/lib/proxy.ts`) refuses to forward
`/api/ready`, since it's meant for direct, signed calls only (the deploy workflow's smoke test).
See `docs/deploy.md` → "Origin protection" for the IAM signing that guards the Function URL in
production.

Data: USSPACECOM via Space-Track.org; CelesTrak.
