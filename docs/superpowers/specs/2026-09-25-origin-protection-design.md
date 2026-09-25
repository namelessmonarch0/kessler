# Origin protection: IAM-authenticated API origin

Date: 2026-09-25. Status: design approved by the owner in conversation; this spec awaits their review.

Piece 2 of 5 from the repository audit of 2026-09-25 (`/tmp/kessler-repo-audit.md`): finding #2 — the public Lambda
function URL can be invoked by anyone who learns it, before any abuse control; `/api/health` bypasses the origin
secret and queries the database; there is no function-level concurrency ceiling; the budget only alerts.

## Owner decisions

- Full IAM authentication now: the Lambda function URL uses `AWS_IAM`; the Vercel proxy signs every request with
  short-lived credentials from Vercel OIDC federation (no stored keys).
- Only the production deployments of the Vercel project may call the API (previews may not).
- Add one Vercel WAF rate-limit rule on `/api/*`.
- Retire the origin secret (`x-origin-auth` / `ORIGIN_SECRET`) once IAM auth is enforced.

## Design

### Trust (CDK, `KesslerApp` — deployed by CI)

- IAM OIDC provider for `https://oidc.vercel.com/kudayyurter` (Vercel team issuer mode), audience
  `https://vercel.com/kudayyurter`.
- Role `kessler-vercel-api`, assumable via `sts:AssumeRoleWithWebIdentity` only when
  `oidc.vercel.com/kudayyurter:aud = https://vercel.com/kudayyurter` and
  `oidc.vercel.com/kudayyurter:sub = owner:kudayyurter:project:kessler:environment:production` (StringEquals).
- Its policy: `lambda:InvokeFunctionUrl` on `kessler-api` (condition `lambda:FunctionUrlAuthType = AWS_IAM`) and
  `lambda:InvokeFunction` on `kessler-api` (condition `lambda:InvokedViaFunctionUrl = true`). Nothing else.
- The GitHub deploy role (`kessler-github-deploy`, owned by the `KesslerCi` stack) gets the same two permissions
  through the `kessler-api` function's resource-based policy (same account, so that alone suffices), so the deploy
  smoke test can sign requests without redeploying `KesslerCi`.
- The function URL's auth type comes from CDK context `api_url_auth` (`NONE` | `AWS_IAM`, in `infra/cdk.json`);
  the stack output `VercelApiRoleArn` gives the role ARN.
- `api_reserved_concurrency` returns to 10 in `infra/cdk.json` (the account's Lambda concurrency quota is now
  1000).

### Signing (`web/src/lib/proxy.ts`)

- When `AWS_ROLE_ARN` is set, every upstream request is signed with SigV4 (service `lambda`, region from
  `AWS_REGION`, default `us-east-2`) using `aws4fetch`, with credentials from
  `@vercel/oidc-aws-credentials-provider` (`awsCredentialsProvider({ roleArn })`, which reads the function's OIDC
  token and caches credentials until expiry). Streaming responses pass through unchanged.
- Without `AWS_ROLE_ARN` (local development and tests) requests are unsigned, as today.
- A failure to obtain credentials returns the proxy's existing `502 unavailable` error body (never a stack trace).
- The proxy refuses `/api/ready` with 404 (readiness is for direct, signed calls only).

### Health

- `GET /api/health`: liveness only — `{"status": "ok"}`, no database access.
- `GET /api/ready`: readiness — runs `SELECT 1` and returns `{"status": "ok", "gp_age_hours": …}` (moved from
  health); 503 when the database is unavailable.

### Smoke test (`.github/workflows/deploy.yml`)

Using the deploy role's credentials with `curl --aws-sigv4 "aws:amz:us-east-2:lambda"`: signed `/api/health` →
200, signed `/api/ready` → 200; once `api_url_auth` is `AWS_IAM`, an unsigned request → 403. While it is `NONE`,
the unsigned check is skipped (it would return 200/403 depending on the secret).

### Rate limit (Vercel WAF, Hobby plan: one rule)

Rule "api rate limit": condition path starts with `/api/`; fixed window 60 s; 300 requests per IP; action 429.
Firewall configuration lives in Vercel, not the repo: the exact `vercel firewall rules add …` command is recorded in
`docs/deploy.md` and applied during rollout with the owner's go-ahead.

