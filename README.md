# Pactline

Pactline is a secure Word-document collaboration application for companies exchanging and negotiating contracts. It preserves stable paragraph identities across DOCX versions, attributes every external action to a named account, and locks only when both parties agree to the same version.

## Implemented foundation

- Responsive contract review workspace with natural paragraph editing, client review, history, audit, proposal, detail, and sharing surfaces.
- Server-side external reviewer authentication using PBKDF2-SHA256 password hashes, opaque secure cookies, expiry, lockout, and revocable sessions.
- Owner-controlled temporary access creation; generated passwords are returned exactly once and are never stored in plaintext.
- Durable paragraph blocks and paragraph proposals with optimistic version checks, stale-edit prevention, and attributed audit records.
- Correct proposal acceptance in the interface: accepted language replaces the clause and creates the next version.
- Transactional server workflow for accept, reject, and counter decisions with stale-version and lock checks.
- Relational D1 model for internal users, contracts, parties, named access accounts, approvals, stable clauses, immutable versions, proposals, agreements, document objects, audit events, and reliable integration delivery.
- R2 binding and authenticated DOCX upload endpoint with size/type checks, SHA-256 integrity metadata, pending malware-scan state, and cleanup on metadata failure.
- Genuine `.docx` generation plus safe client-side inspection before an imported file can be mapped.
- Initiator agreement endpoint; a contract locks only after both party records agree to the same version.
- Outbox events for CRM and direct-notification delivery after locking.
- Narrow AI, CRM, notification, and ONLYOFFICE adapter boundaries.
- Generated migrations and product-specific automated checks.

## External activation required

The following capabilities intentionally fail closed until their provider configuration is supplied:

- Production email delivery for temporary reviewer credentials and account recovery.
- ONLYOFFICE Document Server URL and JWT secret for live embedded editing.
- AI provider base URL and API key.
- CRM provider endpoint and API key.
- Slack or Teams notification endpoint and API key.
- Malware scanning worker for newly uploaded DOCX objects.
- Sites hosting must be enabled for the workspace before D1/R2 provisioning and deployment.

Copy `.env.example` to a local ignored environment file and populate values there. Never add provider keys to browser code or use `NEXT_PUBLIC_` prefixes.

## Data and document rules

- `document_blocks.block_key` is unique within a contract and persists across versions.
- Uploaded documents do not replace authoritative state until parsing, mapping, and malware review complete.
- Proposal decisions are server-authorized and version-scoped.
- Every accepted change creates an immutable full-clause snapshot.
- Audit entries are append-only; corrections create new events.
- Agreement is bound to one `version_number`; any later accepted change requires fresh agreement.
- Integration delivery uses the outbox table so CRM or messaging outages do not roll back a legal-state transition.

## Commands

```bash
npm install
npm run dev
npm run db:generate
npm run lint
npm test
```

`npm test` includes the production build and verifies product, credential-safety, and migration invariants.

See [`docs/PRODUCTION_READINESS.md`](docs/PRODUCTION_READINESS.md) for implemented controls, remaining release gates, and the staging checklist.
