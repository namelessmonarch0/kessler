export type ObjectType = "PAY" | "R/B" | "DEB" | "UNK";
export type Regime = "LEO" | "MEO" | "GEO" | "HEO" | "OTHER";
export type Metric = "in_orbit" | "added" | "reentered";
export type GroupBy = "none" | "type" | "owner" | "regime";

export const OBJECT_TYPES: readonly ObjectType[] = ["PAY", "R/B", "DEB", "UNK"];
export const TYPE_COLORS: Record<ObjectType, string> = {
  PAY: "#3987e5",
  "R/B": "#199e70",
  DEB: "#d95926",
  UNK: "#8f8e88",
};
export const TYPE_LABELS: Record<ObjectType, string> = {
  PAY: "Payloads",
  "R/B": "Rocket bodies",
  DEB: "Debris",
  UNK: "Unknown",
};

export interface OwnerSummary { code: string; name: string; flag_emoji: string | null; in_orbit: number; total: number }

export interface Meta {
  data_as_of: { satcat: string | null; gp: string | null; stats: string | null };
  in_orbit: Partial<Record<ObjectType, Partial<Record<Regime, number>>>>;
  owners: OwnerSummary[];
  types: Record<ObjectType, string>;
  regimes: Record<Regime, string>;
  ops_status: Record<string, string>;
  attribution: string;
}

export interface TimeseriesResponse {
  metric: Metric;
  group_by: GroupBy;
  years: number[];
  series: { key: string; values: number[] }[];
}

export interface BreakdownRow { key: string; counts: Partial<Record<ObjectType, number>>; total: number }
export interface BreakdownResponse { at: number; by: "owner" | "type" | "regime"; rows: BreakdownRow[] }

export interface BreakupEvent {
  id: string;
  parent_cospar: string;
  name: string;
  event_date: string;
  kind: "ASAT" | "COLLISION" | "EXPLOSION" | "UNKNOWN";
  description: string;
  source_url: string;
  pieces_total: number;
  pieces_in_orbit: number;
}

export interface SearchResult {
  norad_id: number;
  name: string;
  cospar_id: string | null;
  object_type: ObjectType;
  owner: string;
  regime: Regime;
  decayed: boolean;
}

export interface OrbitElements {
  epoch: string;
  mean_motion: number;
  eccentricity: number;
  inclination: number;
  raan: number;
  arg_pericenter: number;
  mean_anomaly: number;
  bstar: number;
  mean_motion_dot: number;
  mean_motion_ddot: number;
  source: string;
}

export interface ObjectDetail {
  norad_id: number;
  cospar_id: string | null;
  name: string;
  object_type: ObjectType;
  ops_status: string | null;
  ops_status_label: string | null;
  owner: string;
  owner_name: string;
  flag_emoji: string | null;
  launch_date: string | null;
  launch_site: string | null;
  launch_site_name: string | null;
  decay_date: string | null;
  period: number | null;
  inclination: number | null;
  apogee: number | null;
  perigee: number | null;
  rcs_size: "SMALL" | "MEDIUM" | "LARGE" | null;
  regime: Regime;
  parent_cospar: string | null;
  first_seen_year: number;
  event_id: string | null;
  orbit_center: string | null;
  updated_at: string;
  event: { id: string; name: string; event_date: string } | null;
  elements: OrbitElements | null;
}

export interface ApiErrorBody { error: { code: string; message: string } }
