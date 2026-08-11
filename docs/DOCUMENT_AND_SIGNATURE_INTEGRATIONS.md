# Document editing and e-signature integration evaluation

Evaluated August 11, 2026 for a Pactline workspace with at most ten users. Prices and licensing can change, so confirm the linked vendor pages before purchasing.

## Recommendation

Keep Pactline's native paragraph editor, redline, approval, and agreement workflow as the default. It costs nothing extra, preserves Pactline's version and audit model, and is sufficient for the current demo and small private deployment.

Treat ONLYOFFICE and e-signature as optional provider adapters:

1. Prototype ONLYOFFICE Community only when pixel-faithful Word editing becomes more important than operational simplicity.
2. Keep Pactline's internal “agreement” action distinct from a legal electronic signature.
3. Add a DocuSign sandbox adapter before buying production API access. Prefer it over Adobe Acrobat Sign at this stage because DocuSign publishes a small production developer plan while Adobe directs embedded/API customers to enterprise or OEM sales.
4. Until paid signing is justified, allow the final locked DOCX to be downloaded and the externally signed copy to be uploaded as an executed document.

## ONLYOFFICE Docs

### Cost and fit

- Community Edition is self-hosted, AGPLv3, and the official repository describes it as suitable for up to 20 simultaneous connections. License cost: $0.
- It is not serverless software. Pactline would need a separate Linux/Docker host; it cannot run inside a Cloudflare Worker.
- Official minimum requirements are approximately a 2 GHz CPU, 4 GB RAM, and 40 GB free disk. Hosting may therefore have a real monthly cost even though the software is free.
- Enterprise pricing currently starts at $1,500. Proprietary Developer/embedded licensing should be confirmed with ONLYOFFICE before distributing a commercial hosted product.

### Integration shape

Pactline would create an editor configuration signed with JWT, provide a short-lived URL from which Document Server can fetch the DOCX, and expose an authenticated callback endpoint. On save, the callback would download the revised file, write it to R2, parse it into paragraphs, create a new immutable contract version, and generate proposed changes rather than silently overwriting the accepted document.

### Estimated effort

- Proof of concept: 3–5 engineering days.
- Pactline-safe integration with R2 versioning, JWT, callbacks, tracked-change conversion, failure recovery, and tests: 1–2 engineering weeks.
- Production hardening, monitoring, upgrade automation, backups, and licensing review: another 3–5 days.

The hard part is not rendering Word. It is reconciling a whole-file editor callback with Pactline's paragraph proposals, approval gates, and immutable audit trail.

Official references: [DocumentServer repository](https://github.com/ONLYOFFICE/DocumentServer), [Community system requirements](https://helpcenter.onlyoffice.com/docs/installation/docs-community-sys-reqs-docker.aspx), [opening a document](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/opening-file/), [JWT security](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/security/), [callback handler](https://api.onlyoffice.com/docs/docs-api/usage-api/callback-handler/), and [Enterprise pricing](https://www.onlyoffice.com/docs-enterprise-prices).

## DocuSign

### Cost and fit

- The developer/demo account is free but cannot be used for legally binding production transactions.
- The published production API Starter plan is currently $50 per month when billed annually ($600 per year) and includes 40 envelopes per month.
- Higher published developer plans are currently $300 and $480 per month when billed annually.

### Estimated effort

- Sandbox send, embedded signing, webhook, and completed-document download: 3–5 engineering days.
- Hardened OAuth, tenant mapping, webhook verification/idempotency, retries, audit reconciliation, and production certification: about 1–2 engineering weeks total.

Pactline should store provider-neutral envelope IDs and states, never make provider status the only audit record, and place the completed signed PDF/DOCX in R2 as an executed document version.

Official references: [DocuSign APIs and free demo account](https://www.docusign.com/products/apis) and [developer plan pricing](https://ecom.docusign.com/plans-and-pricing/developer?ipbr=1).

## Adobe Acrobat Sign

### Cost and fit

- Adobe offers a free Developer Edition for API testing; test documents are not production agreements.
- Adobe states that production Sign API access is available through enterprise/developer tiers.
- Customer-facing embedded use is handled through Adobe's OEM/Embedded program and is separately licensed through sales. Ordinary Acrobat Standard/Pro seat pricing should not be treated as embedded Sign API pricing.

### Estimated effort

- Basic developer-environment workflow: 4–7 engineering days.
- Production OAuth, regional API routing, webhook reliability, embedded signing, audit reconciliation, and OEM onboarding: roughly 2–3 engineering weeks, excluding vendor contracting time.

Official references: [Developer Edition](https://developer.adobe.com/acrobat-sign/docs/overview/developer_guide/), [API access FAQ](https://helpx.adobe.com/uk/sign/faq/api.html), [Sign API and OEM program](https://developer.adobe.com/document-services/apis/sign-api/), and [API workflow/webhooks](https://developer.adobe.com/acrobat-sign/docs/overview/developer_guide/apiusage).

## Integration boundary to preserve

Future implementations should conform to provider-neutral application services rather than putting vendor calls directly in UI routes:

- `DocumentEditorProvider`: create session, validate callback, fetch saved revision, close session.
- `SignatureProvider`: create envelope, create recipient signing session, process verified webhook, download completed artifacts, void envelope.
- D1 owns Pactline workflow state, authorization, approvals, relationships, audit records, and idempotency keys.
- R2 owns original, intermediate, final, and executed files.
- External providers are replaceable processors, not the system of record.
