# Pactline

Pactline is a serverless contract lifecycle and Word-negotiation application. A customer can manage suppliers, generate agreements from reusable DOCX templates, organize contract and compliance records in a document vault, extract metadata for human confirmation, search confirmed knowledge, and monitor renewals. Suppliers use a company portal to view current and expired agreements, download shared records, submit their own DOCX, and propose paragraph-level edits. A final Word version locks only after both parties agree to that same version.

## Architecture

- React owner workspace, portfolio manager, and supplier portal.
- Next-style routes compiled by Vinext/Vite to Cloudflare Workers.
- Cloudflare D1 for organizations, relationships, contract structure, proposals, versions, portal sessions, metadata, compliance requirements, alerts, and audit events.
- Cloudflare R2 for original and generated DOCX/PDF bytes; D1 stores metadata and object keys, never file blobs.
- Workers AI embeddings plus Vectorize for organization-scoped semantic search, with a D1 keyword fallback when the free AI bindings are unavailable locally.
- Groq `openai/gpt-oss-120b` assistant with strict structured output, deterministic out-of-scope refusal, and owner-confirmed application.
- Groq-assisted DOCX/PDF extraction with source references, a deterministic fallback, OCR detection, and mandatory human confirmation before extracted content affects search or lifecycle data.
- Daily Worker cron checks for renewal, expiration, and missing-compliance alerts. Alert creation is deterministic; AI does not decide compliance.
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

## Version Two demo

- Customer portfolio: `/manage`
- Supplier portal: `/portal`
- Supplier username: `supplier.reviewer`
- Supplier password: `SupplierDemo!2026`

The seeded portfolio includes a current MSA, an expired NDA, an insurance certificate, an invoice, lifecycle alerts, and a reusable Services Agreement template. Uploaded PDF and DOCX records can be extracted and reviewed; only confirmed fields and clauses become searchable. The supplier portal is organization-scoped and uses independent revocable sessions rather than the earlier contract-specific demo login.

This remains a demo-first implementation. Before real customer contracts, connect malware scanning, email/password recovery, durable background extraction for large files, OCR for scanned PDFs, legal-retention policies, and broader cross-tenant/security testing.

## Local commands

```bash
npm install
npm run dev
npm run lint
npm test
npm run db:generate
```

`npm test` builds the production Worker and runs database migration, concurrency-guard, DOCX/template, authentication, AI-scope, tenant-boundary, and architecture tests.

See [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md), [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md), and [SECURITY.md](SECURITY.md) before using real contracts.
