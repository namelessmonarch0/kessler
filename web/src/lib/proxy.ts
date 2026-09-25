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
/** Readiness checks the database; it is for direct, signed calls only (the deploy smoke test).
 * Matched against the path as the API routes it (see routedPath). */
const REFUSED_PATHS = new Set(["/api/ready"]);
const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
const DEFAULT_LIFETIME_MS = 15 * 60_000;
const CREDENTIAL_TIMEOUT_MS = 5_000;

function errorJson(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function unavailable(): Response {
  return errorJson(502, "unavailable", "the data API is unreachable");
}

/** Name and message only: never the error object, whose other fields may carry request details. */
function errorParts(err: unknown): [string, string] {
  return err instanceof Error ? [err.name, err.message] : ["Error", String(err)];
}

/** The request path percent-decoded and without trailing slashes, as the API matches routes
 * (so /api/%72eady and /api/ready/ are /api/ready); null when its escapes are malformed. */
function routedPath(requestUrl: string): string | null {
  try {
    return decodeURIComponent(new URL(requestUrl).pathname).replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function upstreamUrl(requestUrl: string, origin: string): string {
  const url = new URL(requestUrl);
  return origin.replace(/\/+$/, "") + url.pathname + url.search;
}

/** Rejects with a TimeoutError when `promise` has not settled within `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`no credentials after ${ms} ms`);
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Reuses credentials until five minutes before they expire (15 minutes when they carry no
 * expiry). A fetch that fails or takes over five seconds is not cached, so the next request
 * retries; meanwhile the previous credentials, while they have not yet expired, are returned. */
export function memoizeCredentials(source: CredentialSource, now: () => number = Date.now): CredentialSource {
  let pending: Promise<Credentials> | null = null;
  let refreshAt = 0;
  let previous: Credentials | null = null;
  return () => {
    if (pending && now() < refreshAt) return pending;
    const fetched = withTimeout(source(), CREDENTIAL_TIMEOUT_MS).then(
      (c) => {
        const expiresAt = c.expiration ? c.expiration.getTime() : now() + DEFAULT_LIFETIME_MS;
        refreshAt = expiresAt - (c.expiration ? REFRESH_BEFORE_EXPIRY_MS : 0);
        previous = c;
        return c;
      },
      (err) => {
        if (pending === fetched) pending = null;
        const stale = previous;
        if (stale?.expiration && now() < stale.expiration.getTime()) {
          console.warn("proxy: credential refresh failed, reusing credentials that expire %s: %s: %s",
            stale.expiration.toISOString(), ...errorParts(err));
          return stale;
        }
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
    const source = awsCredentialsProvider({ roleArn }) as CredentialSource;
    // One line per credential lifetime: the runtime logs' proof that the OIDC → STS exchange works.
    const announced: CredentialSource = async () => {
      const c = await source();
      console.info("proxy: signing as %s, credentials expire %s", roleArn, c.expiration?.toISOString() ?? "unknown");
      return c;
    };
    defaultSource = { roleArn, get: memoizeCredentials(announced) };
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
  const path = routedPath(req.url);
  if (path === null || REFUSED_PATHS.has(path)) return errorJson(404, "not_found", "not found");

  let headers = new Headers();
  for (const name of REQUEST_HEADERS) {
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (env.ORIGIN_SECRET) headers.set("x-origin-auth", env.ORIGIN_SECRET);

  const url = upstreamUrl(req.url, origin);
  let body: ArrayBuffer | undefined;
  try {
    body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  } catch {
    return unavailable(); // the client went away mid-body
  }
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
    } catch (err) {
      console.error("proxy: signing failed: %s: %s", ...errorParts(err));
      return unavailable();
    }
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, { method: req.method, headers, body, cache: "no-store", redirect: "manual" });
  } catch (err) {
    console.error("proxy: upstream fetch failed: %s: %s", ...errorParts(err));
    return unavailable();
  }
  if (env.AWS_ROLE_ARN && (upstream.status === 401 || upstream.status === 403)) {
    // AWS refused the signature or the role; its error type says which. Passed through as is.
    console.warn("proxy: upstream rejected a signed request: %d %s", upstream.status,
      upstream.headers.get("x-amzn-errortype") ?? "");
  }

  const out = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
