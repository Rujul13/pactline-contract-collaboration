export type ClauseInput = { clauseKey: string; title: string; text: string };

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function providerJson(path: string, payload: unknown) {
  const response = await fetch(`${required("AI_API_BASE_URL")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${required("AI_API_KEY")}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`AI provider failed with status ${response.status}`);
  return response.json() as Promise<unknown>;
}

export const aiAdapter = {
  draftFill(clauses: ClauseInput[], brief: string) {
    return providerJson("/draft-fill", { clauses, brief, constraints: { knownClauseKeysOnly: true, humanConfirmationRequired: true } });
  },
  parseChange(clause: ClauseInput, request: string) {
    return providerJson("/change-parse", { clause, request, constraints: { oneClauseOnly: true, structuredOutput: true, humanConfirmationRequired: true } });
  },
};

export const crmAdapter = {
  async searchCounterparty(query: string) {
    const response = await fetch(`${required("CRM_API_BASE_URL")}/counterparties?query=${encodeURIComponent(query)}`, { headers: { authorization: `Bearer ${required("CRM_API_KEY")}` } });
    if (!response.ok) throw new Error(`CRM search failed with status ${response.status}`);
    return response.json();
  },
  async pushContractStatus(crmRecordId: string, status: string, versionNumber: number) {
    const response = await fetch(`${required("CRM_API_BASE_URL")}/contracts/${encodeURIComponent(crmRecordId)}`, { method: "PATCH", headers: { authorization: `Bearer ${required("CRM_API_KEY")}`, "content-type": "application/json" }, body: JSON.stringify({ status, versionNumber }) });
    if (!response.ok) throw new Error(`CRM update failed with status ${response.status}`);
  },
};

export const notificationAdapter = {
  async sendDirect(recipientId: string, event: "approval_requested" | "approval_resolved" | "proposal_submitted" | "contract_locked", link: string) {
    const response = await fetch(`${required("NOTIFICATIONS_API_BASE_URL")}/direct`, { method: "POST", headers: { authorization: `Bearer ${required("NOTIFICATIONS_API_KEY")}`, "content-type": "application/json" }, body: JSON.stringify({ recipientId, event, link }) });
    if (!response.ok) throw new Error(`Notification failed with status ${response.status}`);
  },
};

export function onlyOfficeConfig(input: { documentUrl: string; callbackUrl: string; title: string; documentKey: string; user: { id: string; name: string }; mode: "edit" | "view"; canReview: boolean }) {
  return {
    documentType: "word",
    document: { fileType: "docx", key: input.documentKey, title: input.title, url: input.documentUrl, permissions: { edit: input.mode === "edit", comment: true, review: input.canReview, download: true, print: true } },
    editorConfig: { callbackUrl: input.callbackUrl, mode: input.mode, user: input.user, customization: { autosave: true, compactHeader: false, forcesave: true } },
    type: "desktop",
    width: "100%",
    height: "100%",
  };
}
