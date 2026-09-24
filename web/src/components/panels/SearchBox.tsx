"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useExplorer } from "@/lib/store";
import { TYPE_LABELS, type SearchResult } from "@/lib/types";

export function SearchBox() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const select = useExplorer((s) => s.select);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2 && !/^\d+$/.test(text)) {
      // Clear stale results/errors when the query is too short to search — this mirrors an
      // external fetch keyed by `q` (below), which react-hooks/set-state-in-effect doesn't
      // distinguish from an avoidable derived-state effect; see the identical justification on
      // GlobeSection's WebGL probe and ObjectCard's selection reset.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setError(null);
      return;
    }
    // `cancelled` guards against the fetch itself arriving out of order (the debounce timeout
    // below only protects against a *pending* timer being superseded — once it fires and the
    // fetch is in flight, a fast response to a later query could otherwise be overwritten by a
    // slow response to an earlier one).
    let cancelled = false;
    const id = window.setTimeout(() => {
      api.search(text)
        .then((r) => { if (!cancelled) { setResults(r); setError(null); } })
        .catch((e: Error) => { if (!cancelled) { setResults([]); setError(e.message); } });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [q]);

  return (
    <div>
      <label className="label" htmlFor="search">Find an object</label>
      <input
        id="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="ISS, 25544, 1999-025…"
        maxLength={100}
        className="mt-2 w-full rounded-[10px] border-2 border-line bg-[#121212] px-3 py-2 text-[13px] text-ink placeholder:text-ink-3"
      />
      {error && <p className="mt-2 text-[13px] text-ink-2">{error}</p>}
      {results.length > 0 && (
        <ul className="mt-2 max-h-56 overflow-auto rounded-[10px] border-2 border-line">
          {results.map((r) => (
            <li key={r.norad_id}>
              <button type="button" onClick={() => { select(r.norad_id); setQ(""); }} className="flex w-full justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-[#161616]">
                <span className="text-ink">{r.name}</span>
                <span className="font-mono text-[12px] text-ink-3">{TYPE_LABELS[r.object_type]} · {r.decayed ? "re-entered" : r.regime}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
