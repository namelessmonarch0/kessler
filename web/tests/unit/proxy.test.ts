import { describe, expect, it, vi } from "vitest";
import { proxyToApi, upstreamUrl } from "@/lib/proxy";

const ENV = { API_ORIGIN_URL: "http://api.local:8000/", ORIGIN_SECRET: "s3cret" };

describe("upstreamUrl", () => {
  it("keeps path and query and trims the origin's trailing slash", () => {
    expect(upstreamUrl("http://site/api/stats/timeseries?from=2006&to=2011", ENV.API_ORIGIN_URL))
      .toBe("http://api.local:8000/api/stats/timeseries?from=2006&to=2011");
  });
});

describe("proxyToApi", () => {
  it("forwards GET with the origin secret and filters headers both ways", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("{\"ok\":true}", {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, s-maxage=3600", "set-cookie": "x=1" },
      }),
    );
    const req = new Request("http://site/api/meta", { headers: { accept: "application/json", cookie: "a=b" } });
    const res = await proxyToApi(req, ENV, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new Headers(init.headers);
    expect(url).toBe("http://api.local:8000/api/meta");
    expect(sent.get("x-origin-auth")).toBe("s3cret");
    expect(sent.get("cookie")).toBeNull();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=3600");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("passes through upstream errors and 304s unchanged", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 304, headers: { etag: "\"abc\"" } }));
    const req = new Request("http://site/api/globe/snapshot?group=LEO", { headers: { "if-none-match": "\"abc\"" } });
    const res = await proxyToApi(req, ENV, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("if-none-match")).toBe("\"abc\"");
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe("\"abc\"");
  });

  it("omits the secret header when no secret is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("[]", { status: 200 }));
    await proxyToApi(new Request("http://site/api/events"), { API_ORIGIN_URL: "http://a" }, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("x-origin-auth")).toBeNull();
  });

  it("proxy returns 502 JSON when upstream is unreachable", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const res = await proxyToApi(new Request("http://site/api/meta"), ENV, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "unavailable", message: "the data API is unreachable" } });
  });

  it("returns 500 JSON when API_ORIGIN_URL is missing", async () => {
    const res = await proxyToApi(new Request("http://site/api/meta"), {}, vi.fn() as unknown as typeof fetch);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("misconfigured");
  });

  it("forwards POST bodies", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok"));
    const req = new Request("http://site/api/chat", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{\"q\":1}",
    });
    await proxyToApi(req, ENV, fetchImpl as unknown as typeof fetch);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("{\"q\":1}");
  });
});
