# LEO Debris: Design Spec

**Date:** 2026-09-22 · **Author:** Kuday Yurter (with Claude) · **Status:** draft for review

## 1. Purpose

Rebuild the award-winning MATLAB app *Space Debris and Objects in LEO*
(github.com/namelessmonarch0/DebrisInLEO, 1st place; team: Brian Alino, Meena Al Hasani,
Gregory Maddox, Vedant Patel, Jessica Semaan, Kuday Yurter) as a public website at
**leo.kudayyurter.dev**.

Goals, in priority order:
1. **A real data-exploration tool.** It covers all tracked objects and all years (1957 to today), not the
   original's static 1997–2022 CSVs for three countries.
2. **A portfolio piece** that looks polished and is understandable at a glance.
3. **A place to learn applied AI/ML.** v1 has a RAG + tool-calling chatbot (LangChain/LangGraph).
   A later milestone adds an ML re-entry predictor.

### What the original did, and what changes
| Original (MATLAB) | New |
|---|---|
| CSVs for CN/RU/US, 1997–2022 | Full catalog: ~70k objects, 130 owners, 1957–today, refreshed daily |
| Counts objects by launch year | Counts by **first-seen year**. Debris is dated by breakup event or catalog entry, not by the parent's launch year (the original over-counted historic debris) |
| Globe with randomly placed dots | Live globe with real positions from orbital elements (SGP4) |
| Line and bar charts | Same charts plus launches/re-entries, regimes, breakups, distributions; animated |
| — | AI analyst: answers from the real data, cites sources, drives the globe |

### Non-goals (v1)
User accounts; ML re-entry prediction; conjunction/collision screening; re-entry prediction
feeds (T3); full orbital history (T4); historical-accurate globe positions (the historical
view shows illustrative positions and says so).

## 2. Architecture

```
┌─ leo.kudayyurter.dev (Vercel, new project) ────────────────┐
│ Next.js (App Router) + React Three Fiber + anime.js        │
│  • Globe: R3F instanced shapes; SGP4 (satellite.js) in a   │
│    Web Worker; Earth-fixed frame; real-time sun            │
│  • Charts: SVG (d3-scale/d3-shape) animated with anime.js  │
│  • Chat panel: SSE stream, applies globe commands          │
│  • /api/* route handler proxies to AWS (adds origin secret,│
│    streams SSE through, sets cache headers)                │
└──────────────────────────┬─────────────────────────────────┘
┌─ AWS us-east-2 (defined in AWS CDK, Python) ▼──────────────┐
│ Lambda "api" (container image, Function URL,               │
│   RESPONSE_STREAM): FastAPI via AWS Lambda Web Adapter     │
│   REST stats/objects/globe endpoints + POST /api/chat      │
│   LangGraph agent (LangChain chat model, provider via env) │
│ Lambda jobs via EventBridge Scheduler: ingest_satcat ·     │
│   ingest_gp · rebuild_stats · (manual) rag_ingest          │
│ S3: globe snapshots · SSM Parameter Store: secrets ·       │
│ ECR: images · CloudWatch: logs · Budgets: $5 alert         │
└──────────────────────────┬─────────────────────────────────┘
┌─ Neon Postgres (free tier, AWS us-east-2) ▼────────────────┐
│ objects · gp_elements · owners · launch_sites ·            │
│ breakup_events · yearly_stats · documents · chunks         │
│ (pgvector) · ingest_runs · rate_limits                     │
└────────────────────────────────────────────────────────────┘
Sources: Space-Track.org (primary, server-side credentials) · CelesTrak (fallback)
```

**Repo:** new monorepo `namelessmonarch0/leo-debris`: `web/`, `api/`, `infra/` (AWS CDK), `docs/`.
The portfolio repo (kudayyurter.dev) stays separate and links to the subdomain.

