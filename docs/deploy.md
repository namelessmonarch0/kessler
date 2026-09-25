# Go-live runbook

This is the one-time checklist to take Kessler from a working local checkout to a live
site at `kessler.kudayyurter.dev`, backed by AWS Lambda (us-east-2) and a Neon Postgres database,
deployed automatically from `main` via GitHub Actions.

`<...>` marks a value the owner supplies at run time. None of these values are ever committed
to the repo.

**Shell:** every command block below is bash (`VAR=...` assignments, `for...do...done`,
`$(...)` substitutions). If your login shell is something else (e.g. fish, zsh with different
globbing), start a bash session first — `bash` — and run every block inside it.

**Working directory:** unless a block itself contains a `cd`, run it from the **repository
root**. Every block below that `cd`s into a subdirectory also `cd`s back out before it ends, so
the "start at the repo root" rule holds true at the start of every numbered step, not just the
first one.

## 1. Prerequisites

- `aws login` (or otherwise have AWS credentials for the target account active in the shell).
- Docker, with the `buildx` plugin (`docker buildx version` should print something) — used to
  build the Lambda images.
- [`uv`](https://docs.astral.sh/uv/) (this repo pins 0.12.17 in its lockfiles).
- Node.js 22 or newer (for `npx aws-cdk`; CI itself pins Node 22).
- A [Neon](https://neon.tech) project in region **AWS US East 2 (Ohio)**, with its **pooled**
  connection string (contains `-pooler-` in the hostname, and `sslmode=require`).
- A Space-Track.org username and password (for satellite catalog and GP ingest).
- An alert email address, for AWS Budgets and CloudWatch alarm notifications.
- If the target AWS account already has a GitHub OIDC provider
  (`token.actions.githubusercontent.com`) from an earlier project, step 4 below will fail — an
  account can only have one, and `KesslerCi` tries to create it. Importing an existing provider into
  this stack is out of scope for this runbook: either delete the old, unused provider first (IAM
  console → Identity providers), or stop here and ask before proceeding.

## 2. Bootstrap and quota check

```bash
npx -y aws-cdk@2.1143.0 bootstrap aws://<account>/us-east-2
aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions
```

New AWS accounts are sometimes limited to 10 concurrent Lambda executions. `kessler-api` reserves 10
of them, and Lambda always keeps 100 unreserved for the rest of the account, so reserving 10
needs a quota of at least **110**. If the value printed above is below 110, edit `infra/cdk.json`
and set `"api_reserved_concurrency": 0` (this disables reserved concurrency on `kessler-api` rather
than reserving more than the account has). **Commit that change** — CI deploys with whatever
`infra/cdk.json` says in the repo, so an edit that's only on disk here has no effect once step 8
pushes to `main`. Then request a quota increase: Service Quotas console → AWS services → Lambda
→ **Concurrent executions**. Once the increase is granted, set `api_reserved_concurrency` back
to `10` and commit that too.

## 3. Secrets

**Owner types this personally** — these commands carry real secret values, so run them yourself
rather than having an assistant run them for you.

Store secrets in SSM Parameter Store as `SecureString`s under `/kessler/`. Nothing here is ever
committed to the repo or a CDK template.

Shell history keeps whatever you type. In bash, a leading space only skips history when
`HISTCONTROL` includes `ignorespace` or `ignoreboth` — check first with `echo $HISTCONTROL`.
If it's not set, either run `set +o history` before this block and `set -o history` after (or
delete the recorded lines afterward with `history -d <offset>`), or write each value to a file
first and delete the file afterward.

```bash
 aws ssm put-parameter --type SecureString --name /kessler/DATABASE_URL --value '<neon pooled connection string>'
 aws ssm put-parameter --type SecureString --name /kessler/SPACETRACK_USER --value '<space-track username>'
 aws ssm put-parameter --type SecureString --name /kessler/SPACETRACK_PASS --value '<space-track password>'
 ORIGIN_SECRET="$(openssl rand -hex 32)"
 echo "$ORIGIN_SECRET"   # shown here only, in this terminal — not stored anywhere else
 aws ssm put-parameter --type SecureString --name /kessler/ORIGIN_SECRET --value "$ORIGIN_SECRET"
```

Copy the printed `ORIGIN_SECRET` value now — it is needed in step 9 (Vercel), where it must be
typed into the Vercel UI directly (there's no CLI to hand it to). Steps 6 and 7 read it back
from SSM automatically, so you don't need to keep it around for those.

## 4. Registry and CI stacks

```bash
cd infra
npx -y aws-cdk@2.1143.0 deploy KesslerRegistry KesslerCi --require-approval never
cd ..
```

This creates the ECR repository `kessler-api` (a lifecycle rule keeps only the newest 10 images —
each deploy pushes 2, one `api-<sha>` and one `jobs-<sha>`, so that's 5 deploys' worth of
rollback headroom) with a repository policy that lets Lambda pull from it, and the GitHub OIDC
provider plus the `kessler-github-deploy` IAM role that GitHub Actions will assume on `main`. Note
the `DeployRoleArn` output — it is needed in step 8.

GitHub signs Actions tokens with an immutable subject (`repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:refs/heads/main`). Put that prefix in `infra/cdk.json` as `github_subject_prefix` (read it with `gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix`), or the deploy job fails with "Not authorized to perform sts:AssumeRoleWithWebIdentity".

## 5. First images and app stack

This step starts at the repository root (left there by step 4).

```bash
aws ecr get-login-password --region us-east-2 | \
  docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-2.amazonaws.com

cd api
TAG="$(git rev-parse HEAD)"
REPO="<account>.dkr.ecr.us-east-2.amazonaws.com/kessler-api"
for target in api jobs; do
  docker buildx build --platform linux/amd64 --provenance=false --push \
    --target "$target" -t "$REPO:$target-$TAG" .
done
cd ..

cd infra
npx -y aws-cdk@2.1143.0 deploy KesslerApp --require-approval never \
  -c image_tag="$TAG" -c alert_email="<alert email>"
cd ..
```

AWS sends one confirmation email to `<alert email>`, for the SNS topic subscription
(`kessler-jobs-errors` alarm) — click the confirm link, or alarm notifications won't arrive.
AWS Budgets alerts need no subscription confirmation.

`KesslerApp` also creates the `ingest-gp` schedule (every 6 hours, at minute 41) right away. If it
happens to fire between this step and step 6, that run will fail — the database tables don't
exist yet — and send one alarm email. That's expected and harmless: step 6 loads the data that
matters, and the next scheduled `ingest-gp` run (or a manual rerun, see Operations) succeeds
normally once the tables are there.

## 6. Migrate and load first data

```bash
aws lambda invoke --function-name kessler-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"migrate"}' migrate-out.json
cat migrate-out.json

aws lambda invoke --function-name kessler-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"all"}' ingest-out.json
cat ingest-out.json
```

Then check that `ingest_runs` recorded both jobs via the API (see step 7 for the Function URL). If
`infra/cdk.json`'s `api_url_auth` is `AWS_IAM`, sign this request as shown in "Origin protection"
below; while it's `NONE`, the origin secret alone is enough:

```bash
curl -s -H "x-origin-auth: $(aws ssm get-parameter --name /kessler/ORIGIN_SECRET \
  --with-decryption --query Parameter.Value --output text)" "<function url>api/meta" | head -c 2000
```

## 7. Verify the Function URL

`/api/health` is a liveness check only (no database); `/api/ready` additionally checks the
database. Neither needs the origin secret — but that's an application-level check; AWS itself
rejects *every* unsigned path, `/api/health` included, once `api_url_auth` is `AWS_IAM` (below),
before the request ever reaches the app.

```bash
URL=$(aws cloudformation describe-stacks --stack-name KesslerApp \
  --query "Stacks[0].Outputs[?OutputKey=='ApiFunctionUrl'].OutputValue" --output text)

curl -s -o /dev/null -w '%{http_code}\n' "${URL}api/health"                            # 200
curl -s "${URL}api/ready"                                                              # {"status":"ok","gp_age_hours":...}
curl -s -o /dev/null -w '%{http_code}\n' "${URL}api/meta"                              # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "x-origin-auth: $(aws ssm get-parameter \
  --name /kessler/ORIGIN_SECRET --with-decryption --query Parameter.Value --output text)" \
  "${URL}api/meta"                                                                     # 200
```

If `api_url_auth` is `AWS_IAM`, every one of the calls above needs SigV4 signing or AWS rejects it
before it reaches the app — see "Origin protection" below for the exact `curl --aws-sigv4` form.

`$URL` already ends with a trailing slash — the paths above have no leading slash.

## 8. GitHub

Create the repository (empty, no README/license) at `namelessmonarch0/kessler`.

Before pushing anything, set the deploy job's configuration in the new repo's Settings → Secrets
and variables → Actions:

- **Variables** → `AWS_DEPLOY_ROLE_ARN` = the `DeployRoleArn` output from step 4.
- **Secrets** → `ALERT_EMAIL` = `<alert email>` (same address as step 5; owner types this
  personally). It's a secret, not a variable, because this repository is public and Actions
  variables — unlike secrets — are visible to anyone who can see the repo.

Setting these *before* the first push matters: `.github/workflows/deploy.yml`'s `deploy` job is
guarded by `if: vars.AWS_DEPLOY_ROLE_ARN != ''`. If that variable isn't set yet when `main` is
first pushed, the job is skipped — silently, not failed — and go-live's first CI deploy never
actually runs.

Next, run a secret scan of the full local history before it ever leaves this machine:

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest git /repo
```

Fix anything it flags, then push:

```bash
git remote add origin https://github.com/namelessmonarch0/kessler.git
git push -u origin main
```

From here on, every push to `main` that touches `api/`, `infra/` or the deploy workflow itself
builds and pushes both images, runs `cdk deploy KesslerApp`, runs the `migrate` job, then the
`publish-globe` job, and smoke-tests the Function URL — see `.github/workflows/deploy.yml`.
`publish-globe` republishes the globe from the database as a new generation without fetching
anything, so the new API has one to serve within minutes (on a database with no element sets yet it
publishes nothing). The `migrate` job runs right after the
new code goes live, not before, so migrations must stay backward-compatible with the previous
release (the outgoing Lambda containers can still be warm and serving during that gap).

Open the repo's **Actions** tab → the `deploy` workflow run from this push → confirm it went
green (`api-tests`, `infra-tests`, and `deploy` all succeeded). If `deploy` shows as skipped,
`AWS_DEPLOY_ROLE_ARN` wasn't set in time — set it now and re-run from **Actions → deploy → Run
workflow**.

## 9. Vercel

- New project, imported from `namelessmonarch0/kessler`, **Root Directory** `web`.
- Project environment variables (Production and Preview) — **owner types this personally**:
  - `API_ORIGIN_URL` = the Function URL from step 7, **without** the trailing slash.
  - `ORIGIN_SECRET` = the value generated in step 3.
- Deploy. If the deployment shows **"Canceled by Ignored Build Step"**, that's `ignoreCommand`
  in `web/vercel.json` deciding this build has no relevant changes — click **Redeploy** to force
  it anyway.
- Add the custom domain `kessler.kudayyurter.dev` to the project. Vercel will show a pending DNS
  record; the owner then adds, at the domain registrar for `kudayyurter.dev`:

  ```
  CNAME  kessler  cname.vercel-dns.com
  ```

## 10. Verify the site

Visit `https://kessler.kudayyurter.dev` and confirm:

- The globe renders with debris objects.
- The charts load real data.
- `curl -s "https://kessler.kudayyurter.dev/api/globe/current"` returns the live generation
  (`{"generation": "…", …}`). Request that generation's snapshot twice:

  ```bash
  GEN="$(curl -s https://kessler.kudayyurter.dev/api/globe/current | sed 's/.*"generation":"\([^"]*\)".*/\1/')"
  curl -s -D - -o /dev/null "https://kessler.kudayyurter.dev/api/globe/snapshot?group=LEO&gen=$GEN"
  ```

  The first shows `x-vercel-cache: MISS` (or similar), the second `x-vercel-cache: HIT`, both with
  `cache-control: public, max-age=31536000, immutable`.

## 11. Operations

**Rotate `ORIGIN_SECRET`:**

```bash
NEW_SECRET="$(openssl rand -hex 32)"
echo "$NEW_SECRET"   # shown here only, in this terminal — not stored anywhere else
aws ssm put-parameter --type SecureString --name /kessler/ORIGIN_SECRET --value "$NEW_SECRET" --overwrite
```

Update `ORIGIN_SECRET` in the Vercel project (Production + Preview) to the printed value and
redeploy the web app. Then force `kessler-api` to drop its warm containers, so every invocation
re-reads SSM:

```bash
aws lambda update-function-configuration --function-name kessler-api \
  --description "rotated $(date -u +%F)"
```

**Rerun a job manually** (e.g. after a failed scheduled ingest):

```bash
aws lambda invoke --function-name kessler-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"ingest-gp"}' out.json && cat out.json
```

`ingest-gp` and `publish-globe` share a lock: a run that overlaps another waits for it, for at most
8 minutes, then fails with `QueryCanceled` (and the jobs alarm fires). Rerun it once the other run
has finished.

**A failed globe publication** (the deploy's `publish-globe` step failed, or `ingest-gp` failed
after writing the database): the site keeps serving the previous generation. Republish from the
database, without fetching anything:

```bash
aws lambda invoke --function-name kessler-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"publish-globe"}' out.json && cat out.json
```

**Read logs:**

```bash
aws logs tail /aws/lambda/kessler-jobs --since 1d
aws logs tail /aws/lambda/kessler-api --since 1d
```

**Rollback:** redeploy `KesslerApp` with an older, known-good `image_tag` (a previous commit SHA
still present in the ECR repository — it keeps the newest 10 images, i.e. the last 5 deploys,
since each deploy pushes 2: `api-<sha>` and `jobs-<sha>`):

```bash
cd infra
npx -y aws-cdk@2.1143.0 deploy KesslerApp --require-approval never \
  -c image_tag="<older commit sha>" -c alert_email="<alert email>"
```

**After reverting the API** to a release from before globe generations: that release reads only the
legacy `globe/LEO.bin.gz` and `globe/HIGH.bin.gz`, which the newer releases left in place but
stopped updating. Run `ingest-gp` once so they are fresh:

```bash
aws lambda invoke --function-name kessler-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"ingest-gp"}' out.json && cat out.json
```

**6-month AWS free-plan reminder:** before the AWS free plan ends, upgrade the account to a
paid plan (expected cost about $0–2/month with this workload) or it will be closed and the
site will go down.

## 12. Origin protection

The API's Lambda Function URL is IAM-authenticated (`api_url_auth` in `infra/cdk.json`): only the
Vercel proxy, via OIDC-federated short-lived credentials for the `kessler-vercel-api` role, and
the deploy workflow's smoke test, via `kessler-github-deploy`, may call it once it's enforced.
Full design: `docs/superpowers/specs/2026-09-25-origin-protection-design.md`.

### One-time setup

- Vercel → Project `kessler` → **Settings → Security** → "Secure backend access with OIDC
  federation" = **Team**.
- After `KesslerApp` deploys with the origin-protection infra, set the role ARN for
  **Production** only (previews may not call the API):

  ```bash
  aws cloudformation describe-stacks --stack-name KesslerApp \
    --query "Stacks[0].Outputs[?OutputKey=='VercelApiRoleArn'].OutputValue" --output text
  cd web
  npx vercel env add AWS_ROLE_ARN production   # paste the ARN above when prompted
  cd ..
  ```

  `API_ORIGIN_REGION` is not needed — the proxy defaults to `us-east-2`.
- Redeploy production so the new variable takes effect — a running deployment keeps the
  environment it was built with. Take the current production deployment's URL (the newest
  **Ready** row, unless you have rolled back since) and redeploy it to production:

  ```bash
  cd web
  npx vercel ls kessler --environment production --scope kudayyurter
  npx vercel redeploy <current production deployment URL> --target production --scope kudayyurter
  cd ..
  ```

  or the dashboard: **Deployments** → that deployment's **⋯** → **Redeploy**. Wait for the new
  deployment to be **Ready**; if it ends **Canceled** by the Ignored Build Step, redeploy from the
  dashboard with **Use project's Ignore Build Step** unchecked. (`redeploy` has no `--prod` flag.)
  An empty push to `main` does not work: `web/vercel.json`'s `ignoreCommand` cancels every build
  whose commits change nothing under `web/`.

### Rollout (three pushes)

1. **This code, with `api_url_auth = NONE`.** Push to `main`; the deploy workflow's smoke test
   signs `/api/health` and `/api/ready` with the deploy role's credentials (both expect 200) and
   still checks that the origin secret guards `/api/meta` (403 unsigned). Then set `AWS_ROLE_ARN`
   and redeploy (one-time setup above).

   **Gate — do not start step 2 without this line.** A working site proves little yet: AWS
   doesn't validate signatures while the URL is `NONE`. Load the site, then find this line in the
   new production deployment's runtime logs (or the dashboard: the deployment → **Logs**):

   ```
   proxy: signing as arn:aws:iam::<account>:role/kessler-vercel-api, credentials expire <time>
   ```

   ```bash
   cd web
   npx vercel logs --deployment <new production deployment URL> --since 1h --expand \
     --scope kudayyurter | grep "proxy: "
   cd ..
   ```

   Each function instance logs it once per credential lifetime (an hour), on its first `/api/*`
   request. If you see `proxy: signing failed: <error name>: <message>` instead, the message names
   the cause. The two common ones:
   - `InvalidIdentityTokenException` (e.g. "No OpenIDConnect provider found …"): the OIDC issuer
     mode isn't **Team**, so the token's issuer isn't `https://oidc.vercel.com/kudayyurter`. Fix
     it (one-time setup), then redeploy.
   - `AccessDenied` ("Not authorized to perform sts:AssumeRoleWithWebIdentity"): the token doesn't
     match the role's trust policy (`aud` `https://vercel.com/kudayyurter`, `sub`
     `owner:kudayyurter:project:kessler:environment:production`) — a different team or project
     name, or not a production deployment — or `AWS_ROLE_ARN` isn't the `VercelApiRoleArn`
     output.

   If neither line appears, the deployment you're reading was built without `AWS_ROLE_ARN`.

   **Rollback:** Instant Rollback to the previous production deployment — the dashboard's
   **Instant Rollback**, or `npx vercel rollback <previous production deployment URL>` (Hobby can
   only roll back to the immediately previous one: the deployment from before the redeploy).
   Unsetting `AWS_ROLE_ARN` alone changes nothing, since a running deployment keeps the
   environment it was built with; after the rollback, remove it too (`npx vercel env rm
   AWS_ROLE_ARN production`) so the next build doesn't pick it up. A rollback also turns off
   auto-assignment of production domains: new pushes won't go live until you undo it (the
   dashboard's **Undo Rollback**, or `npx vercel promote <deployment URL>`).

   **Before step 2** (read-only, your admin login): check that the role may invoke `kessler-api`
   through its URL — both actions must be `allowed`:

   ```bash
   ROLE=$(aws cloudformation describe-stacks --stack-name KesslerApp \
     --query "Stacks[0].Outputs[?OutputKey=='VercelApiRoleArn'].OutputValue" --output text)
   FN=$(aws lambda get-function --function-name kessler-api \
     --query Configuration.FunctionArn --output text)
   aws iam simulate-principal-policy --policy-source-arn "$ROLE" \
     --action-names lambda:InvokeFunctionUrl lambda:InvokeFunction --resource-arns "$FN" \
     --context-entries \
       "ContextKeyName=lambda:FunctionUrlAuthType,ContextKeyValues=AWS_IAM,ContextKeyType=string" \
       "ContextKeyName=lambda:InvokedViaFunctionUrl,ContextKeyValues=true,ContextKeyType=boolean" \
     --query "EvaluationResults[].[EvalActionName,EvalDecision]" --output text
   # lambda:InvokeFunctionUrl   allowed
   # lambda:InvokeFunction      allowed
   ```

   Keep the time between steps 1 and 2 short: until step 2 the URL is still `NONE` and
   `kessler-api` is capped at 10 concurrent executions, so unsigned callers who know the URL can
   occupy those slots (`/api/health` and `/api/ready` need no origin secret).
