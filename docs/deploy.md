# Go-live runbook

This is the one-time checklist to take Kessler from a working local checkout to a live
site at `leo.kudayyurter.dev`, backed by AWS Lambda (us-east-2) and a Neon Postgres database,
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

Then check that `ingest_runs` recorded both jobs via the API (see step 7 for the Function URL):

```bash
curl -s -H "x-origin-auth: $(aws ssm get-parameter --name /kessler/ORIGIN_SECRET \
  --with-decryption --query Parameter.Value --output text)" "<function url>api/meta" | head -c 2000
```

## 7. Verify the Function URL

```bash
URL=$(aws cloudformation describe-stacks --stack-name KesslerApp \
  --query "Stacks[0].Outputs[?OutputKey=='ApiFunctionUrl'].OutputValue" --output text)

curl -s -o /dev/null -w '%{http_code}\n' "${URL}api/health"                            # 200
curl -s -o /dev/null -w '%{http_code}\n' "${URL}api/meta"                              # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "x-origin-auth: $(aws ssm get-parameter \
  --name /kessler/ORIGIN_SECRET --with-decryption --query Parameter.Value --output text)" \
  "${URL}api/meta"                                                                     # 200
```

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
builds and pushes both images, runs `cdk deploy KesslerApp`, runs the `migrate` job, and smoke-tests
the Function URL — see `.github/workflows/deploy.yml`. The `migrate` job runs right after the
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
- Add the custom domain `leo.kudayyurter.dev` to the project. Vercel will show a pending DNS
  record; the owner then adds, at the domain registrar for `kudayyurter.dev`:

  ```
  CNAME  leo  cname.vercel-dns.com
  ```

## 10. Verify the site

Visit `https://leo.kudayyurter.dev` and confirm:

- The globe renders with debris objects.
- The charts load real data.
- `curl -s -D - -o /dev/null "https://leo.kudayyurter.dev/api/globe/snapshot"` shows
  `x-vercel-cache: MISS` (or similar) on the first request and `x-vercel-cache: HIT` on the
  second, within the snapshot's cache window.

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

**6-month AWS free-plan reminder:** before the AWS free plan ends, upgrade the account to a
paid plan (expected cost about $0–2/month with this workload) or it will be closed and the
site will go down.