### Stack decisions (confirmed)
- Frontend: **Next.js + React + React Three Fiber (Three.js) + anime.js**, Tailwind v4.
- Backend: **FastAPI**, **LangChain + LangGraph**, **Postgres + pgvector (Neon)**.
- Embeddings: **fastembed `BAAI/bge-small-en-v1.5`** (384-d, local, free).
- LLM: provider-agnostic via `init_chat_model(LLM_MODEL)`. No key yet; the owner will
  pick a low-cost provider later.
- Hosting: Vercel (web); **AWS** (Lambda + Function URL, EventBridge Scheduler, S3, SSM
  Parameter Store, ECR, CloudWatch, Budgets), defined as code with **AWS CDK (Python)**;
  Neon (db, AWS us-east-2 region). Chosen so the AWS bill after the 6-month free plan
  ends stays around $0–2/month (the account must then be upgraded to a paid plan or AWS closes it).

## 3. Data

### 3.1 Sources and licensing
- **Source per feed (amended 2026-09-23 after inspecting both feeds):** SATCAT comes from
  **CelesTrak** `pub/satcat.csv` (primary). It is derived from Space-Track and adds
  operational status, orbit center and numeric RCS, which Space-Track's `satcat` class lacks. GP comes from
  **Space-Track** (primary), the only source with elements for the full on-orbit catalog.
- **Space-Track.org** (primary for GP). USSPACECOM gives blanket approval to redistribute basic SSA
  data (TLE/OMM, SATCAT, decay) **with citation**. Rate limits: under 30 requests/min and under 300/hr.
  Use bulk queries only, with GP polling at a randomized minute. Credentials stay only in
  SSM Parameter Store (SecureString) and are used only by the job Lambdas.
- **CelesTrak.** Primary for SATCAT. For GP it is a fallback only: it has no full-catalog GP (checked
  2026-09-22: `GROUP=all` is invalid, and `active` covers only ~15.8k of ~28.6k LEO objects). In fallback mode
  its elements are **upserted** (never a full replace), so debris elements are not lost.
- Required site-wide attribution: "Data: USSPACECOM via Space-Track.org; CelesTrak."

### 3.2 Tiers
- **v1:** T1 full SATCAT (daily) and T2 current GP for all on-orbit objects (every 6 h).
- **Roadmap:** T3 re-entry predictions (TIP/decay) + SOCRATES close approaches; T4
  GP_HISTORY (hundreds of millions of rows, for the ML milestone).

### 3.3 Scope
Ingest **all** objects and regimes. The UI and agent default to LEO. A regime filter exposes
MEO/GEO/HEO. Regime rules: LEO = apogee < 2,000 km; GEO = perigee 35,000–36,500 km;
MEO = perigee ≥ 2,000 km and not GEO; HEO = perigee < 2,000 km and apogee ≥ 2,000 km;
OTHER = non-Earth-centered or missing orbit data. No catalog-number exclusion: the public catalog runs
1–69,999 and then continues at 100,000+ (Alpha-5/6-digit era; e.g. 100000 is a 2026 payload).

### 3.4 Schema
```
objects          norad_id PK, cospar_id, name, object_type (PAY|R/B|DEB|UNK), ops_status,
                 owner→owners.code, launch_date, launch_site→launch_sites.code, decay_date,
                 period, inclination, apogee, perigee, rcs_size (SMALL|MEDIUM|LARGE|NULL),
                 regime, orbit_center, parent_cospar (first 8 chars of cospar_id),
                 event_id→breakup_events.id NULL, first_seen_year, updated_at
gp_elements      norad_id PK→objects, epoch, mean_motion, eccentricity, inclination, raan,
                 arg_pericenter, mean_anomaly, bstar, mean_motion_dot, mean_motion_ddot,
                 fetched_at
owners           code PK, name, country_iso NULL, flag_emoji NULL
launch_sites     code PK, name, country, lat NULL, lon NULL
breakup_events   id PK, parent_cospar, name, event_date, kind (ASAT|COLLISION|EXPLOSION|UNKNOWN),
                 description, source_url                 -- curated seed, 10 events in v1
yearly_stats     year, owner, object_type, regime, in_orbit, added, reentered
                 PK(year, owner, object_type, regime)    -- rebuilt after each ingest
documents        id, title, source, url, published_at, license
chunks           id, document_id→, ord, content, embedding vector(384), tsv tsvector,
                 metadata jsonb; HNSW(embedding), GIN(tsv)
ingest_runs      id, job, source, started_at, finished_at, rows, status, error
rate_limits      key, window_start, count                -- chat limits across instances
```