2. **Flip `api_url_auth` to `AWS_IAM`** in `infra/cdk.json`, commit, push. Verify immediately
   after the deploy: an unsigned request to the function URL now returns 403 from AWS — (`$URL`
   as fetched in step 7, ending in a trailing slash)

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' "${URL}api/health"   # 403
   ```

   — and the site still loads data for every kind of query the proxy signs: both globe groups
   (turn on **Higher orbits**), the charts with an **Owner** picked (their queries carry
   comma-separated filters such as `types=PAY,DEB,R/B`), a search containing a space (e.g.
   `ISS (ZARYA)`), and an object card (click an object). A signing mismatch shows as 403s from
   `/api/*`, and as `proxy: upstream rejected a signed request: 403 …` in the runtime logs. The
   smoke test's signed and unsigned checks must both pass.
   **Rollback:** set `api_url_auth` back to `NONE` and push — but that deploy takes 10+ minutes,
   with no site data meanwhile. Faster, with your admin login (seconds):

   ```bash
   aws lambda update-function-url-config --function-name kessler-api --auth-type NONE
   aws lambda add-permission --function-name kessler-api --statement-id public-url \
     --action lambda:InvokeFunctionUrl --principal "*" --function-url-auth-type NONE
   aws lambda add-permission --function-name kessler-api --statement-id public-invoke \
     --action lambda:InvokeFunction --principal "*" --invoked-via-function-url
   ```

   Then push `api_url_auth` = `NONE` anyway, so CloudFormation matches again (until then, any
   deploy from `main` re-applies `AWS_IAM`). Once that deploy is green, CloudFormation has added
   its own public permissions; remove the two hand-made ones, so a later emergency can add them
   again:

   ```bash
   aws lambda remove-permission --function-name kessler-api --statement-id public-url
   aws lambda remove-permission --function-name kessler-api --statement-id public-invoke
   ```
3. **Retire the origin secret; add the rate-limit rule.** Verify the site, the smoke test, and
   that the rule shows up in `vercel firewall rules list`.
   **Rollback:** remove the WAF rule (below); the secret removal itself needs no rollback once
   IAM is enforced — IAM is the protection.

### Rate-limit rule (Vercel WAF)

One rule on `/api/*`: fixed 60 s window, 300 requests per IP, action 429. Confirmed CLI syntax
(`cd web` first; add `--scope kudayyurter` if the CLI session isn't already scoped to the team):

```bash
cd web
npx vercel firewall rules add "api rate limit" \
  --condition '{"type":"path","op":"pre","value":"/api/"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 300 \
  --rate-limit-keys ip \
  --yes
npx vercel firewall publish --yes
cd ..
```

`firewall rules add` only stages a draft change — `firewall publish` is a separate, required step
that makes it live.

List and remove:

```bash
cd web
npx vercel firewall rules list
npx vercel firewall rules remove "api rate limit" --yes
npx vercel firewall publish --yes
cd ..
```

### Signed direct calls

Once `api_url_auth` is `AWS_IAM`, AWS rejects every unsigned request to the function URL,
including `/api/health`. Sign with SigV4 using credentials from any principal the trust policy or
the function's resource policy allows (the deploy role, or the Vercel role's own temporary
credentials); `$URL` is the Function URL, as fetched in step 7:

```bash
curl --aws-sigv4 "aws:amz:us-east-2:lambda" \
  --user "$AWS_ACCESS_KEY_ID:$AWS_SECRET_ACCESS_KEY" \
  -H "x-amz-security-token: $AWS_SESSION_TOKEN" \
  "${URL}api/health"
```
