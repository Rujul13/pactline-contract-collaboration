# Security policy

Pactline handles confidential legal documents. Do not include customer documents, credentials, access links, tokens, or personal data in a public issue.

## Reporting

Report suspected vulnerabilities privately to the repository owner through GitHub's private vulnerability reporting feature. Include the affected route, prerequisites, impact, and a minimal reproduction using synthetic data.

## Supported branch

Only the latest `main` branch is supported during pre-release development.

## Release policy

- Production dependencies must pass `npm audit --omit=dev --audit-level=high`.
- Authentication, authorization, upload quarantine, version-conflict, audit, and backup/restore tests are release gates.
- Secrets belong only in the hosting environment and must never use a browser-exposed prefix.
- Uploaded documents are marked `pending`, but external malware scanning and enforced quarantine are not connected yet. Only synthetic or trusted documents may be used until that release gate is implemented.

## Current development-tool exception

As of August 4, 2026, the production dependency audit reports zero vulnerabilities. The complete development tree still reports one high-severity advisory through the latest Cloudflare local-development toolchain (`miniflare`/`undici`) and moderate legacy tooling under `drizzle-kit`. The available automated fix would force incompatible downgrades, so it is not applied. Local development servers must bind only to trusted interfaces, and this exception must be reevaluated before every release.