### 3.5 Derived-year rule (key correctness fix)
`first_seen_year = max(launch_year, catalog_year(norad_id))`. `catalog_year` is the running
max of payload launch dates ordered by NORAD id, since catalog numbers are assigned in order.
An object is linked to a breakup event when it is DEB, its `parent_cospar` matches, and its
catalog year is ≥ the event year − 1 (catalog numbers lag launches by up to a year: the first
Fengyun-1C fragments, cataloged in early 2007, sit right after payloads launched in December 2006);
then `first_seen_year = year(event_date)`.
If `decay_date` is set, `first_seen_year` is clamped to ≤ the decay year (late-cataloged objects).
**In orbit at the end of year Y** means `first_seen_year ≤ Y AND (decay_date IS NULL OR year(decay_date) > Y)`.
Validation reference (measured 2026-09-23 from the live CelesTrak SATCAT, LEO only, with
event linking applied): debris in orbit was 4,180 (2006), 7,733 (2007), 10,240 (2009);
payloads overtook debris in 2024 (11,895 payloads vs 10,533 debris). Linked breakup-event
fragment counts: Fengyun-1C 3,533, Kosmos 1408 1,805, Cosmos 2251 1,714 — each dated to its
event year rather than its (later) catalog year, per the derivation rule above.

### 3.6 Ingest jobs
| Job | Schedule | Behavior |
|---|---|---|
| `ingest_satcat` | daily | 1 bulk Space-Track query, parse with Polars, upsert objects, derive fields |
| `ingest_gp` | every 6 h at a random minute | 1 bulk query for on-orbit GP, replace gp_elements, write the globe snapshot |
| `rebuild_stats` | after each ingest | Recompute yearly_stats in one transaction |
| `rag_ingest` | manual | Fetch corpus, extract, chunk, embed, upsert |

Every job runs in one transaction, so a failure keeps the last good data. Each run is logged to `ingest_runs`.
If Space-Track has failed for more than 24 h, fall back to CelesTrak.

### 3.7 Globe snapshot
LEO objects (default) plus a separate MEO/GEO file. Per object: norad_id, type code, owner
index and the SGP4 inputs. Packed binary (Float32/Uint32 arrays) + gzip, ~2 MB for LEO. Written to S3 by
`ingest_gp`. `/api/globe/snapshot` streams it with an ETag, and the Vercel proxy caches it for 6 h.

## 4. API (FastAPI)

All routes are under `/api`, reached from the browser through a Next.js route-handler proxy
(`web/app/api/[...path]/route.ts`). The proxy forwards to the Lambda Function URL with an
`X-Origin-Auth` shared secret, and the API rejects requests without it, so the Function URL is not a
public back door. SSE responses are streamed through untouched. Input is Pydantic-validated.
Errors use the shape `{error:{code,message}}`.

