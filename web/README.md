# Kessler: web

Next.js explorer for kessler.kudayyurter.dev. Design: `../docs/superpowers/specs/2026-09-22-leo-debris-design.md` §6.

## Local development

```bash
# 1. Start the data API with data (see ../api/README.md)
cd ../api && docker compose up -d db && uv run python -m app.jobs all
uv run uvicorn app.api.main:create_app --factory --port 8000
# 2. In another terminal
cd web && cp .env.example .env.local && npm install && npm run dev
```

Open http://localhost:3000. The browser only calls `/api/*` on the same origin; `src/app/api/[...path]/route.ts` forwards to `API_ORIGIN_URL`.

## Tests

| Command | What |
|---|---|
| `npm test` | Unit tests (Vitest): proxy, API client, snapshot decoder, SGP4 + Sun maths, store, chart helpers |
| `npm run e2e` | Playwright against `next dev` with a mocked API |
| `npm run lint && npm run typecheck` | ESLint + TypeScript |

Data: USSPACECOM via Space-Track.org; CelesTrak.

## Deploying (Vercel)

The Vercel project `kessler` builds this folder: **Root Directory** `web`, framework **Next.js**. It needs two environment variables (Production and Preview):

- `API_ORIGIN_URL`: the `kessler-api` Lambda Function URL, without a trailing slash (CloudFormation output `KesslerApp.ApiFunctionUrl`).
- `ORIGIN_SECRET`: the same value as SSM `/kessler/ORIGIN_SECRET`.

`vercel.json` pins functions to `cle1` (next to AWS us-east-2) and skips builds when nothing under `web/` changed since the last deployment.
