# Pactline phase-one readiness

## Ready for a small private demo

- Cloudflare D1 stores contracts, parties, paragraph content, reviewer access, proposals, immutable versions, agreements, sessions, and audit activity.
- Cloudflare R2 stores the original and generated DOCX files outside the database.
- The owner can create a contract from a DOCX, edit any paragraph, upload later DOCX versions, accept or reject client proposals, inspect history, agree, and download.
- A named client reviewer signs into a contract-specific workspace, proposes paragraph replacements, agrees to a version, and downloads the locked final DOCX.
- Any accepted edit creates a new immutable version. Agreement is version-specific and the contract locks only after both parties agree to the same version with no pending proposals.
- The generic sample is resettable and deliberately refuses private DOCX uploads. Private files must use a newly created contract with unique reviewer credentials.
- DOCX input is limited to 15 MB, macro-enabled packages are rejected, passwords are PBKDF2-hashed, sessions are opaque and revocable, and production dependencies have no known audit findings.
- ONLYOFFICE, email delivery, password recovery, Slack, Teams, and paid services remain disabled.

## Intentional phase-one limitations

- DOCX round-tripping is paragraph-oriented. Rich tables, images, comments, footnotes, headers, complex lists, and existing tracked-change markup are not preserved with full Microsoft Word fidelity.
- Uploaded files are labeled unscanned. Use only documents from people you trust until malware scanning and content disarm are added.
- Reviewer credentials are copied manually. There is no email, self-service password setup, or password reset flow yet.
- The product is designed for one owner and a handful of reviewers, not multi-tenant company deployment.
- D1 and R2 should remain inside their free allowances for this intended use, but Cloudflare account limits still apply.

## Gates before real customer or sensitive contracts

1. Add malware scanning and quarantine enforcement before a file becomes authoritative.
2. Add verified email invitations, password setup/reset, stronger account recovery, and optional MFA.
3. Add rate limiting, abuse protection, structured monitoring, alerts, backup/restore drills, and data-retention controls.
4. Test representative documents containing tables, exhibits, images, tracked changes, signatures, and near-limit file sizes.
5. Complete privacy, legal, data-residency, retention, e-signature, and security reviews.
6. Introduce ONLYOFFICE or another licensed document engine only if in-browser, pixel-level Word fidelity becomes a validated product need.

## Release rule

Use the hosted build for demonstrations and low-risk personal collaboration only. Do not upload confidential, regulated, or irreplaceable documents in this phase.