| Endpoint | Purpose | Cache |
|---|---|---|
| `GET /meta` | data-as-of timestamps, totals, lists of owners/types/regimes | 10 min |
| `GET /globe/snapshot?regime=LEO` | packed elements | CDN 6 h |
| `GET /stats/timeseries` | `metric=in_orbit|added|reentered`, `group_by=type|owner|regime`, filters `owners,types,regimes,from,to` | 1 h |
| `GET /stats/breakdown` | `at=YYYY`, `by=owner|type|regime`, filters | 1 h |
| `GET /stats/distribution` | `field=perigee|apogee|inclination|rcs_size`, filters | 1 h |
| `GET /events` | breakup events + pieces created / still in orbit | 1 h |
| `GET /objects/{norad_id}` · `GET /objects/search?q=` | details / search | 10 min |
| `POST /chat` | agent, SSE | none |
| `GET /health` | liveness, DB check, ingest age | none |

The API also runs locally with plain `uvicorn` for development. REST handlers and agent tools share one service layer (`api/app/services/`), so chat
answers and charts come from identical queries.

## 5. AI analyst

### 5.1 Agent
A LangGraph `StateGraph` with an agent ⇄ tools loop and at most 6 tool steps per turn. The model comes from
`init_chat_model(os.environ["LLM_MODEL"])`. If no model or key is configured, `/chat` returns 503
`chat_offline`. The system prompt keeps the agent on topic (debris, orbits, dataset, space
policy) and requires numbers to come from tools and facts from retrieved sources.

### 5.2 Tools (typed, parameterized SQL only, never free-form text-to-SQL)
| Tool | Result |
|---|---|
| `count_objects(owners?, types?, regimes?, launched_between?, in_orbit_on?, group_by?)` | counts |
| `time_series(metric, owners?, types?, regimes?, years, group_by?)` | series; also emits a `chart` event |
| `get_object(name_or_norad)` | details |
| `list_breakup_events(...)` | events + remaining pieces |
| `search_knowledge(query)` | hybrid RAG: pgvector + full-text, RRF fusion, top 5 with citations |
| `globe_filter(...)`, `globe_focus(norad_id or parent_cospar)`, `globe_set_time(date)` | emit a `globe` command event (UI side effect) |

### 5.3 Streaming protocol (SSE)
`token` · `status` · `globe` {command} · `chart` {spec} · `citations` [...] · `error` · `done`

### 5.4 Knowledge corpus
NASA ODPO Orbital Debris Quarterly News + FAQ (public domain); ESA Space Environment Report
(cited); IADC mitigation guidelines; Wikipedia (CC BY-SA) on the Kessler syndrome, Fengyun-1C,
Iridium–Cosmos and Kosmos 1408; the original MATLAB project text. Chunks are ~800 tokens with overlap,
embedded with fastembed. Each chunk stores its source URL and license.

### 5.5 Abuse and cost controls
Per-IP limit of 20 messages/hour and a global daily cap (Postgres `rate_limits`); inputs up to 1,000 characters; capped
output tokens. The server stores no chat history; the client sends the last 8 turns.

### 5.6 Evaluation
~30 questions with known answers. Tool-level correctness always runs in pytest.
End-to-end answer quality runs when a key is present, with optional LangSmith tracing.

## 6. Frontend

### 6.1 Decided
- Pages: `/` explorer (full-screen globe + panels), `/about` (original project, team,
  award, methodology, data attribution), link back to kudayyurter.dev.
- **Visual direction: black and clean, cartoonish but professional.** Sticker-like cards
  (2px borders, hard offset shadows), custom 8×8 **pixel icons**, **Departure Mono** (OFL,
  self-hosted with `next/font/local`) for numbers and labels, a clean sans (Inter Tight) for body text.
- **Globe look:** flat cartoon Earth with two colors (ocean and land from Natural Earth coastlines),
  ink coastlines and a rim glow. **Terminator from the real Sun** (NOAA subsolar formulas,
  Earth-fixed frame), with a smooth, graduated, lightly dithered twilight band (~18°).
  An optional subtle post-process ordered dither + grain (style reference:
  x.com/_madebygray/status/2101463932158566699).
- **Object shapes by type:** satellite (body + panels), rocket body (cylinder + cone),
  debris (tumbling jagged shard). Screen size grows as the camera zooms in
  (`size ∝ dist^0.55`), so shapes become readable up close.
