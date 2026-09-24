import psycopg

from app.ingest.snapshot import SNAPSHOT_GROUPS


def globe_names(conn: psycopg.Connection, group: str) -> dict[str, str]:
    """NORAD id -> name for the objects in a group's globe snapshot (same filter as
    write_snapshots: on orbit, has GP elements, regime in the group)."""
    rows = conn.execute(
        """
        SELECT o.norad_id, o.name
        FROM gp_elements g JOIN objects o USING (norad_id)
        WHERE o.decay_date IS NULL AND o.regime = ANY(%s)
        ORDER BY o.norad_id
        """,
        (list(SNAPSHOT_GROUPS[group]),),
    ).fetchall()
    return {str(r["norad_id"]): r["name"] for r in rows}
