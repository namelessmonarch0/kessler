# LEO Debris: web

Next.js explorer for leo.kudayyurter.dev. Design: `../docs/superpowers/specs/2026-09-22-leo-debris-design.md` §6.

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
