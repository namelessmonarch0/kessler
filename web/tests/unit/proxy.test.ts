import { describe, expect, it, vi } from "vitest";
import { proxyToApi, upstreamUrl, memoizeCredentials } from "@/lib/proxy";

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

const CREDS = { accessKeyId: "AKIDTEST", secretAccessKey: "secret", sessionToken: "token-123" };
const SIGNED_ENV = { API_ORIGIN_URL: "https://abc.lambda-url.us-east-2.on.aws/", AWS_ROLE_ARN: "arn:aws:iam::1:role/kessler-vercel-api" };

function okFetch() {
  return vi.fn(async () => Response.json({ ok: true }));
}

describe("signing", () => {
  it("signs upstream requests for the lambda service in us-east-2 when a role is configured", async () => {
    const fetchImpl = okFetch();
    await proxyToApi(new Request("http://site/api/meta"), SIGNED_ENV, fetchImpl as unknown as typeof fetch, async () => CREDS);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new Headers(init.headers);
    expect(sent.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d{8}\/us-east-2\/lambda\/aws4_request, /);
    expect(sent.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(sent.get("x-amz-security-token")).toBe("token-123");
  });

  it("uses API_ORIGIN_REGION when set", async () => {
    const fetchImpl = okFetch();
    await proxyToApi(new Request("http://site/api/meta"), { ...SIGNED_ENV, API_ORIGIN_REGION: "eu-west-1" }, fetchImpl as unknown as typeof fetch, async () => CREDS);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toContain("/eu-west-1/lambda/aws4_request");
  });

  it("does not sign without a role", async () => {
    const fetchImpl = okFetch();
    const credentials = vi.fn(async () => CREDS);
    await proxyToApi(new Request("http://site/api/meta"), ENV, fetchImpl as unknown as typeof fetch, credentials);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    expect(credentials).not.toHaveBeenCalled();
  });

  it("returns 502 when credentials cannot be obtained", async () => {
    const fetchImpl = okFetch();
    const res = await proxyToApi(new Request("http://site/api/meta"), SIGNED_ENV, fetchImpl as unknown as typeof fetch, async () => { throw new Error("sts down"); });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses /api/ready without calling the API", async () => {
    const fetchImpl = okFetch();
    const res = await proxyToApi(new Request("http://site/api/ready"), ENV, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("memoizeCredentials", () => {
  it("fetches once and reuses until five minutes before expiry", async () => {
    let t = 0;
    const source = vi.fn(async () => ({ ...CREDS, expiration: new Date(60 * 60_000) }));
    const get = memoizeCredentials(source, () => t);
    await Promise.all([get(), get(), get()]);
    t = 54 * 60_000;
    await get();
    expect(source).toHaveBeenCalledTimes(1);
    t = 56 * 60_000;
    await get();
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("retries after a failure instead of caching it", async () => {
    const source = vi.fn().mockRejectedValueOnce(new Error("sts down")).mockResolvedValue(CREDS);
    const get = memoizeCredentials(source, () => 0);
    await expect(get()).rejects.toThrow("sts down");
    await expect(get()).resolves.toEqual(CREDS);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("treats credentials without an expiry as valid for 15 minutes", async () => {
    let t = 0;
    const source = vi.fn(async () => CREDS);
    const get = memoizeCredentials(source, () => t);
    await get();
    t = 14 * 60_000;
    await get();
    expect(source).toHaveBeenCalledTimes(1);
    t = 16 * 60_000;
    await get();
    expect(source).toHaveBeenCalledTimes(2);
  });
});