### Retiring the origin secret

After IAM is enforced: remove `install_origin_auth` and `OPEN_PATHS` (`api/app/api/auth.py`), `origin_secret` from
`Settings` and `ORIGIN_SECRET` from the required production parameters (`api/app/config.py`), the proxy's
`x-origin-auth` header and `ORIGIN_SECRET` env handling; then delete the Vercel env var (`vercel env rm
ORIGIN_SECRET production`) and the SSM parameter `/kessler/ORIGIN_SECRET` (owner's admin login; no secret value is
handled).

### Rollout (three pushes, each with a one-line rollback)

1. Trust role, deploy-role URL permissions, signing proxy, health/ready split, proxy refusal of `/api/ready`,
   concurrency 10, smoke test (signed checks) — with `api_url_auth = NONE`. Owner confirms Vercel issuer mode is
   **Team** and sets `AWS_ROLE_ARN` (from the `VercelApiRoleArn` output) and `AWS_REGION=us-east-2` for production.
   Verify live: the site keeps working with `AWS_ROLE_ARN` set (a failed credential exchange would return 502, so a
   working site proves the OIDC → STS exchange and signing run). AWS only validates signatures once the URL is
   `AWS_IAM`, so a signature AWS would reject surfaces at step 2 — hence step 2's one-line rollback. Rollback:
   unset `AWS_ROLE_ARN` in Vercel.
2. `api_url_auth = AWS_IAM`. Verify immediately after the deploy: an unsigned request to the function URL returns
   403 from AWS; the site loads data (a signing mismatch would show as 403s through the proxy); the smoke test's
   signed and unsigned checks pass. Rollback: set it back to `NONE` and push (site data unavailable for the few
   minutes of that deploy at worst).
3. Retire the secret (code + Vercel env + SSM) and add the WAF rule. Verify the site, the smoke test, and that the
   rule appears in `vercel firewall rules list`. Rollback: remove the WAF rule (`vercel firewall rules remove …`);
   the secret removal needs no rollback while IAM is enforced (IAM is the protection).

## Units

- `infra/kessler_infra/app_stack.py`: OIDC provider, Vercel role, function URL auth type from context, resource
  policy for the deploy role, `VercelApiRoleArn` output; `infra/cdk.json`: `api_url_auth`, concurrency 10;
  `infra/app.py`: pass `api_url_auth` through.
- `api/app/api/routes.py`: `/health` liveness, `/ready` readiness; later `auth.py`/`config.py`/`main.py` secret
  removal.
- `web/src/lib/proxy.ts` (+ `web/package.json`: `aws4fetch`, `@vercel/oidc-aws-credentials-provider`).
- `.github/workflows/deploy.yml`: signed smoke test.
- `docs/deploy.md`, `api/README.md`, `web/README.md`: OIDC setup, env vars, rate-limit command, rollback steps.

## Testing

- Infra (CDK assertions): OIDC provider URL and client ID (audience); role trust conditions exactly (aud, sub —
  production of `kessler` only, StringEquals); role policy = the two actions on `kessler-api` with their conditions
  and nothing else; function URL auth type follows `api_url_auth` (`NONE` default, `AWS_IAM` when set); resource
  policy grants the deploy role both actions; reserved concurrency 10; `VercelApiRoleArn` output.
- API: `/api/health` returns 200 with the database pool closed/unreachable; `/api/ready` returns 200 with the
  database and 503 without; after secret retirement, no request is rejected for a missing `x-origin-auth`.
- Web proxy (vitest): with `AWS_ROLE_ARN` set, the upstream request carries `Authorization` (AWS4-HMAC-SHA256,
  service `lambda`, region `us-east-2`), `x-amz-date` and `x-amz-security-token`; credentials are requested once
  across several requests (cached); without it, no signing headers; a credentials failure yields `502 unavailable`;
  `/api/ready` is refused with 404; response streaming and header allow-lists unchanged.
- Live, per rollout step, as listed above.

## Out of scope

Rate-limiting inside the API; changes to the Vercel project's deployment protection; the AI chat endpoint's own
abuse controls (the AI piece).
