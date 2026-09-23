from collections import defaultdict

import psycopg

from app.domain.orbits import ATTRIBUTION, OPS_STATUS_LABELS, REGIME_LABELS, TYPE_LABELS

JOB_KEYS = {"ingest_satcat": "satcat", "ingest_gp": "gp", "rebuild_stats": "stats"}


def get_meta(conn: psycopg.Connection) -> dict:
    runs = {
        r["job"]: r["at"]
        for r in conn.execute(
            "SELECT job, max(finished_at) AS at FROM ingest_runs WHERE status = 'ok' GROUP BY job"
        ).fetchall()
    }
    in_orbit: dict[str, dict[str, int]] = defaultdict(dict)
    for r in conn.execute(
        "SELECT object_type, regime, count(*)::int AS n FROM objects "
        "WHERE decay_date IS NULL GROUP BY 1, 2"
    ).fetchall():
        in_orbit[r["object_type"]][r["regime"]] = r["n"]
    owners = conn.execute(
        """
        SELECT ow.code, ow.name, ow.flag_emoji,
               count(o.norad_id) FILTER (WHERE o.decay_date IS NULL)::int AS in_orbit,
               count(o.norad_id)::int AS total
        FROM owners ow JOIN objects o ON o.owner = ow.code
        GROUP BY ow.code
        ORDER BY in_orbit DESC, total DESC, ow.code
        """
    ).fetchall()
    return {
        "data_as_of": {key: runs.get(job) for job, key in JOB_KEYS.items()},
        "in_orbit": dict(in_orbit),
        "owners": owners,
        "types": TYPE_LABELS,
        "regimes": REGIME_LABELS,
        "ops_status": OPS_STATUS_LABELS,
        "attribution": ATTRIBUTION,
    }
