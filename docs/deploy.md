# Go-live runbook

This is the one-time checklist to take LEO Debris from a working local checkout to a live
site at `leo.kudayyurter.dev`, backed by AWS Lambda (us-east-2) and a Neon Postgres database,
deployed automatically from `main` via GitHub Actions.

`<...>` marks a value the owner supplies at run time. None of these values are ever committed
to the repo.

## 1. Prerequisites

- `aws login` (or otherwise have AWS credentials for the target account active in the shell).
- A [Neon](https://neon.tech) project in region **AWS US East 2 (Ohio)**, with its **pooled**
  connection string (contains `-pooler-` in the hostname, and `sslmode=require`).
- A Space-Track.org username and password (for satellite catalog and GP ingest).
- An alert email address, for AWS Budgets and CloudWatch alarm notifications.

## 2. Bootstrap and quota check

```bash
npx -y aws-cdk@2.1143.0 bootstrap aws://<account>/us-east-2
aws lambda get-account-settings --query AccountLimit.ConcurrentExecutions
```

New AWS accounts are sometimes limited to 10 concurrent Lambda executions. If the value printed
above is below 100, edit `infra/cdk.json` and set `"api_reserved_concurrency": 0` (this disables
reserved concurrency on `leo-api` rather than reserving more than the account has), then request
a quota increase: Service Quotas console → AWS services → Lambda → **Concurrent executions**.

## 3. Secrets

Store secrets in SSM Parameter Store as `SecureString`s under `/leo/`. Nothing here is ever
committed to the repo or a CDK template.

Shell history keeps whatever you type, so either prefix each command with a space (many shells
then skip adding it to history), or write the value to a file first and delete the file
afterward.

```bash
 aws ssm put-parameter --type SecureString --name /leo/DATABASE_URL --value '<neon pooled connection string>'
 aws ssm put-parameter --type SecureString --name /leo/SPACETRACK_USER --value '<space-track username>'
 aws ssm put-parameter --type SecureString --name /leo/SPACETRACK_PASS --value '<space-track password>'
 aws ssm put-parameter --type SecureString --name /leo/ORIGIN_SECRET --value "$(openssl rand -hex 32)"
```

`ORIGIN_SECRET` is generated locally with `openssl rand -hex 32` — copy the printed value now;
it is also needed in step 9 (Vercel) and step 7 (verification).

## 4. Registry and CI stacks

```bash
cd infra
npx -y aws-cdk@2.1143.0 deploy LeoRegistry LeoCi --require-approval never
```

This creates the ECR repository `leo-api` (keeps the newest 10 images, with a repository policy
that lets Lambda pull from it) and the GitHub OIDC provider plus the `leo-github-deploy` IAM role
that GitHub Actions will assume on `main`. Note the `DeployRoleArn` output — it is needed in
step 8.

## 5. First images and app stack

```bash
aws ecr get-login-password --region us-east-2 | \
  docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-2.amazonaws.com

cd api
TAG="$(git rev-parse HEAD)"
REPO="<account>.dkr.ecr.us-east-2.amazonaws.com/leo-api"
for target in api jobs; do
  docker buildx build --platform linux/amd64 --provenance=false --push \
    --target "$target" -t "$REPO:$target-$TAG" .
done

cd ../infra
npx -y aws-cdk@2.1143.0 deploy LeoApp --require-approval never \
  -c image_tag="$TAG" -c alert_email="<alert email>"
```

AWS sends two confirmation emails to `<alert email>`: one for the SNS topic subscription
(`leo-jobs-errors` alarm) — click the confirm link — and none for AWS Budgets (budget
notifications need no subscription confirmation).

## 6. Migrate and load first data

```bash
aws lambda invoke --function-name leo-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"migrate"}' migrate-out.json
cat migrate-out.json

aws lambda invoke --function-name leo-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"all"}' ingest-out.json
cat ingest-out.json
```

Then check that `ingest_runs` recorded both jobs via the API (see step 7 for the Function URL
and the `x-origin-auth` header):

```bash
curl -s -H "x-origin-auth: <origin secret>" "<function url>api/meta" | head -c 2000
```

## 7. Verify the Function URL

```bash
URL=$(aws cloudformation describe-stacks --stack-name LeoApp \
  --query "Stacks[0].Outputs[?OutputKey=='ApiFunctionUrl'].OutputValue" --output text)

curl -s -o /dev/null -w '%{http_code}\n' "${URL}api/health"                            # 200
curl -s -o /dev/null -w '%{http_code}\n' "${URL}api/meta"                              # 403
curl -s -o /dev/null -w '%{http_code}\n' -H "x-origin-auth: <origin secret>" "${URL}api/meta"  # 200
```

`$URL` already ends with a trailing slash — the paths above have no leading slash.

## 8. GitHub

Create the repository (empty, no README/license) at `namelessmonarch0/leo-debris`, then run a
secret scan of the full local history before it ever leaves this machine:

```bash
docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest git /repo
```

Fix anything it flags, then push:

```bash
git remote add origin https://github.com/namelessmonarch0/leo-debris.git
git push -u origin main
```

In the repo's Settings → Secrets and variables → Actions → **Variables**, add:

- `AWS_DEPLOY_ROLE_ARN` = the `DeployRoleArn` output from step 4.
- `ALERT_EMAIL` = `<alert email>` (same address as step 5).

From here on, every push to `main` that touches `api/`, `infra/` or the deploy workflow itself
builds and pushes both images, runs `cdk deploy LeoApp`, runs the `migrate` job, and smoke-tests
the Function URL — see `.github/workflows/deploy.yml`.

## 9. Vercel

- New project, imported from `namelessmonarch0/leo-debris`, **Root Directory** `web`.
- Project environment variables (Production and Preview):
  - `API_ORIGIN_URL` = the Function URL from step 7, **without** the trailing slash.
  - `ORIGIN_SECRET` = the value generated in step 3.
- Deploy.
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
aws ssm put-parameter --type SecureString --name /leo/ORIGIN_SECRET --value "$NEW_SECRET" --overwrite
```

Update `ORIGIN_SECRET` in the Vercel project (Production + Preview) to the same value and
redeploy the web app. Then force `leo-api` to drop its warm containers, so every invocation
re-reads SSM:

```bash
aws lambda update-function-configuration --function-name leo-api \
  --description "rotated $(date -u +%F)"
```

**Rerun a job manually** (e.g. after a failed scheduled ingest):

```bash
aws lambda invoke --function-name leo-jobs --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 900 --payload '{"job":"ingest-gp"}' out.json && cat out.json
```

**Read logs:**

```bash
aws logs tail /aws/lambda/leo-jobs --since 1d
aws logs tail /aws/lambda/leo-api --since 1d
```

**Rollback:** redeploy `LeoApp` with an older, known-good `image_tag` (a previous commit SHA
still present in the ECR repository, which keeps the newest 10 images):

```bash
cd infra
npx -y aws-cdk@2.1143.0 deploy LeoApp --require-approval never \
  -c image_tag="<older commit sha>" -c alert_email="<alert email>"
```

**6-month AWS free-plan reminder:** before the AWS free plan ends, upgrade the account to a
paid plan (expected cost about $0–2/month with this workload) or it will be closed and the
site will go down.
