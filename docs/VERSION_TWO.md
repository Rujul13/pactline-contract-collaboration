# Pactline Version Two

## Delivered capabilities

1. **Organization foundation** — customer and supplier organizations, memberships, supplier relationships, contract access grants, and company-scoped supplier accounts.
2. **Supplier portal** — one supplier login exposes that supplier's current and expired contracts, shared vault records, lifecycle alerts, DOCX submissions, paragraph proposals, approvals, and final downloads.
3. **Document vault** — DOCX and PDF files remain private in R2 while D1 stores category, visibility, ownership, dates, versions, hashes, and extraction state.
4. **Template generation** — customer DOCX templates use `{{field_name}}` placeholders and an optional `{{optional_clauses}}` marker. Placeholder replacement handles Word placeholders split across multiple runs. Generated DOCX files enter the existing versioned negotiation pipeline.
5. **AI extraction review** — DOCX paragraphs and PDF pages are extracted with source references. Groq structured output is used when configured; a deterministic parser remains available. Scanned/empty PDFs are marked for OCR. Nothing becomes authoritative until the owner confirms or corrects it.
6. **Knowledge search** — confirmed clauses and fields become organization-scoped search chunks. Cloudflare Workers AI produces embeddings for a 384-dimension Vectorize index. Authorized D1 joins re-check tenant and document state after vector retrieval. Keyword search is the local/no-binding fallback.
7. **Lifecycle alerts** — a daily Worker cron and an on-demand refresh create renewal, expiration, and missing-compliance alerts from confirmed dates and requirements. Resolved conditions close their corresponding alerts.

## Main data flow

```text
DOCX/PDF upload -> private R2 object -> D1 vault version
               -> extraction -> human review
               -> confirmed fields/clauses -> D1 search chunks -> Vectorize
               -> confirmed dates/requirements -> lifecycle alerts
```

The database is the source of truth for authorization and structured state. R2 is the source of truth for file bytes. Vectorize is only a retrieval index: every result is re-authorized against D1.

## Demo routes

- `/manage` — customer portfolio, suppliers, vault, templates, search, and alerts.
- `/portal` — supplier company portal.
- `/` — the existing paragraph-level owner negotiation workspace.

## Deliberate boundaries

- The first release uses synchronous extraction because the demo files are small. Move extraction, OCR, and embedding to Cloudflare Workflows or Queues before accepting large or frequent uploads.
- No malware-scanning provider is connected, so uploads remain scan-pending and should be synthetic or trusted.
- PDF extraction supports text PDFs; image-only PDFs require a future OCR provider.
- Template generation preserves the Word package and normalizes paragraphs that contain placeholders. Complex content controls, tracked changes, and deeply styled placeholder runs need a dedicated document service in a larger release.
- Alerts are in-app only. Email/calendar notifications need verified recipients, preferences, delivery tracking, and unsubscribe controls.
- Supplier password reset and invitation delivery are intentionally not live in the demo.
