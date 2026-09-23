import type {
  ApiErrorBody, BreakdownResponse, BreakupEvent, GroupBy, Meta, Metric, ObjectDetail, ObjectType,
  Regime, SearchResult, TimeseriesResponse,
} from "@/lib/types";

export class ApiRequestError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

type QueryValue = string | number | readonly string[] | undefined;

export function buildQuery(q: Record<string, QueryValue>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(","));
    } else {
      params.set(key, String(value));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function toError(res: Response): Promise<ApiRequestError> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    return new ApiRequestError(res.status, body.error.code, body.error.message);
  } catch {
    return new ApiRequestError(res.status, "http_error", `HTTP ${res.status}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

export interface TimeseriesQuery {
  metric?: Metric;
  group_by?: GroupBy;
  owners?: readonly string[];
  types?: readonly ObjectType[];
  regimes?: readonly Regime[];
  from?: number;
  to?: number;
  top?: number;
}

export interface BreakdownQuery {
  by?: "owner" | "type" | "regime";
  at?: number;
  owners?: readonly string[];
  types?: readonly ObjectType[];
  regimes?: readonly Regime[];
  top?: number;
}

export const api = {
  meta: () => getJson<Meta>("/meta"),
  timeseries: (q: TimeseriesQuery) => getJson<TimeseriesResponse>(`/stats/timeseries${buildQuery({ ...q })}`),
  breakdown: (q: BreakdownQuery) => getJson<BreakdownResponse>(`/stats/breakdown${buildQuery({ ...q })}`),
  events: () => getJson<BreakupEvent[]>("/events"),
  object: (id: number) => getJson<ObjectDetail>(`/objects/${id}`),
  search: (q: string) => getJson<SearchResult[]>(`/objects/search${buildQuery({ q })}`),
  async snapshot(group: "LEO" | "HIGH"): Promise<Uint8Array | null> {
    const res = await fetch(`/api/globe/snapshot?group=${group}`);
    if (res.status === 404) return null;
    if (!res.ok) throw await toError(res);
    return new Uint8Array(await res.arrayBuffer());
  },
};
