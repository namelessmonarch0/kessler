# Orbit-history archive (GP history recorder)

Date: 2026-09-25. Status: design approved by the owner in conversation; this spec awaits their review.

Part 1 of 4 in the analysis roadmap agreed on 2026-09-25: (1) this history recorder, (2) crowding by altitude
and inclination, (3) breakup aftermath (survival curves, Gabbard diagrams), (4) orbital lifetime and disposal
compliance. Each part gets its own spec, plan and build.

## Why

`ingest-gp` fetches the latest element set (GP/OMM) for every on-orbit object from Space-Track every 6 hours and
replaces `gp_elements`, so the history of how each orbit changes is thrown away. Later work needs it: decay
tracking, manoeuvre and breakup detection, and the ML re-entry predictor on the roadmap. History not recorded now
is expensive to recover later, so recording starts now.

## Scope

- In: record every new element set from each `ingest-gp` run, from deployment onward; a reader for date ranges.
- Out (owner decision): a multi-year backfill of past history. It is a later, separate piece; the layout below is
  designed so a bulk import lands in the same tree with a different source tag. Constraint on that future work:
  its files must be placed in per-epoch-day folders, ordered by epoch, with keys that sort before that day's live
  files (e.g. a `000000Z-` prefix) -- otherwise the reader's "later than last yielded" rule drops its in-between
  element sets, since the recorder assumes archive order tracks epoch order within a NORAD ID. The alternative is
  to change the reader before that import lands.
- Out: anything visible on the site; changes to schedules, Lambdas or infrastructure.

## Design

### Flow (inside `run_ingest_gp`, `api/app/ingest/gp.py`)

1. Fetch as today (Space-Track, or the CelesTrak fallback). Keep the raw records next to the parsed ones.
2. Select new element sets: a raw record is new when its epoch is later than the epoch stored in `gp_elements` for
   that NORAD ID, or the ID has no row there. Baseline rule: when the archive holds no files yet (a fresh deploy,
   checked via `store.keys(HISTORY_PREFIX)`), the run is a baseline and every well-formed record counts as new
   regardless of `gp_elements` -- by deploy time `gp_elements` is already populated, so the plain "epoch later than
   stored" rule alone would silently skip every object whose epoch hasn't changed since deploy. Malformed records
   are still skipped and counted even in a baseline run. Once any archive file exists, the normal rule applies.
   Records for IDs unknown to `objects` (typically new launches) are archived too; until SATCAT
   catches up they are re-archived every run, and the reader drops the repeats.
3. Write the archive file for the run (only the new records). A run with no new records still writes an empty
   file, so every run leaves a trace. Records whose NORAD ID or epoch cannot be parsed are not archived (the
   ingest already skips them) and are counted in the log.
4. Then write `gp_elements` and the globe snapshots exactly as today.

Ordering rule: archive first. If step 3 fails, the run fails before touching the database (the site keeps its
last good data, the run is logged failed, the existing `kessler-jobs-errors` alarm fires) and the next run
retries with the same differences, so no history is lost. If step 4 fails after step 3 succeeded, the next run
archives the same records again; duplicates are rare and the reader removes them.

### Storage

- Existing snapshot bucket (removal policy RETAIN), prefix `history/`, written through the existing
  `SnapshotStore` (S3 in production, a local directory in development and tests).
- Key: `history/gp/YYYY/MM/DD/HHMMSSZ-<source>-r<run id>.jsonl.gz` in UTC, from the run start time and the
  `ingest_runs` id, e.g. `history/gp/2026/09/25/064112Z-spacetrack-r1234.jsonl.gz`. The run id makes keys unique
  even when two runs start in the same second. Sources: `spacetrack`, `celestrak`; a future bulk import uses
  `spacetrack-history`.
- Content: gzip JSON Lines, one element set per line, exactly as received: every field the source sent,
  including TLE lines and Space-Track's per-element-set `GP_ID`; nothing renamed or dropped (CelesTrak CSV rows
  are written as JSON objects of their columns).
- Expected size: ~1–3 MB per run, ~2–3 GB per year (a few cents per month).

### Units

- `api/app/history/archive.py`: select new records (step 2), encode the file, compute the key, write it.
- `api/app/history/read.py`: `read_history(store, start, end)` yields records in a UTC date range (inclusive
  days) in key order, deduplicated per object: a record is yielded only if its epoch is later than the last one
  yielded for that NORAD ID. The recorder only ever archives epochs newer than the stored one, so repeats (retries,
  unknown objects re-archived) always carry an epoch already seen; memory stays one entry per object. `start`/`end`
  are the days records were *archived* on, not their epochs (a file can hold epochs weeks old); dedupe is per call
  only, not persisted across calls.
- `python -m app.history dump --from YYYY-MM-DD --to YYYY-MM-DD`: prints JSON Lines to stdout for exploration.
- `SnapshotStore` gains a `keys(prefix)` method returning sorted keys (S3 and local implementations) for the
  reader.

### Monitoring

- `run_ingest_gp` returns `GpIngestResult(written, archived)`; the job result reports both, e.g.
  `{"ingest_gp": 30112, "archived_gp": 18450}`, and the run logs it.
- Failures surface through the existing jobs error alarm; no new alarm.

## Testing

On the existing testcontainers Postgres and local store:

- First run archives every record; a repeat with the same epochs archives nothing; one changed epoch archives
  exactly that record; unknown NORAD IDs are archived.
- Baseline run on an empty archive with a populated `gp_elements` (the production post-deploy situation): every
  well-formed record is archived regardless of its stored epoch.
- A failing archive write leaves `gp_elements` unchanged and logs the run as failed.
- CelesTrak fallback files carry the `celestrak` tag.
- Reader: round-trips a file with every raw field intact; drops duplicates; respects the date range (inclusive
  days, UTC); tolerates an empty range and empty files.
- Two runs starting in the same second write two files; epochs written in different string formats for the same
  instant compare equal; malformed records are skipped, not fatal.
- S3 store `keys`/`put`/`get` against moto.

## Deployment

Code only: the jobs image ships through the existing GitHub Actions deploy. After deploying, check that the first
scheduled run wrote a baseline file under `history/gp/` and that the following run's file is smaller (only
changed element sets).