- **Color by entity, fixed everywhere:** payload `#3987e5`, debris `#d95926`,
  rocket body `#199e70` (colorblind-validated all-pairs on the dark surface).
- **Charts:** titled with the takeaway; direct end labels plus a legend; event annotations
  (2007, 2009, 2019, 2021); hover crosshair/tooltips; draw-in on scroll with anime.js.
- **Motion:** anime.js for everything: intro stagger, counters, chart draw-in, camera
  fly-tos (incl. agent `globe_focus`), highlight pulses, drag inertia.
- **Globe engine:** R3F (InstancedMesh per type; SGP4 in a Web Worker transferring a
  Float32Array ~10 Hz; interpolation on the main thread), styled flat like the 2D mock.
  Fallback if WebGL is unavailable: charts-only view.
- State: a single Zustand store (filters, time, selection, chat) shared by the UI, globe and agent
  commands.

### 6.2 Decided 2026-09-23 (were open)
- **Globe engine:** Three.js via React Three Fiber, styled flat like the 2D mock (no 2D fallback globe).
- **Palette:** Classic — ocean `#2f6fd6`, land `#7fd06b`, coastline ink `#0d1b2e`.
- **Shading and dither:** flat day side, darker night side, and a smooth ~18° twilight band drawn with
  an ordered (Bayer) dither in the Earth shader (as in globe-2d-smooth.html); plus a *subtle* full-screen
  ordered-dither + grain post-process (cell 2 px, 7 levels, grain 0.09).
- **Type:** Departure Mono for labels, numbers and headings; Inter Tight for body text and chat answers.
Prototypes remain in `.superpowers/brainstorm/` (globe-sun.html, globe-anime.html, globe-2d-smooth.html).

## 7. Error handling
- API: 422 for invalid filters (readable message); 404 for unknown objects; 503
  `chat_offline`; 429 with `Retry-After` for rate limits; tool failures become an SSE `error` and
  the agent says it could not fetch the data, never invents it.
- Ingest: all-or-nothing transactions; last good data is served; staleness shows in `/meta`
  and the UI ("data as of …").
- Web: an error boundary around the globe; skeleton states for charts; the chat shows offline and
  rate-limit states.

## 8. Testing
- **api (pytest):** parser tests against saved Space-Track/CelesTrak samples; first-seen-year
  and in-orbit math against hand-computed cases (parent-launch debris, single-year range,
  decay in the same year); endpoint tests on testcontainers Postgres + pgvector; agent tools
  with a scripted fake LLM (no key); the eval set when a key is present.
- **web:** Vitest for data transforms and SGP4 propagation (reference position check);
  Playwright smoke test (globe canvas renders, charts render, object card opens).
- **CI:** GitHub Actions runs lint, type checks and both suites on PRs.

## 9. Deployment
- Vercel project for `web/`, domain `leo.kudayyurter.dev`. The owner adds a CNAME
  `leo → cname.vercel-dns.com` at the external registrar. Vercel env: `API_ORIGIN_URL`
  (Function URL), `ORIGIN_SECRET`.
- AWS (us-east-2), all in one CDK app (`infra/`):
  - ECR repository; a single container image (`api/Dockerfile`, Lambda Web Adapter,
    fastembed model files baked in to avoid cold-start downloads) with different handlers/commands
    for the API and the jobs.
  - Lambda `api`: 1,024 MB, 60 s timeout (chat streaming), Function URL with `RESPONSE_STREAM`,
    reserved concurrency 10 (caps runaway cost).
  - Lambda `ingest_satcat`, `ingest_gp`, `rebuild_stats`, `rag_ingest`: 1,536 MB, 10 min timeout;
    EventBridge Scheduler rules (daily; every 6 h at a random minute; chained stats rebuild).
  - S3 bucket for snapshots; SSM SecureStrings `/leo/DATABASE_URL`, `/leo/SPACETRACK_USER`,
    `/leo/SPACETRACK_PASS`, `/leo/ORIGIN_SECRET`, later `/leo/LLM_MODEL` + provider key.
  - CloudWatch log retention of 14 days; AWS Budgets alert at $5/month.
