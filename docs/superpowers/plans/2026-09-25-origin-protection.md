# Origin Protection (Audit Piece 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the production Vercel deployment (and the deploy workflow) can invoke the API: the Lambda function URL uses `AWS_IAM`, the proxy signs requests with OIDC-federated credentials, health is cheap, concurrency is capped, the old origin secret is retired, and `/api/*` is rate-limited at Vercel's edge.

**Architecture:** CDK adds a Vercel OIDC provider and a `kessler-vercel-api` role scoped to invoking `kessler-api` through its URL, a resource-policy grant for the deploy role, and a context flag for the URL's auth type. The Next.js proxy signs upstream requests with `aws4fetch` using memoized credentials from `@vercel/oidc-aws-credentials-provider`. The API splits `/health` (liveness) from `/ready` (database). Rollout is three pushes gated by live checks.

**Tech Stack:** AWS CDK (Python), FastAPI, Next.js route handlers (TypeScript), `aws4fetch`, `@vercel/oidc-aws-credentials-provider`, vitest, pytest, GitHub Actions (`curl --aws-sigv4`), Vercel CLI.

**Spec:** `docs/superpowers/specs/2026-09-25-origin-protection-design.md`

## Global Constraints

- Vercel team slug `kudayyurter`, project `kessler`, issuer `https://oidc.vercel.com/kudayyurter`, audience `https://vercel.com/kudayyurter`, subject exactly `owner:kudayyurter:project:kessler:environment:production` (StringEquals).
- Role name `kessler-vercel-api`; permissions only `lambda:InvokeFunctionUrl` (condition `lambda:FunctionUrlAuthType = AWS_IAM`) and `lambda:InvokeFunction` (condition `lambda:InvokedViaFunctionUrl = true`) on `kessler-api`.
- Deploy role `arn:aws:iam::<account>:role/kessler-github-deploy` gets the same two permissions via the function's resource-based policy.
- CDK context `api_url_auth` ∈ {`NONE`, `AWS_IAM`}, default `NONE`; `api_reserved_concurrency` = 10.
- Proxy env: `AWS_ROLE_ARN` (enables signing), `API_ORIGIN_REGION` (default `us-east-2`; `AWS_REGION` is set by Vercel's own runtime and must not be relied on); SigV4 service `lambda`.
- `/api/health` → `{"status": "ok"}` without database access; `/api/ready` → database check (`{"status": "ok", "gp_age_hours": …}` or 503); the proxy answers `/api/ready` with 404.
- WAF rule: path prefix `/api/`, fixed window 60 s, 300 requests per IP, action 429.
- Pushing to `main` deploys (API/infra via `deploy.yml`, web via Vercel). Every push and every change to Vercel/AWS settings needs the owner's go-ahead.
- Lint/tests: API `uv run pytest -q` + `uv run ruff check .` (no `ruff format`; added Python lines ≤ 100 chars); infra `uv run pytest -q` + `uv run ruff check .`; web `npx vitest run`, `npx tsc --noEmit`, `npx eslint src tests`, `npx playwright test`.
- Commit messages end with a blank line and:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01VPsSApUQwExwuTy7VzPMbH`

## Review Focus

- A preview or development OIDC token must not be able to assume the role: pinned in Task 1 (`test_vercel_role_trusts_only_production_of_this_project`).
- Credentials must be fetched once and reused across requests, and a failed fetch must be retried rather than cached: pinned in Task 3 (`memoizeCredentials` tests).
- A credential or signing failure must return the proxy's sanitized 502, not throw into Next.js: pinned in Task 3 (`returns 502 when credentials cannot be obtained`).
- The smoke test must fail if IAM is not actually enforced after the flip: pinned in Task 4 (the `AWS_IAM` branch asserts an unsigned 403).
- After the secret is retired, no request may be rejected for a missing `x-origin-auth`, and production settings must not demand `ORIGIN_SECRET`: pinned in Task 6.

---

### Task 1: CDK — Vercel trust, deploy-role grant, URL auth flag, concurrency

**Files:**
- Modify: `infra/kessler_infra/app_stack.py`, `infra/app.py`, `infra/cdk.json`
- Modify: `infra/tests/conftest.py`, `infra/tests/test_app_stack.py`

**Interfaces:**
- Produces: `KesslerAppStack(..., api_url_auth: str = "NONE")`; stack output `VercelApiRoleArn`; context key `api_url_auth` in `infra/cdk.json`.

- [ ] **Step 1: Write the failing tests**

In `infra/tests/conftest.py`, let the fixture take the auth type:

```python
@pytest.fixture
def app_template():
    def build(reserved: int = 10, url_auth: str = "NONE") -> Template:
        from kessler_infra.app_stack import KesslerAppStack

        app = App()
        stack = KesslerAppStack(app, "KesslerApp", env=ENV, image_tag="abc123",
                            alert_email="owner@example.com", api_reserved_concurrency=reserved,
                            api_url_auth=url_auth)
        return Template.from_stack(stack)

    return build
```

In `infra/tests/test_app_stack.py`, replace `test_only_api_has_public_streaming_url` with:

```python
def test_only_api_has_a_streaming_url_public_until_iam_is_enabled(app_template):
    t = app_template()
    t.resource_count_is("AWS::Lambda::Url", 1)
    t.has_resource_properties("AWS::Lambda::Url", {"AuthType": "NONE",
                                                   "InvokeMode": "RESPONSE_STREAM"})
    t.has_resource_properties("AWS::Lambda::Permission", {
        "Action": "lambda:InvokeFunction", "Principal": "*", "InvokedViaFunctionUrl": True})
    t.has_output("ApiFunctionUrl", {})


def test_iam_url_has_no_public_permission(app_template):
    t = app_template(url_auth="AWS_IAM")
    t.has_resource_properties("AWS::Lambda::Url", {"AuthType": "AWS_IAM",
                                                   "InvokeMode": "RESPONSE_STREAM"})
    public = t.find_resources("AWS::Lambda::Permission", {"Properties": {"Principal": "*"}})
    assert public == {}


def test_unknown_url_auth_is_rejected(app_template):
    with pytest.raises(ValueError, match="api_url_auth"):
        app_template(url_auth="OPEN")
```

and append:

```python
VERCEL = "oidc.vercel.com/kudayyurter"


def _role_by_name(template, name):
    roles = template.find_resources("AWS::IAM::Role", {"Properties": {"RoleName": name}})
    assert len(roles) == 1, f"expected exactly one role {name}"
    return next(iter(roles.items()))


def test_vercel_oidc_provider(app_template):
    app_template().has_resource_properties("AWS::IAM::OIDCProvider", {
        "Url": f"https://{VERCEL}", "ClientIdList": ["https://vercel.com/kudayyurter"]})


def test_vercel_role_trusts_only_production_of_this_project(app_template):
    _, role = _role_by_name(app_template(), "kessler-vercel-api")
    (statement,) = role["Properties"]["AssumeRolePolicyDocument"]["Statement"]
    assert statement["Action"] == "sts:AssumeRoleWithWebIdentity"
    assert statement["Condition"] == {"StringEquals": {
        f"{VERCEL}:aud": "https://vercel.com/kudayyurter",
        f"{VERCEL}:sub": "owner:kudayyurter:project:kessler:environment:production",
    }}


def test_vercel_role_may_only_invoke_the_api_through_its_url(app_template):
    t = app_template()
    logical_id, _ = _role_by_name(t, "kessler-vercel-api")
    policies = [p for p in t.find_resources("AWS::IAM::Policy").values()
                if {"Ref": logical_id} in p["Properties"]["Roles"]]
    (policy,) = policies
    statements = policy["Properties"]["PolicyDocument"]["Statement"]
    by_action = {s["Action"]: s for s in statements}
    assert set(by_action) == {"lambda:InvokeFunctionUrl", "lambda:InvokeFunction"}
    assert by_action["lambda:InvokeFunctionUrl"]["Condition"] == {
        "StringEquals": {"lambda:FunctionUrlAuthType": "AWS_IAM"}}
    assert by_action["lambda:InvokeFunction"]["Condition"] == {
        "Bool": {"lambda:InvokedViaFunctionUrl": "true"}}
    for s in statements:
        assert "ApiFunction" in json.dumps(s["Resource"]) and "JobsFunction" not in json.dumps(s["Resource"])
    t.has_output("VercelApiRoleArn", {})


def test_deploy_role_may_call_the_api_url_for_smoke_tests(app_template):
    t = app_template()
    grants = [p["Properties"] for p in t.find_resources("AWS::Lambda::Permission").values()
              if "kessler-github-deploy" in json.dumps(p["Properties"]["Principal"])]
    assert {g["Action"] for g in grants} == {"lambda:InvokeFunctionUrl", "lambda:InvokeFunction"}
    url_grant = next(g for g in grants if g["Action"] == "lambda:InvokeFunctionUrl")
    via_grant = next(g for g in grants if g["Action"] == "lambda:InvokeFunction")
    assert url_grant["FunctionUrlAuthType"] == "AWS_IAM"
    assert via_grant["InvokedViaFunctionUrl"] is True
    for g in grants:
        assert "ApiFunction" in json.dumps(g["FunctionName"])


def test_cdk_json_caps_api_concurrency_and_starts_with_an_open_url():
    context = json.loads((Path(__file__).parents[1] / "cdk.json").read_text())["context"]
    assert context["api_reserved_concurrency"] == 10
    assert context["api_url_auth"] == "NONE"
```

(add `from pathlib import Path` and `import pytest` to the test module's imports if missing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd infra && uv run pytest -q`
Expected: failures — `KesslerAppStack` rejects the unknown keyword `api_url_auth`; after that, missing OIDC provider/role/permissions/output and the cdk.json values.

- [ ] **Step 3: Implement**

In `infra/kessler_infra/app_stack.py`:

1. Constructor signature: add `api_url_auth: str = "NONE"` after `api_reserved_concurrency: int`, and validate it first thing after `super().__init__`:

```python
        if api_url_auth not in ("NONE", "AWS_IAM"):
            raise ValueError(f"api_url_auth must be NONE or AWS_IAM, not {api_url_auth!r}")
```

2. Replace the `add_function_url` call's `auth_type=lambda_.FunctionUrlAuthType.NONE,` with:

```python
            auth_type=(lambda_.FunctionUrlAuthType.AWS_IAM if api_url_auth == "AWS_IAM"
                       else lambda_.FunctionUrlAuthType.NONE),
```

3. After `self.api_url = url.url`, add:

```python
        # --- origin protection: only Vercel production (via OIDC) and the deploy workflow may call
        # the API URL (spec 2026-09-25-origin-protection). Enforced once api_url_auth is AWS_IAM. ---
        vercel_issuer = "oidc.vercel.com/kudayyurter"
        vercel_oidc = iam.OidcProviderNative(
            self, "VercelOidc", url=f"https://{vercel_issuer}",
            client_ids=["https://vercel.com/kudayyurter"],
        )
        vercel_role = iam.Role(
            self, "VercelApiRole", role_name="kessler-vercel-api",
            assumed_by=iam.WebIdentityPrincipal(vercel_oidc.oidc_provider_arn, conditions={
                "StringEquals": {
                    f"{vercel_issuer}:aud": "https://vercel.com/kudayyurter",
                    f"{vercel_issuer}:sub":
                        "owner:kudayyurter:project:kessler:environment:production",
                },
            }),
            max_session_duration=Duration.hours(1),
        )
        vercel_role.add_to_policy(iam.PolicyStatement(
            actions=["lambda:InvokeFunctionUrl"], resources=[self.api_fn.function_arn],
            conditions={"StringEquals": {"lambda:FunctionUrlAuthType": "AWS_IAM"}},
        ))
        vercel_role.add_to_policy(iam.PolicyStatement(
            actions=["lambda:InvokeFunction"], resources=[self.api_fn.function_arn],
            conditions={"Bool": {"lambda:InvokedViaFunctionUrl": "true"}},
        ))
        deploy_role = iam.ArnPrincipal(f"arn:aws:iam::{self.account}:role/kessler-github-deploy")
        lambda_.CfnPermission(
            self, "DeployRoleInvokeUrl", action="lambda:InvokeFunctionUrl",
            function_name=self.api_fn.function_arn, principal=deploy_role.arn,
            function_url_auth_type="AWS_IAM",
        )
        lambda_.CfnPermission(
            self, "DeployRoleInvokeViaUrl", action="lambda:InvokeFunction",
            function_name=self.api_fn.function_arn, principal=deploy_role.arn,
            invoked_via_function_url=True,
        )
```

   (If this aws-cdk-lib version's `CfnPermission` has no `invoked_via_function_url` argument, check with `uv run python -c "import aws_cdk.aws_lambda as l, inspect; print(inspect.signature(l.CfnPermission))"`; if missing, set it with `perm.add_property_override("InvokedViaFunctionUrl", True)` and say so in your report.)

4. Next to the other outputs at the end: `CfnOutput(self, "VercelApiRoleArn", value=vercel_role.role_arn)`.

In `infra/app.py`, pass the flag: add `api_url_auth=ctx("api_url_auth") or "NONE",` to the `KesslerAppStack(...)` call.

In `infra/cdk.json` context: set `"api_reserved_concurrency": 10` and add `"api_url_auth": "NONE"`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd infra && uv run pytest -q && uv run ruff check .` and `awk 'length > 100 {print FILENAME": "FNR}' kessler_infra/app_stack.py app.py tests/test_app_stack.py tests/conftest.py` (lines you added only).
Expected: all pass, no lint findings.

- [ ] **Step 5: Commit**

```bash
git add infra/kessler_infra/app_stack.py infra/app.py infra/cdk.json infra/tests/conftest.py infra/tests/test_app_stack.py
git commit -m "feat(infra): Vercel OIDC role and deploy-role grant for the API URL; cap API concurrency at 10"
```

---

### Task 2: API — `/health` is liveness, `/ready` checks the database

**Files:**
- Modify: `api/app/api/routes.py`, `api/app/api/auth.py`
- Modify: `api/tests/test_api.py`

**Interfaces:**
- Produces: `GET /api/health` → `{"status": "ok"}` (no database); `GET /api/ready` → `{"status": "ok", "gp_age_hours": float | None}` or 503 `unavailable`; `OPEN_PATHS = {"/api/health", "/api/ready"}` while the origin secret exists.

- [ ] **Step 1: Write the failing tests**

In `api/tests/test_api.py`, replace `test_health_returns_503_json_when_db_unavailable` with:

```python
def test_health_needs_no_database(migrated, store):
    db = Database(migrated)
    app = create_app(Settings(database_url=migrated), store=store, database=db)
    with TestClient(app) as c:
        db.close()
        r = c.get("/api/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_ready_reports_the_database(client):
    r = client.get("/api/ready")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and "gp_age_hours" in body


def test_ready_returns_503_json_when_db_unavailable(migrated, store):
    db = Database(migrated)
    app = create_app(Settings(database_url=migrated), store=store, database=db)
    with TestClient(app) as c:
        db.close()
        r = c.get("/api/ready")
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "unavailable"
```

and in `test_origin_secret_required_except_health`, add after the health assertion:

```python
        assert c.get("/api/ready").status_code == 200  # signed smoke test has no secret
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd api && uv run pytest tests/test_api.py -q`
Expected: `test_health_needs_no_database` fails (503), the ready tests fail (404).

- [ ] **Step 3: Implement**

In `api/app/api/routes.py`, replace the `health` handler with:

```python
@router.get("/health")
def health() -> dict:
    """Liveness: the process answers. No database access, so it is cheap for anyone to call."""
    return {"status": "ok"}


@router.get("/ready")
def ready(request: Request) -> dict:
    """Readiness: the database answers. For direct, signed calls (the deploy smoke test); the
    site's proxy refuses this path."""
    try:
        with request.app.state.db.pool.connection() as conn:
            conn.execute("SELECT 1")
            last_gp = last_success(conn, "ingest_gp")
    except Exception as exc:
        raise ApiError(503, "unavailable", "database unavailable") from exc
    age = (datetime.now(UTC) - last_gp).total_seconds() / 3600 if last_gp else None
    return {"status": "ok", "gp_age_hours": age}
```

In `api/app/api/auth.py`: `OPEN_PATHS = {"/api/health", "/api/ready"}` with a comment that `/api/ready` is open only until the secret is retired (Task 6).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd api && uv run pytest -q && uv run ruff check .`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/app/api/routes.py api/app/api/auth.py api/tests/test_api.py
git commit -m "feat(api): /health is database-free liveness; /ready checks the database"
```

---

### Task 3: Proxy — sign upstream requests; refuse `/api/ready`

**Files:**
- Modify: `web/src/lib/proxy.ts`, `web/package.json`, `web/package-lock.json`
- Modify: `web/tests/unit/proxy.test.ts`

**Interfaces:**
- Produces: `ProxyEnv` gains `AWS_ROLE_ARN?`, `API_ORIGIN_REGION?`; `type Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string; expiration?: Date }`; `type CredentialSource = () => Promise<Credentials>`; `memoizeCredentials(source: CredentialSource, now?: () => number): CredentialSource`; `proxyToApi(req, env?, fetchImpl?, credentials?: CredentialSource)`.

- [ ] **Step 1: Install the dependencies**

Run: `cd web && npm install aws4fetch @vercel/oidc-aws-credentials-provider`
Expected: both added to `dependencies`.

- [ ] **Step 2: Write the failing tests**

Append to `web/tests/unit/proxy.test.ts`:

```ts
import { memoizeCredentials } from "@/lib/proxy";

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
```

(merge the new import into the file's existing import from `@/lib/proxy`.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd web && npx vitest run tests/unit/proxy.test.ts`
Expected: failures — `memoizeCredentials` is not exported; no signing headers; `/api/ready` forwarded.

- [ ] **Step 4: Implement**

Replace `web/src/lib/proxy.ts` with:

```ts
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
```

(If `awsCredentialsProvider`'s return type doesn't satisfy `CredentialSource` without the cast, keep the cast and note it; if `aws.sign` in this aws4fetch version needs `body` as `BodyInit`, an `ArrayBuffer` is valid.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run && npx tsc --noEmit && npx eslint src tests && npx playwright test`
Expected: all pass (the existing proxy tests keep passing unchanged; e2e mocks `/api/**` in the browser, so signing is not exercised there).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/proxy.ts web/package.json web/package-lock.json web/tests/unit/proxy.test.ts
git commit -m "feat(web): sign API requests with Vercel OIDC credentials; refuse /api/ready"
```

---

### Task 4: Signed smoke test, runbook and docs

**Files:**
- Modify: `.github/workflows/deploy.yml` (the "Smoke test" step)
- Modify: `docs/deploy.md`, `api/README.md`, `web/README.md`

**Interfaces:**
- Consumes: `api_url_auth` in `infra/cdk.json` (Task 1); `/api/health`, `/api/ready` (Task 2); `AWS_ROLE_ARN`, `API_ORIGIN_REGION` (Task 3).

- [ ] **Step 1: Replace the smoke test step** in `.github/workflows/deploy.yml` with:

```yaml
      - name: Smoke test
        run: |
          URL=$(aws cloudformation describe-stacks --stack-name KesslerApp \
            --query "Stacks[0].Outputs[?OutputKey=='ApiFunctionUrl'].OutputValue" --output text)
          AUTH=$(jq -r '.context.api_url_auth // "NONE"' infra/cdk.json)
          SIGN=(--aws-sigv4 "aws:amz:us-east-2:lambda"
                --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY"
                -H "x-amz-security-token: $AWS_SESSION_TOKEN")
          code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
          test "$(code "${SIGN[@]}" "${URL}api/health")" = 200
          test "$(code "${SIGN[@]}" "${URL}api/ready")" = 200
          if [ "$AUTH" = "AWS_IAM" ]; then
            test "$(code "${URL}api/health")" = 403     # AWS rejects unsigned requests
          else
            test "$(code "${URL}api/meta")" = 403       # the origin secret still guards the app
          fi
```

(Check the step runs under `bash` — GitHub's default shell for `run` on ubuntu is bash — and that the configure-aws-credentials step earlier in the job exports `AWS_SESSION_TOKEN`; it does by default.)

- [ ] **Step 2: Confirm the Vercel CLI firewall syntax without changing anything**

Run: `cd web && npx -y vercel@latest firewall --help && npx -y vercel@latest firewall rules add --help`
Record whether rule changes need a separate publish command (e.g. `vercel firewall publish`).

- [ ] **Step 3: Update the docs**

- `docs/deploy.md`: a new "Origin protection" section with
  - one-time setup: Vercel → Project `kessler` → Settings → Security → "Secure backend access with OIDC federation" = **Team**; after the infra deploy, `AWS_ROLE_ARN` = the `VercelApiRoleArn` stack output, set for **Production** only (`vercel env add AWS_ROLE_ARN production`), then redeploy the site; `API_ORIGIN_REGION` is not needed (defaults to `us-east-2`);
  - the three-step rollout from the spec, each with its checks and rollback;
  - the rate-limit rule, as the exact CLI command(s) confirmed in Step 2: path prefix `/api/`, 60 s fixed window, 300 requests per IP, action 429; plus how to list and remove it;
  - update any existing curl checks: `/api/health` → `{"status":"ok"}`, database checks move to `/api/ready`, and direct calls to the function URL must be signed once `api_url_auth` is `AWS_IAM` (`curl --aws-sigv4 "aws:amz:us-east-2:lambda" --user "$AK:$SK" -H "x-amz-security-token: $TOKEN"`).
- `api/README.md`: `/api/health` (liveness, no database) and `/api/ready` (database; proxy refuses it).
- `web/README.md`: the proxy's signing (`AWS_ROLE_ARN`, `API_ORIGIN_REGION`) and that local development stays unsigned.

- [ ] **Step 4: Check**

Run: `cd api && uv run --with pyyaml python -c "import yaml; yaml.safe_load(open('../.github/workflows/deploy.yml'))" && echo ok` (YAML parses) and read the step once more for quoting. No other tests cover the workflow.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml docs/deploy.md api/README.md web/README.md
git commit -m "ci+docs: signed smoke test; origin-protection runbook and rate-limit rule"
```

---

### Checkpoint A (controller, owner go-ahead): rollout step 1

1. Owner confirms Vercel's OIDC issuer mode is **Team**.
2. Merge the branch to `main`, push (owner go-ahead); watch `deploy.yml` (smoke test: signed health/ready 200, unsigned `/api/meta` 403).
3. Read `VercelApiRoleArn` (`aws cloudformation describe-stacks --stack-name KesslerApp …` with `AWS_PROFILE=kessler-agent`); with the owner's go-ahead set it in Vercel for production (`vercel env add AWS_ROLE_ARN production`) and redeploy production (`vercel redeploy <current production URL> --prod` or an empty push).
4. Verify live: the site loads data; no 502s from `/api/*`.

### Task 5: Enforce IAM on the function URL

**Files:**
- Modify: `infra/cdk.json` (`"api_url_auth": "AWS_IAM"`), `infra/tests/test_app_stack.py` (`test_cdk_json_caps_api_concurrency_and_starts_with_an_open_url` → expects `AWS_IAM`; rename to `test_cdk_json_caps_api_concurrency_and_enforces_iam`)

- [ ] **Step 1:** Update the test's expectation to `AWS_IAM` and rename it; run `cd infra && uv run pytest -q` → fails.
- [ ] **Step 2:** Set `"api_url_auth": "AWS_IAM"` in `infra/cdk.json`; run again → passes.
- [ ] **Step 3: Commit**

```bash
git add infra/cdk.json infra/tests/test_app_stack.py
git commit -m "feat(infra): enforce IAM auth on the API function URL"
```

### Checkpoint B (controller, owner go-ahead): rollout step 2

Push; watch `deploy.yml` (smoke test now asserts an unsigned 403). Verify live: `curl -s -o /dev/null -w '%{http_code}' "<function URL>api/health"` → 403; the site loads data. On failure: set `api_url_auth` back to `NONE`, push.

### Task 6: Retire the origin secret

**Files:**
- Delete: `api/app/api/auth.py`
- Modify: `api/app/api/main.py` (remove the `install_origin_auth` import and call), `api/app/config.py` (remove `origin_secret` from `Settings` and its SSM/env field list; `PRODUCTION_PARAMETERS = ("DATABASE_URL",)`; fix the comment above it)
- Modify: `api/tests/test_api.py` (replace `test_origin_secret_required_except_health` with the test below), `api/tests/test_aws.py` (production-parameter tests use `DATABASE_URL` only; drop `origin_secret` assertions)
- Modify: `web/src/lib/proxy.ts` (remove `ORIGIN_SECRET` from `ProxyEnv` and the `x-origin-auth` header), `web/tests/unit/proxy.test.ts` (drop `ORIGIN_SECRET` from `ENV`; assert no `x-origin-auth` is sent)
- Modify: `.github/workflows/deploy.yml` (the `else` branch of the smoke test goes: IAM is always enforced now — keep the `AWS_IAM` check unconditional), `docs/deploy.md`, `api/README.md`, `web/README.md` (remove secret instructions; add "delete the old secret" steps)

- [ ] **Step 1: Write the failing tests**

```python
def test_no_request_needs_an_origin_secret(world, migrated, store, monkeypatch):
    monkeypatch.setenv("ORIGIN_SECRET", "s3cret")  # a leftover value must change nothing
    c, db = make_client(migrated, store)
    with c:
        assert c.get("/api/meta").status_code == 200
        assert c.get("/api/meta", headers={"X-Origin-Auth": "wrong"}).status_code == 200
    db.close()
```

In `api/tests/test_aws.py`, change `test_load_settings_requires_production_parameters` to omit `DATABASE_URL` and expect `match="/kessler/DATABASE_URL"`, and add:

```python
def test_production_settings_no_longer_need_an_origin_secret(aws, monkeypatch):
    monkeypatch.setenv("SSM_PREFIX", "/kessler/")
    clear_env(monkeypatch, "DATABASE_URL")
    put_params({"DATABASE_URL": "postgresql://neon/db"})
    assert load_settings().database_url == "postgresql://neon/db"
```

Web: in `web/tests/unit/proxy.test.ts`, the first test asserts `expect(sent.get("x-origin-auth")).toBeNull();` with `ENV` no longer containing `ORIGIN_SECRET`.

- [ ] **Step 2:** Run `cd api && uv run pytest -q` and `cd web && npx vitest run tests/unit/proxy.test.ts` → the new/changed tests fail.
- [ ] **Step 3:** Make the code changes listed under Files.
- [ ] **Step 4:** Run the full API, infra and web checks from the Global Constraints → all pass; `grep -rn "ORIGIN_SECRET\|origin_secret\|x-origin-auth" api/app web/src .github` → no matches.
- [ ] **Step 5: Commit**

```bash
git add -A api/app api/tests web/src/lib/proxy.ts web/tests/unit/proxy.test.ts .github/workflows/deploy.yml docs/deploy.md api/README.md web/README.md
git commit -m "feat: retire the origin secret — IAM auth protects the API origin"
```

### Checkpoint C (controller, owner go-ahead): rollout step 3

1. Push; watch `deploy.yml`.
2. With the owner's go-ahead: `vercel env rm ORIGIN_SECRET production --yes` (controller, Vercel CLI) and redeploy production; the owner deletes `/kessler/ORIGIN_SECRET` from SSM with their admin login (`aws ssm delete-parameter --name /kessler/ORIGIN_SECRET`; no secret value is shown).
3. With the owner's go-ahead: add the WAF rule with the command recorded in `docs/deploy.md` (and publish it if the CLI requires); confirm with `vercel firewall rules list`.
4. Verify live: the site works; unsigned function-URL calls return 403; a burst of 310 quick `/api/meta` requests from one IP gets 429s after 300 (run once, then stop).
