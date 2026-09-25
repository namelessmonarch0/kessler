import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";
import { proxyToApi, upstreamUrl, memoizeCredentials, type CredentialSource } from "@/lib/proxy";

vi.mock("@vercel/oidc-aws-credentials-provider", () => ({ awsCredentialsProvider: vi.fn() }));

const ENV = { API_ORIGIN_URL: "http://api.local:8000/", ORIGIN_SECRET: "s3cret" };

// The proxy logs to the console; keep test output quiet and let tests assert on the lines.
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** Every console line logged so far, formatted as the runtime would print it. */
function logged(): string[] {
  return (["info", "warn", "error"] as const).flatMap((level) =>
    vi.mocked(console[level]).mock.calls.map((args) => format(...args)));
}

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

  it("proxy returns 502 JSON when upstream is unreachable, and logs why", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const res = await proxyToApi(new Request("http://site/api/meta"), ENV, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "unavailable", message: "the data API is unreachable" } });
    expect(console.error).toHaveBeenCalledWith("proxy: upstream fetch failed: %s: %s", "TypeError", "fetch failed");
    expect(logged().join("\n")).not.toContain(ENV.ORIGIN_SECRET);
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

  it("returns 502 JSON when the request body cannot be read", async () => {
    const fetchImpl = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.error(new Error("client went away")); } });
    const req = new Request("http://site/api/chat", { method: "POST", body, duplex: "half" } as RequestInit);
    const res = await proxyToApi(req, ENV, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards percent-encoded paths as they came", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}"));
    await proxyToApi(new Request("http://site/api/objects/a%20b"), ENV, fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://api.local:8000/api/objects/a%20b");
  });
});

const CREDS = { accessKeyId: "AKIDTEST", secretAccessKey: "secret-key-test", sessionToken: "token-123" };
const SIGNED_ENV = { API_ORIGIN_URL: "https://abc.lambda-url.us-east-2.on.aws/", AWS_ROLE_ARN: "arn:aws:iam::1:role/kessler-vercel-api" };
const SECRETS = [CREDS.accessKeyId, CREDS.secretAccessKey, CREDS.sessionToken, ENV.ORIGIN_SECRET];

function okFetch() {
  return vi.fn(async () => Response.json({ ok: true }));
}

function sentAuthorization(fetchImpl: ReturnType<typeof okFetch>, call = 0): string {
  const [, init] = fetchImpl.mock.calls[call] as unknown as [string, RequestInit];
  return new Headers(init.headers).get("authorization") ?? "";
}