- CI/CD: GitHub Actions assumes an IAM role via **OIDC** (no stored AWS keys), builds and pushes
  the image, then runs `cdk deploy`.
- Neon free tier (0.5 GB; expected usage 60–80 MB), AWS us-east-2 region, pooled connection
  string (Lambda-friendly).
- Owner one-time setup: AWS account (done) + Budgets alert confirmation, CDK bootstrap,
  Neon account, DNS record. Step-by-step instructions are included in the plan.
- **6-month reminder:** before the AWS free plan ends, upgrade the account to a paid plan
  (expected cost of about $0–2/month) or it will be closed.

### Deploy plan decisions (2026-09-23)
- One `api/Dockerfile` with two targets (`api` with the Lambda Web Adapter, `jobs` with
  `awslambdaric`), because the web-adapter extension can't share an image with the plain
  runtime client.
- One `leo-jobs` function, driven by `{"job": ...}` events, instead of one Lambda per job.
- CI builds into the ECR repository `leo-api` (keeps the newest 10 images); Neon migrations
  run through the `migrate` job rather than a separate deploy step.
- `LeoRegistryStack` grants `lambda.amazonaws.com` `ecr:BatchGetImage` and
  `ecr:GetDownloadUrlForLayer` on the repository, scoped by a `StringLike` condition on
  `aws:sourceArn` (`arn:aws:lambda:<region>:<account>:function:*`, AWS's documented form for
  this grant), because `LeoApp` imports the repo by name and CDK cannot otherwise attach the
  Lambda image-pull grant to it.
- A `leo-jobs-errors` CloudWatch alarm, notifying by email via SNS.
- `leo-api` reserved concurrency is set by CDK context (`api_reserved_concurrency`, default
  10), because new AWS accounts are limited to 10 concurrent executions; the account quota
  needed is 110 (100 unreserved + the 10 reserved), not 100.
- The AWS Budget excludes credits (`CostTypes.IncludeCredit = False`), so the $5 alert still
  fires on real spend while the AWS free plan's credits are covering the bill.
- GitHub Actions reads `ALERT_EMAIL` from a repository **secret**, not a variable — this repo
  is public, and Actions variables (unlike secrets) are visible to anyone who can see it.
  `AWS_DEPLOY_ROLE_ARN` stays a variable, since a role ARN isn't sensitive.
- `web/vercel.json` pins the Vercel project's function region to `cle1` (Cleveland), next to
  the API in AWS us-east-2 (Ohio), via the top-level `regions` setting — not the Next.js
  `preferredRegion` route export, which is deprecated in Next 16. Its `ignoreCommand` diffs
  against `$VERCEL_GIT_PREVIOUS_SHA` (not always the last commit), so an empty or missing SHA
  fails the diff and safely proceeds with the build rather than skipping it.
- fastembed, `rag_ingest` and LLM parameters move to the AI plan (out of scope for this
  deploy).

## 10. Build order
1. **Data:** schema + migrations (Alembic), ingest jobs, stats, REST API, tests.
2. **Web:** globe and charts on real API data.
3. **Deploy:** subdomain, AWS CDK stack (Lambda, schedulers, S3, SSM), CI/CD.
4. **AI:** RAG corpus + LangGraph agent + SSE chat (works up to the LLM call without a key).
   (order swapped by the owner, 2026-09-23)
5. **Polish:** resolve §6.2, anime.js choreography, About page.

## 11. Roadmap (post-v1)
T3 feeds (re-entries this week, top close approaches); T4 history + **ML re-entry
predictor** (Python service, compared against physics-only estimates); historical globe
replays; saved views (would need auth).
