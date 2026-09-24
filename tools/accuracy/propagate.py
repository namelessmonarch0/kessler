"""stdin: {"items":[{"record":{...},"timeMs":int}]} -> stdout: {"results":[...]} (same order)."""
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from kessler_accuracy.reference import position


def main() -> None:
    items = json.load(sys.stdin)["items"]
    results = []
    for it in items:
        try:
            p = position(it["record"], int(it["timeMs"]))
            vals = [*p["ecefKm"], p["latDeg"], p["lonDeg"], p["altKm"]]
            if not all(math.isfinite(v) for v in vals):
                raise ValueError("non-finite position")
            results.append({"ok": True, **p})
        except Exception as exc:  # one bad record must not sink the batch
            results.append({"ok": False, "error": str(exc) or type(exc).__name__})
    json.dump({"results": results}, sys.stdout)


if __name__ == "__main__":
    main()