function expectNoSecretsLogged() {
  const text = logged().join("\n");
  for (const secret of SECRETS) expect(text).not.toContain(secret);
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

  it("signs the host, date, session token and origin secret headers", async () => {
    const fetchImpl = okFetch();
    await proxyToApi(new Request("http://site/api/meta"), { ...SIGNED_ENV, ORIGIN_SECRET: "s3cret" }, fetchImpl as unknown as typeof fetch, async () => CREDS);
    const signed = /SignedHeaders=([^,]+)/.exec(sentAuthorization(fetchImpl))?.[1].split(";");
    expect(signed).toEqual(expect.arrayContaining(["host", "x-amz-date", "x-amz-security-token", "x-origin-auth"]));
  });

  it("signs the body: POSTs that differ only in their body get different signatures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
    const signatureFor = async (body: string) => {
      const fetchImpl = okFetch();
      const req = new Request("http://site/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body });
      await proxyToApi(req, SIGNED_ENV, fetchImpl as unknown as typeof fetch, async () => CREDS);
      return /Signature=([0-9a-f]+)/.exec(sentAuthorization(fetchImpl))?.[1];
    };
    const first = await signatureFor("{\"q\":1}");
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await signatureFor("{\"q\":1}")).toBe(first); // same instant and body: same signature
    expect(await signatureFor("{\"q\":2}")).not.toBe(first);
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

  it("returns 502 when credentials cannot be obtained, and logs why", async () => {
    const fetchImpl = okFetch();
    const res = await proxyToApi(new Request("http://site/api/meta"), SIGNED_ENV, fetchImpl as unknown as typeof fetch, async () => { throw new Error("sts down"); });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("unavailable");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith("proxy: signing failed: %s: %s", "Error", "sts down");
  });

  it.each([401, 403])("passes an upstream %i to a signed request through, and logs it without credentials", async (status) => {
    const fetchImpl = vi.fn(async () => Response.json({ Message: "Forbidden" }, {
      status, headers: { "x-amzn-errortype": "AccessDeniedException" },
    }));
    const res = await proxyToApi(new Request("http://site/api/meta"), { ...SIGNED_ENV, ORIGIN_SECRET: "s3cret" }, fetchImpl as unknown as typeof fetch, async () => CREDS);
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ Message: "Forbidden" });
    expect(console.warn).toHaveBeenCalledWith("proxy: upstream rejected a signed request: %d %s", status, "AccessDeniedException");
    expectNoSecretsLogged();
  });

  it("does not warn about a 403 when signing is off", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
    await proxyToApi(new Request("http://site/api/meta"), ENV, fetchImpl as unknown as typeof fetch);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("refuses /api/ready without calling the API", async () => {
    const fetchImpl = okFetch();
    const res = await proxyToApi(new Request("http://site/api/ready"), ENV, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["/api/%72eady", "/api/ready/", "/api/%E0%A4%A"])("refuses %s without calling the API", async (path) => {
    const fetchImpl = okFetch();
    const res = await proxyToApi(new Request(`http://site${path}`), ENV, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("default credentials (Vercel OIDC)", () => {
  it("exchanges once for the role across requests and logs the role once", async () => {
    const roleArn = "arn:aws:iam::1:role/default-path";
    const expiration = new Date(Date.now() + 60 * 60_000);
    const source = vi.fn(async () => ({ ...CREDS, expiration }));
    vi.mocked(awsCredentialsProvider).mockReturnValue(source);
    const fetchImpl = okFetch();
    for (let i = 0; i < 3; i++) {
      await proxyToApi(new Request("http://site/api/meta"), { ...SIGNED_ENV, AWS_ROLE_ARN: roleArn }, fetchImpl as unknown as typeof fetch);
    }
    expect(awsCredentialsProvider).toHaveBeenCalledWith({ roleArn });
    expect(source).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sentAuthorization(fetchImpl, 2)).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
    expect(console.info).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith("proxy: signing as %s, credentials expire %s", roleArn, expiration.toISOString());
    expectNoSecretsLogged();
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

  it("gives up on a hung fetch after five seconds, and the next call retries", async () => {
    vi.useFakeTimers();
    const source = vi.fn<CredentialSource>().mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(CREDS);
    const get = memoizeCredentials(source, () => 0);
    let outcome: string | undefined;
    void get().then(() => { outcome = "resolved"; }, (err: Error) => { outcome = err.name; });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(outcome).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe("TimeoutError");
    await expect(get()).resolves.toEqual(CREDS);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it("keeps unexpired credentials when a refresh fails, and retries the refresh on the next call", async () => {
    let t = 0;
    const first = { ...CREDS, expiration: new Date(60 * 60_000) };
    const next = { ...CREDS, accessKeyId: "AKIDNEXT", expiration: new Date(120 * 60_000) };
    const source = vi.fn<CredentialSource>()
      .mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("sts down")).mockResolvedValue(next);
    const get = memoizeCredentials(source, () => t);
    await get();
    t = 56 * 60_000;
    await expect(get()).resolves.toBe(first);
    expect(console.warn).toHaveBeenCalledWith(
      "proxy: credential refresh failed, reusing credentials that expire %s: %s: %s",
      first.expiration.toISOString(), "Error", "sts down");
    expectNoSecretsLogged();
    await expect(get()).resolves.toBe(next);
    expect(source).toHaveBeenCalledTimes(3);
  });

  it("fails when a refresh fails after the previous credentials expired", async () => {
    let t = 0;
    const source = vi.fn<CredentialSource>()
      .mockResolvedValueOnce({ ...CREDS, expiration: new Date(60 * 60_000) })
      .mockRejectedValueOnce(new Error("sts down")).mockResolvedValue(CREDS);
    const get = memoizeCredentials(source, () => t);
    await get();
    t = 61 * 60_000;
    await expect(get()).rejects.toThrow("sts down");
    await expect(get()).resolves.toEqual(CREDS);
  });
});
