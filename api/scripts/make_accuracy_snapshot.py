#!/usr/bin/env python3
"""Generate snapshot fixture for web accuracy tests."""
import json
from datetime import UTC, datetime
from pathlib import Path

from app.ingest.snapshot import pack_snapshot

# Define the three test rows
ROWS = [
    # ISS row
    {
        "norad_id": 25544,
        "owner": "ISS",
        "object_type": "PAY",
        "epoch": datetime(2026, 9, 22, 6, 30, 37, 496000, tzinfo=UTC),
        "mean_motion": 15.49224498,
        "eccentricity": 0.00047657,
        "inclination": 51.6312,
        "raan": 179.6046,
        "arg_pericenter": 167.6102,
        "mean_anomaly": 192.5004,
        "bstar": 0.0001364276,
        "mean_motion_dot": 0.00007132,
        "mean_motion_ddot": 0.0,
    },
    # GEO row
    {
        "norad_id": 29710,
        "owner": "INSAT-4B",
        "object_type": "PAY",
        "epoch": datetime(2026, 9, 22, 6, 30, 37, 496000, tzinfo=UTC),
        "mean_motion": 1.00271,
        "eccentricity": 0.0002,
        "inclination": 0.05,
        "raan": 45.0,
        "arg_pericenter": 90.0,
        "mean_anomaly": 180.0,
        "bstar": 0.00000001,
        "mean_motion_dot": 0.0,
        "mean_motion_ddot": 0.0,
    },
    # Decayed debris row
    {
        "norad_id": 12345,
        "owner": "DECAYED",
        "object_type": "DEB",
        "epoch": datetime(2026, 9, 22, 6, 30, 37, 496000, tzinfo=UTC),
        "mean_motion": 13.5,
        "eccentricity": 0.05,
        "inclination": 75.0,
        "raan": 120.0,
        "arg_pericenter": 45.0,
        "mean_anomaly": 270.0,
        "bstar": 0.01,
        "mean_motion_dot": 0.00001,
        "mean_motion_ddot": 0.0,
    },
]


def main():
    # Pack the snapshot
    generated_at = datetime(2026, 9, 22, tzinfo=UTC)
    snapshot_data = pack_snapshot(ROWS, generated_at)

    # Write the binary snapshot fixture
    fixture_dir = Path(__file__).parent.parent.parent / "web" / "tests" / "fixtures" / "accuracy"
    fixture_dir.mkdir(parents=True, exist_ok=True)

    snapshot_path = fixture_dir / "api-snapshot.bin.gz"
    snapshot_path.write_bytes(snapshot_data)
    print(f"Wrote {snapshot_path}")

    # Write the elements fixture as web OrbitRecords
    elements = [
        {
            "noradId": row["norad_id"],
            "owner": row["owner"],
            "type": row["object_type"],
            "epochMs": row["epoch"].timestamp() * 1000,
            "meanMotion": row["mean_motion"],
            "eccentricity": row["eccentricity"],
            "inclination": row["inclination"],
            "raan": row["raan"],
            "argPericenter": row["arg_pericenter"],
            "meanAnomaly": row["mean_anomaly"],
            "bstar": row["bstar"],
            "meanMotionDot": row["mean_motion_dot"],
            "meanMotionDdot": row["mean_motion_ddot"],
        }
        for row in ROWS
    ]

    elements_path = fixture_dir / "api-snapshot.elements.json"
    elements_path.write_text(json.dumps(elements, indent=2))
    print(f"Wrote {elements_path}")


if __name__ == "__main__":
    main()
