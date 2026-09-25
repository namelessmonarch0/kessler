"""python -m app.history dump --from YYYY-MM-DD --to YYYY-MM-DD

Prints archived element sets as JSON Lines. Reads the local snapshot
directory, or the S3 bucket when SNAPSHOT_BUCKET is set (with AWS credentials
in the environment)."""
import argparse
import json
import sys
from datetime import date

from app.config import load_settings, make_store
from app.history.read import read_history


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        prog="python -m app.history",
        description="Read the orbit-history archive."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    dump = commands.add_parser(
        "dump",
        help="print element sets for UTC days as JSON Lines"
    )
    dump.add_argument("--from", dest="start", type=date.fromisoformat,
                      required=True)
    dump.add_argument("--to", dest="end", type=date.fromisoformat,
                      required=True)
    args = parser.parse_args(argv)
    store = make_store(load_settings())
    for record in read_history(store, args.start, args.end):
        sys.stdout.write(
            json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            + "\n"
        )


if __name__ == "__main__":
    main()
