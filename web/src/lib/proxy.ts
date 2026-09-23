export type ProxyEnv = { API_ORIGIN_URL?: string; ORIGIN_SECRET?: string };

const REQUEST_HEADERS = ["accept", "content-type", "if-none-match"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag"];

function errorJson(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function upstreamUrl(requestUrl: string, origin: string): string {
  const url = new URL(requestUrl);
  return origin.replace(/\/+$/, "") + url.pathname + url.search;
}

/** Forwards a same-origin /api/* request to the Python API. Only an allow-list of headers
 * crosses in either direction (no cookies), and the origin secret is added server-side. */
export async function proxyToApi(
  req: Request,
  env: ProxyEnv = process.env as ProxyEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const origin = env.API_ORIGIN_URL;
  if (!origin) return errorJson(500, "misconfigured", "API_ORIGIN_URL is not set");

  const headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.ORIGIN_SECRET) headers.set("x-origin-auth", env.ORIGIN_SECRET);

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl(req.url, origin), {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    return errorJson(502, "unavailable", "the data API is unreachable");
  }

  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
