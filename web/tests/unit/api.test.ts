import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api, buildQuery } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: Response) {
  const fn = vi.fn(async () => response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("buildQuery", () => {
  it("joins arrays with commas and skips undefined and empty arrays", () => {
    expect(buildQuery({ owners: ["US", "PRC"], types: [], from: 2006, to: undefined })).toBe("?owners=US%2CPRC&from=2006");
    expect(buildQuery({})).toBe("");
  });
});

describe("api", () => {
  it("requests same-origin paths", async () => {
    const fn = stubFetch(Response.json({ metric: "in_orbit", group_by: "type", years: [], series: [] }));
    await api.timeseries({ group_by: "type", regimes: ["LEO"], from: 2006, to: 2011 });
    expect((fn.mock.calls[0] as unknown[])[0]).toBe("/api/stats/timeseries?group_by=type&regimes=LEO&from=2006&to=2011");
  });

  it("throws ApiRequestError with the API's code and message", async () => {
    stubFetch(Response.json({ error: { code: "invalid_filter", message: "unknown owner code 'XX'" } }, { status: 422 }));
    await expect(api.meta()).rejects.toMatchObject({ status: 422, code: "invalid_filter", message: "unknown owner code 'XX'" });
  });

  it("falls back to a generic error when the body is not JSON", async () => {
    stubFetch(new Response("Bad Gateway", { status: 502 }));
    const err = await api.events().catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err.code).toBe("http_error");
  });

  it("returns null for a missing snapshot and bytes otherwise", async () => {
    stubFetch(Response.json({ error: { code: "not_found", message: "no globe snapshot" } }, { status: 404 }));
    expect(await api.snapshot("LEO")).toBeNull();
    stubFetch(new Response(new Uint8Array([1, 2, 3])));
    expect(Array.from((await api.snapshot("HIGH"))!)).toEqual([1, 2, 3]);
  });

  it("encodes search text", async () => {
    const fn = stubFetch(Response.json([]));
    await api.search("50%_ off");
    expect((fn.mock.calls[0] as unknown[])[0]).toBe("/api/objects/search?q=50%25_+off");
  });

  it("requests the names endpoint and returns body.names", async () => {
    const fn = stubFetch(Response.json({ generated_at: "2026-09-23T10:00:00Z", names: { "25544": "ISS (ZARYA)" } }));
    const result = await api.names("LEO");
    expect((fn.mock.calls[0] as unknown[])[0]).toBe("/api/globe/names?group=LEO");
    expect(result).toEqual({ "25544": "ISS (ZARYA)" });
  });

  it("throws ApiRequestError on names endpoint 500", async () => {
    stubFetch(Response.json({ error: { code: "server_error", message: "internal error" } }, { status: 500 }));
    await expect(api.names("HIGH")).rejects.toMatchObject({ status: 500, code: "server_error" });
  });
});
