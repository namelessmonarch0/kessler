"""Generate the frozen SGP4 verification-vector fixture from the Vallado test
set shipped inside the `sgp4` package (SGP4-VER.TLE). Run once by hand; commit
the output. Propagates with `sgp4.api.Satrec.twoline2rv`, mode 'i' (the
default operation mode, matching satellite.js).
"""
import importlib.metadata
import importlib.resources
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sgp4.api import Satrec

OUT = (
    Path(__file__).resolve().parents[2]
    / "web"
    / "tests"
    / "fixtures"
    / "accuracy"
    / "sgp4-vectors.json"
)
MAX_CASES = 20
MAX_POINTS_PER_CASE = 12


def _resource_text(package: str, filename: str) -> str:
    resource = importlib.resources.files(package).joinpath(filename)
    if not resource.is_file():
        raise FileNotFoundError(f"{package} does not ship {filename}")
    return resource.read_text()


def parse_cases(text: str) -> list[tuple[str, str]]:
    lines = iter(text.splitlines())
    cases = []
    for line in lines:
        if not line.startswith("1"):
            continue
        line1 = line
        line2 = next(lines)
        cases.append((line1, line2))
    return cases


def time_points(line2: str) -> list[float]:
    tstart, tend, tstep = (float(field) for field in line2[69:].split())
    points: list[float] = []
    tsince = tstart
    while tsince <= tend:
        points.append(tsince)
        tsince += tstep
    if points and points[-1] < tend - 1e-6:
        points.append(tend)
    if not points:
        points.append(tstart)
    return points


def main() -> None:
    text = _resource_text("sgp4", "SGP4-VER.TLE")
    cases = parse_cases(text)[:MAX_CASES]

    out_cases = []
    for line1, line2 in cases:
        sat = Satrec.twoline2rv(line1, line2)
        samples = []
        for tsince in time_points(line2)[:MAX_POINTS_PER_CASE]:
            error, r, _v = sat.sgp4_tsince(tsince)
            if error != 0:
                continue
            samples.append({"tsinceMin": tsince, "temeKm": [float(c) for c in r]})
        if not samples:
            continue
        out_cases.append(
            {"satnum": str(sat.satnum), "line1": line1, "line2": line2, "samples": samples}
        )

    payload = {
        "generatedBy": f"sgp4 {importlib.metadata.version('sgp4')}",
        "generatedAt": datetime.now(tz=UTC).isoformat(),
        "cases": out_cases,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"wrote {OUT} ({len(out_cases)} cases)")


if __name__ == "__main__":
    main()
