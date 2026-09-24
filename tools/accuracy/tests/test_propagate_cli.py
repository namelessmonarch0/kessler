import json
import subprocess
import sys
from pathlib import Path

from tests.test_reference import ISS

CLI = Path(__file__).resolve().parents[1] / "propagate.py"


def run(payload: dict) -> dict:
    out = subprocess.run([sys.executable, str(CLI)], input=json.dumps(payload), capture_output=True,
                         text=True, check=True)
    return json.loads(out.stdout)


def test_cli_preserves_order_and_reports_failures():
    broken = {**ISS, "noradId": 1, "eccentricity": 1.5}
    res = run({"items": [{"record": ISS, "timeMs": ISS["epochMs"]},
                         {"record": broken, "timeMs": ISS["epochMs"]}]})["results"]
    assert res[0]["ok"] is True and 410 < res[0]["altKm"] < 440
    assert res[1]["ok"] is False and res[1]["error"]
