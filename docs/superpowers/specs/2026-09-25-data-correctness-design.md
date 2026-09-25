# Data correctness: monotonic elements and atomic globe snapshots

Date: 2026-09-25. Status: design approved by the owner in conversation; this spec awaits their review.

Piece 1 of 5 from the repository audit of 2026-09-25 (`/tmp/kessler-repo-audit.md`, reviewed commit
`d465e0a`): audit findings #1 (older orbital elements overwrite newer ones) and #3 (failed snapshot publication
leaves mixed data versions). The other pieces: (2) origin protection, (3) freshness and error states,
(4) filters and selection, (5) accessibility and mobile — each gets its own spec, plan and build.

## Why

- **#1:** `write_gp` (api/app/ingest/gp.py) upserts without comparing epochs, so a CelesTrak fallback record
  older than the stored Space-Track one replaces it; the Space-Track path also `DELETE`s the whole table before
  inserting, so no comparison is possible there either. Positions silently degrade while the ingest "succeeds".
- **#3:** the database commits, then `write_snapshots` overwrites `globe/LEO.bin.gz` and `globe/HIGH.bin.gz` one
  after the other. A failure between them leaves a new LEO and an old HIGH. Two further gaps found while
  designing: the Vercel edge caches each group's snapshot separately for up to 6 h (`s-maxage=21600`), so
  browsers can receive mixed generations even when S3 is consistent; and `/api/globe/names` reads the live
  database, so labels can disagree with the snapshot being drawn.

## Design

### 1. Never overwrite newer elements (#1)

- Upsert only when the incoming epoch is strictly newer:
  `ON CONFLICT (norad_id) DO UPDATE SET … WHERE gp_elements.epoch < EXCLUDED.epoch`. Equal epochs are the same
  element set; the stored row is kept.
- Space-Track full-catalog runs (`replace=True`) no longer delete the table. They delete only rows whose NORAD
  ID is absent from the incoming payload (objects re-entered or no longer tracked), then apply the guarded
  upsert. CelesTrak fallback runs stay upsert-only (no deletes).
- The row floor moves from "rows written" to "incoming records matching known objects" (`gp_in` rows whose
  `norad_id` is in `objects`), checked before any delete. A short or garbage payload is still refused with the
  table untouched. (With the guard, rows written drops to only changed rows, so the old check would falsely
  fail.)
- `write_gp` takes `pg_advisory_xact_lock` on a fixed key inside its transaction, serialising overlapping GP
  ingests (a manual run and a scheduled one).
- Counts: `write_gp` returns rows inserted or updated ("written"); the run log additionally records how many
  incoming records matched the catalog. `ingest_runs.rows` keeps the written count.
- Consistent with the history archive, which already treats "epoch strictly newer than stored" as new.

### 2. Snapshots switch atomically (#3)

- **Generations.** Each GP ingest builds a generation `YYYYMMDDTHHMMSSZ-r<run id>` (UTC run start; run id from
  `ingest_runs`) and writes, all from the same database read:
  - `globe/gen/<gen>/LEO.bin.gz`, `globe/gen/<gen>/HIGH.bin.gz` (the existing LEO1 format),
  - `globe/gen/<gen>/names-LEO.json.gz`, `globe/gen/<gen>/names-HIGH.json.gz` (NORAD ID → name, same object
    filter as the snapshot, i.e. exactly the drawn objects).
  Generation files are never modified after being written.
- **Pointer.** Only after all four files are written, the job overwrites `globe/current.json`:
  `{"generation": "<gen>", "generated_at": "<ISO UTC>", "groups": {"LEO": {"count": n}, "HIGH": {"count": n}}}`.
  That single PUT is the switch. Any failure before it leaves the pointer on the previous complete generation;
  the run is logged failed and the jobs alarm fires. Consistency boundary (explicit): the site serves the last
  complete generation; the database may be newer until the next successful run republishes.
- **Cleanup.** After switching the pointer, the job deletes generations other than the current and the one
  before it (listed via `SnapshotStore.keys("globe/gen/")`). No S3 lifecycle rule: an expiry could delete the
  live generation if ingest stalled. `SnapshotStore` gains `delete(key)` (local and S3). The legacy
  `globe/LEO.bin.gz` / `globe/HIGH.bin.gz` keys are no longer written; after the first generation is live the
  job deletes them once (idempotent: missing keys are ignored).
- **API** (api/app/api/routes.py):
  - `GET /api/globe/current` → the pointer JSON; `Cache-Control: public, max-age=60, s-maxage=60`; 404 when no
    generation exists yet.
  - `GET /api/globe/snapshot?group=LEO|HIGH&gen=<gen>` and `GET /api/globe/names?group=LEO|HIGH&gen=<gen>` →
    that generation's file; `Cache-Control: public, max-age=31536000, immutable`; ETag = generation + group;
    404 for an unknown generation. `gen` is validated against `^\d{8}T\d{6}Z-r\d+$`.
  - Without `gen`, both serve the current generation with `Cache-Control: public, max-age=60, s-maxage=300`,
    so tabs still running the previous frontend keep working through the deploy. `/names` without `gen` keeps
    its response shape `{"generated_at", "names"}`.
  - `/api/globe/names` no longer queries the database; `app/services/globe.py`'s `globe_names` moves into the
    ingest (used to build the names files).
- **Frontend:** `api.current()`; `api.snapshot(group, gen)`; `api.names(group, gen)`. `GlobeSection` fetches
  `/current` first, then that generation's snapshots; the name cache is keyed by generation. No refresh or
  stale-data UI here — piece 3 builds on `/current` for that.
- **Deploy order.** The API change ships before the first generation exists: `/current` returns 404 and the
  un-versioned endpoints fall back to the legacy keys until a generation is published. The frontend treats a
  404 from `/current` as "use the un-versioned endpoints".

## Units

- `api/app/ingest/gp.py`: guarded upsert, targeted delete, matched-count floor, advisory lock.
- `api/app/ingest/snapshot.py`: `generation_id`, generation/pointer keys, `publish_generation(conn, store,
  generated_at, run_id)` (build four files → pointer → cleanup), names building; `SnapshotStore.delete`.
- `api/app/aws.py`: `S3SnapshotStore.delete`.
- `api/app/api/routes.py`: `/globe/current`; generation-aware `/globe/snapshot` and `/globe/names`.
- `web/src/lib/api.ts`, `web/src/lib/names.ts`, `web/src/components/globe/GlobeSection.tsx`: pointer-first
  loading.

## Testing

- Ingest (testcontainers Postgres): an older CelesTrak record does not replace a newer Space-Track one; a newer
  one does; equal epochs keep the stored row; a Space-Track run deletes only missing IDs; a short payload is
  refused before any delete; two runs serialised by the lock (second waits, both end consistent); written and
  matched counts reported.
- Publication (local store): a failure writing any of the four files leaves `globe/current.json` and the
  previous generation untouched and fails the run; the pointer switches only after all four exist; cleanup
  keeps current + previous and removes older; names files contain exactly the snapshot's IDs.
- API: `/globe/current` 404 then 200; versioned snapshot/names return the generation's bytes with immutable
  caching and 404 for unknown or malformed `gen`; un-versioned endpoints serve the current generation, and the
  legacy keys when no generation exists; `/names` no longer touches the database.
- Web (vitest): pointer-first loading, fallback to un-versioned endpoints on a 404 pointer, name cache keyed by
  generation. Existing e2e suite stays green (fixtures updated for `/current`).

## Out of scope

Tab refresh and data-age UI (piece 3); origin authentication (piece 2); any change to the LEO1 binary format.
