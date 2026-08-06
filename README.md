# Pactline

Pactline is a serverless Word-contract negotiation application. An owner uploads or starts from a DOCX, shares a named reviewer account, receives paragraph-level proposals, accepts/rejects/counters them, and locks a final downloadable Word version only after both parties agree to the same version.

## Architecture

- React owner workspace and external reviewer portal.
- Next-style routes compiled by Vinext/Vite to Cloudflare Workers.
- Cloudflare D1 for contracts, paragraphs, proposals, versions, accounts, sessions, agreements, and audit events.
- Cloudflare R2 for original and generated DOCX bytes.
- Groq `openai/gpt-oss-120b` assistant with strict structured output, deterministic out-of-scope refusal, and owner-confirmed application.
- GitHub Actions with isolated staging and production resources, migrations, tests, deployment, and live smoke checks.

The active document model is `document_blocks` plus `paragraph_proposals`. Every accepted owner, reviewer, upload, or AI edit creates a full version snapshot. Optimistic database guards abort stale multi-statement mutations before related writes commit.

## Security boundaries

- Reviewer passwords use salted PBKDF2-SHA256 hashes.
- Reviewer sessions use revocable opaque tokens stored only as hashes.
- Cookies are HttpOnly, Secure, and SameSite=Strict.
- Reviewer actions are restricted to the contract and permission attached to the server-side session.
- AI has no execution tools and can only return `none`, `insert_clause`, or `replace_block`; the owner must confirm any mutation.
- DOCX uploads reject invalid and macro-enabled packages and enforce compressed and expanded size limits.

Uploaded documents currently remain marked `pending` because no malware-scanning provider is connected. Use only synthetic or trusted documents until quarantine enforcement is added. The paragraph pipeline does not preserve complex tables, images, comments, headers, footnotes, tracked changes, or full Word formatting.

## Local commands

```bash
npm install
npm run dev
npm run lint
npm test
npm run db:generate
```

`npm test` builds the production Worker and runs database migration, concurrency-guard, DOCX, authentication, AI-scope, and architecture tests.

See [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), and [SECURITY.md](SECURITY.md) before using real contracts.
