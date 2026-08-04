# Pactline production readiness

## Implemented in this hardening pass

- Durable paragraph-oriented document model aligned with the natural Word editing interface.
- Durable paragraph proposals with base-version checks and stale-text conflict detection.
- Private owner workspace API for contracts, paragraphs, proposals, parties, and document metadata.
- Dedicated external review route at `/review/:contractId`.
- Named reviewer login with PBKDF2-SHA256 password hashing, uniform verification work, eight-attempt lockout, expiry, opaque token hashing, revocable server sessions, and `HttpOnly; Secure; SameSite=Strict` cookies.
- Owner-only reviewer-access creation with one-time temporary password return and a maximum 90-day expiry.
- Reviewer-specific proposal submission limited to the assigned contract and permission.
- Owner-only paragraph proposal acceptance/rejection with optimistic concurrency, immutable snapshots, content hashes, and audit records.
- Payload limits and no-store cache controls on authentication and contract workspace responses.
- Automated build, schema, security, entropy, password verification, and stale-edit invariant tests.

## Required before real customer contracts

1. Enable hosted D1/R2 resources and apply every migration in a staging environment.
2. Connect the owner interface to the new workspace/access APIs; the current owner page still uses seeded demo state for its visual prototype.
3. Add a malware and content-disarm pipeline. Uploaded DOCX objects must remain quarantined until scan status is `clean`.
4. Add a background DOCX processor that preserves tables, lists, headers, footnotes, comments, images, and style runs. The browser parser currently handles headings and paragraphs only.
5. Configure a production document editor such as ONLYOFFICE with signed callbacks and review-mode restrictions if pixel-level Word fidelity is required.
6. Add transactional email delivery for one-time credentials, password reset, access revocation, and review notifications.
7. Add edge rate limiting by hashed IP and account, bot detection, security-event alerting, and organization-level allow/deny policies.
8. Add observability: structured logs, request correlation, error reporting, latency/error SLOs, audit export, backup/restore drills, and R2 retention policies.
9. Complete legal/security review covering data residency, encryption key management, subprocessors, retention, legal hold, e-signature requirements, and SOC 2 controls.
10. Run staging tests with representative contracts containing tables, exhibits, tracked changes, signatures, and documents near the size limit.

## Release gates

- No quarantined document can become authoritative.
- No client route trusts an account, company, contract, or actor supplied by the browser.
- Every mutation is authorized server-side, version-scoped, idempotent where retryable, and written to the audit log.
- Every accepted edit creates an immutable document snapshot and invalidates agreement on prior versions.
- Authentication, proposal, upload, version-conflict, revocation, backup, restore, accessibility, and responsive workflows pass in staging.
