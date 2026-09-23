# LEO Debris API

FastAPI + Postgres backend for leo.kudayyurter.dev. Design: `../docs/superpowers/specs/2026-09-22-leo-debris-design.md`.

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
| `python -m app.jobs ingest-satcat` | CelesTrak SATCAT → `objects`, then rebuilds `yearly_stats` | daily |
| `python -m app.jobs ingest-gp` | Space-Track GP (CelesTrak fallback) → `gp_elements` + globe snapshots | every 6 h, random minute |
| `python -m app.jobs rebuild-stats` | Recomputes `yearly_stats` from `objects` | after SATCAT |
| `python -m app.jobs all` | All of the above | — |

Every run is recorded in `ingest_runs`. A failed run never replaces good data.

## Tests

`uv run pytest` (needs Docker for testcontainers, or set `TEST_DATABASE_URL` to an empty database).

Data: USSPACECOM via Space-Track.org; CelesTrak.
