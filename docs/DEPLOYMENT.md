# Deployment and rollback

## Environments

The `codex/phase-one-demo` branch deploys an isolated staging Worker, D1 database, and R2 bucket. Only `main` deploys the production resources. GitHub environments are named `staging` and `production`; enable required reviewers on the production environment before external use.

Repository secrets required by both environments:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `OWNER_PASSWORD`
- `GROQ_API_KEY`

The owner password hash is refreshed during deployment, while the owner session-signing secret is created only once per database. Normal deployments therefore do not log out every active owner session.

## Release flow

1. Push changes to `codex/phase-one-demo`.
2. Wait for the staging validation, migration, deployment, owner-login, workspace, and AI smoke checks.
3. Exercise the complete owner/reviewer cycle using synthetic documents.
4. Merge the tested commit to `main` after approval.
5. Confirm the production workflow and smoke checks succeed.

## Rollback

Application rollback is performed by selecting the last known-good commit in GitHub and running the deployment workflow for the appropriate branch. Database migrations must remain forward-compatible: do not roll application code back across a destructive migration unless the database is restored first. Record the D1 Time Travel bookmark before production schema changes and verify R2 retention separately.

Never copy production D1 or R2 data into staging unless it has been sanitized.
