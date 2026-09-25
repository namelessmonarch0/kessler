import { AwsClient } from "aws4fetch";
import { awsCredentialsProvider } from "@vercel/oidc-aws-credentials-provider";

export type ProxyEnv = {
  API_ORIGIN_URL?: string;
  ORIGIN_SECRET?: string;
  /** Enables SigV4 signing: the role Vercel's OIDC token is exchanged for (production only). */
  AWS_ROLE_ARN?: string;
  /** Region of the API's Lambda URL. Not AWS_REGION: Vercel's runtime sets that to its own region. */
  API_ORIGIN_REGION?: string;
};
export type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date };
export type CredentialSource = () => Promise<Credentials>;

const REQUEST_HEADERS = ["accept", "content-type", "if-none-match"];
const RESPONSE_HEADERS = ["content-type", "cache-control", "etag"];
/** Readiness checks the database; it is for direct, signed calls only (the deploy smoke test). */
const REFUSED_PATHS = new Set(["/api/ready"]);
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
const DEFAULT_LIFETIME_MS = 15 * 60_000;

function errorJson(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function upstreamUrl(requestUrl: string, origin: string): string {
  const url = new URL(requestUrl);
  return origin.replace(/\/+$/, "") + url.pathname + url.search;
}

/** Reuses credentials until five minutes before they expire (15 minutes when they carry no
 * expiry); a failed fetch is not cached, so the next request retries. */
export function memoizeCredentials(source: CredentialSource, now: () => number = Date.now): CredentialSource {
  let pending: Promise<Credentials> | null = null;
  let refreshAt = 0;
  return () => {
    if (pending && now() < refreshAt) return pending;
    const fetched = source().then(
      (c) => {
        const expiresAt = c.expiration ? c.expiration.getTime() : now() + DEFAULT_LIFETIME_MS;
        refreshAt = expiresAt - (c.expiration ? REFRESH_BEFORE_EXPIRY_MS : 0);
        return c;
      },
      (err) => {
        if (pending === fetched) pending = null;
        throw err;
      },
    );
    pending = fetched;
    refreshAt = Number.POSITIVE_INFINITY; // concurrent callers share this fetch until it settles
    return fetched;
  };
}

let defaultSource: { roleArn: string; get: CredentialSource } | undefined;
function credentialsFor(roleArn: string): CredentialSource {
  if (defaultSource?.roleArn !== roleArn) {
    defaultSource = { roleArn, get: memoizeCredentials(awsCredentialsProvider({ roleArn }) as CredentialSource) };
  }
  return defaultSource.get;
}

/** Forwards a same-origin /api/* request to the Python API. Only an allow-list of headers
 * crosses in either direction (no cookies). With AWS_ROLE_ARN set, the request is signed
 * (SigV4, service "lambda") with credentials exchanged from the function's Vercel OIDC token. */
export async function proxyToApi(
  req: Request,
  env: ProxyEnv = process.env as ProxyEnv,
  fetchImpl: typeof fetch = fetch,
  credentials?: CredentialSource,
): Promise<Response> {
  const origin = env.API_ORIGIN_URL;
  if (!origin) return errorJson(500, "misconfigured", "API_ORIGIN_URL is not set");
  if (REFUSED_PATHS.has(new URL(req.url).pathname)) return errorJson(404, "not_found", "not found");

  let headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.ORIGIN_SECRET) headers.set("x-origin-auth", env.ORIGIN_SECRET);

  const url = upstreamUrl(req.url, origin);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  if (env.AWS_ROLE_ARN) {
    try {
      const c = await (credentials ?? credentialsFor(env.AWS_ROLE_ARN))();
      const aws = new AwsClient({
        accessKeyId: c.accessKeyId,
        secretAccessKey: c.secretAccessKey,
        sessionToken: c.sessionToken,
        service: "lambda",
        region: env.API_ORIGIN_REGION ?? "us-east-2",
      });
      headers = (await aws.sign(url, { method: req.method, headers, body })).headers;
    } catch {
      return errorJson(502, "unavailable", "the data API is unreachable");
    }
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, { method: req.method, headers, body, cache: "no-store", redirect: "manual" });
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
