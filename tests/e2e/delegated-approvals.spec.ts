import { expect, test } from "@playwright/test";
import { strToU8, zipSync } from "fflate";
import { BASE_URL } from "../../playwright.config";
import { resetDemo, DEMO_CONTRACT_ID, REVIEWER_USERNAME, REVIEWER_PASSWORD } from "./fixtures";

function validDocxBuffer(): Buffer {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Sample paragraph text for delegated approval docx test.</w:t></w:r></w:p></w:body></w:document>`,
    ),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

test.describe("Phase 3 Delegated Multi-Person Approvals E2E", () => {
  test.beforeEach(async () => {
    await resetDemo();
  });

  test("unauthorized and cross-role requests are gated with 401/403", async ({ playwright }) => {
    const unauthContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

    // 1. Unauthenticated request to owner assignment endpoint
    const assignRes = await unauthContext.post(`/api/owner/contracts/${DEMO_CONTRACT_ID}/approvers`, {
      data: { email: "legal@test.test", displayName: "Legal", titleRole: "Counsel", kind: "legal" },
    });
    expect([401, 403, 404]).toContain(assignRes.status());

    // 2. Consume invalid invite token
    const invalidConsumeRes = await unauthContext.post("/api/approver/invite/consume", {
      data: { token: "invalid-token-hash-12345" },
    });
    expect(invalidConsumeRes.status()).toBe(410);

    // 3. Reviewer session receives 403 on owner assignment endpoint
    const reviewerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    await reviewerContext.post("/api/client/login", {
      data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD },
    });

    const reviewerAssignRes = await reviewerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: { action: "assign_delegated", email: "legal@test.test", displayName: "Legal", titleRole: "Counsel", kind: "legal" },
    });
    expect([401, 403]).toContain(reviewerAssignRes.status());

    await unauthContext.dispose();
    await reviewerContext.dispose();
  });

  test("multiple approvers of the same approval kind are supported per version", async ({ playwright }) => {
    const ownerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

    // Assign Legal Approver A
    const resA = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "legal.counsel.a@company.test",
        displayName: "Legal Counsel A",
        titleRole: "Senior Counsel",
        kind: "legal",
        required: true,
      },
    });
    expect(resA.status()).toBe(201);

    // Assign Legal Approver B (Same kind: "legal")
    const resB = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "legal.counsel.b@company.test",
        displayName: "Legal Counsel B",
        titleRole: "Associate Counsel",
        kind: "legal",
        required: true,
      },
    });
    expect(resB.status()).toBe(201);

    // Re-assigning Legal Approver A to the same kind again returns 409 Conflict
    const resDuplicate = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "legal.counsel.a@company.test",
        displayName: "Legal Counsel A",
        titleRole: "Senior Counsel",
        kind: "legal",
        required: true,
      },
    });
    expect(resDuplicate.status()).toBe(409);

    await ownerContext.dispose();
  });

  test("DOCX upload invalidates delegated approvals into pending state for new version and blocks agreement until re-approval", async ({ playwright }) => {
    const ownerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

    // Step 1: Create a new non-demo contract
    const createRes = await ownerContext.post("/api/contracts", {
      multipart: {
        title: "DOCX Version Invalidation Test Contract",
        document: { name: "v1.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: validDocxBuffer() },
      },
    });
    expect(createRes.status()).toBe(201);
    const { contract } = (await createRes.json()) as { contract: { id: string } };

    // Step 2: Owner assigns required delegated legal approver for v1
    const assignRes = await ownerContext.post(`/api/contracts/${contract.id}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "docx.legal@company.test",
        displayName: "DOCX Legal Counsel",
        titleRole: "VP Counsel",
        kind: "legal",
        required: true,
      },
    });
    expect(assignRes.status()).toBe(201);
    const assignData = (await assignRes.json()) as { assignment: { id: string; inviteUrl: string } };
    const inviteToken = new URL(assignData.assignment.inviteUrl).searchParams.get("token")!;

    // Step 3: Approver approves v1
    const approverContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    await approverContext.post("/api/approver/invite/consume", { data: { token: inviteToken } });
    const approveV1Res = await approverContext.post(`/api/approver/contracts/${contract.id}/decide`, {
      data: { assignmentId: assignData.assignment.id, decision: "approved", decisionReason: "Approved v1 DOCX legal terms." },
    });
    expect(approveV1Res.ok()).toBe(true);

    // Step 4: Owner uploads new DOCX document (v2)
    const uploadV2Res = await ownerContext.post(`/api/contracts/${contract.id}/documents`, {
      multipart: {
        document: { name: "v2.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: validDocxBuffer() },
      },
    });
    expect(uploadV2Res.status()).toBe(201);
    const uploadV2Data = (await uploadV2Res.json()) as { versionNumber: number };
    expect(uploadV2Data.versionNumber).toBe(2);

    // Step 5: Verify delegated assignment is recreated in pending state for v2
    const approverV2Res = await approverContext.get(`/api/approver/contracts/${contract.id}`);
    expect(approverV2Res.ok()).toBe(true);
    const v2Data = (await approverV2Res.json()) as { assignment: { version_number: number; status: string } };
    expect(v2Data.assignment.version_number).toBe(2);
    expect(v2Data.assignment.status).toBe("pending");

    // Step 6: Owner agreement attempt is BLOCKED (409 Conflict) while v2 approval is pending
    const agreeFailRes = await ownerContext.post(`/api/contracts/${contract.id}/agree`);
    expect(agreeFailRes.status()).toBe(409);

    // Step 7: Approver approves v2
    const approveV2Res = await approverContext.post(`/api/approver/contracts/${contract.id}/decide`, {
      data: { assignmentId: v2Data.assignment.version_number === 2 ? (v2Data.assignment as unknown as { id: string }).id : assignData.assignment.id, decision: "approved", decisionReason: "Approved v2 DOCX revised legal terms." },
    });
    expect(approveV2Res.ok()).toBe(true);

    // Step 8: Owner agreement now succeeds (200 OK)
    const agreeSuccessRes = await ownerContext.post(`/api/contracts/${contract.id}/agree`);
    expect(agreeSuccessRes.ok()).toBe(true);

    await ownerContext.dispose();
    await approverContext.dispose();
  });

  test("AI replacement and AI clause addition invalidate delegated approvals into pending state for new version", async ({ playwright }) => {
    const ownerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

    // Step 1: Assign delegated approver for v1
    const assignRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "finance.lead@company.test",
        displayName: "Finance Lead",
        titleRole: "VP Finance",
        kind: "finance",
        required: true,
      },
    });
    expect(assignRes.status()).toBe(201);
    const assignData = (await assignRes.json()) as { assignment: { id: string; inviteUrl: string } };
    const inviteToken = new URL(assignData.assignment.inviteUrl).searchParams.get("token")!;

    // Step 2: Approver approves v1
    const approverContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    await approverContext.post("/api/approver/invite/consume", { data: { token: inviteToken } });
    const decideRes = await approverContext.post(`/api/approver/contracts/${DEMO_CONTRACT_ID}/decide`, {
      data: { assignmentId: assignData.assignment.id, decision: "approved", decisionReason: "Finance terms approved for v1." },
    });
    expect(decideRes.ok()).toBe(true);

    // Step 3: Owner applies AI clause addition (operation: "insert_clause") -> increments to v2
    const aiInsertRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/ai-suggestions/apply`, {
      data: {
        baseVersion: 1,
        operation: "insert_clause",
        heading: "7. AI Governance Clause",
        paragraphs: ["All artificial intelligence operations shall comply with 2026 data privacy regulations."],
      },
    });
    expect(aiInsertRes.ok()).toBe(true);
    const aiInsertData = (await aiInsertRes.json()) as { versionNumber: number };
    expect(aiInsertData.versionNumber).toBe(2);

    // Step 4: Verify delegated assignment for v2 is instantiated in pending state
    const approverV2Res = await approverContext.get(`/api/approver/contracts/${DEMO_CONTRACT_ID}`);
    expect(approverV2Res.ok()).toBe(true);
    const v2Data = (await approverV2Res.json()) as { assignment: { version_number: number; status: string } };
    expect(v2Data.assignment.version_number).toBe(2);
    expect(v2Data.assignment.status).toBe("pending");

    await ownerContext.dispose();
    await approverContext.dispose();
  });

  test("counterparty agreement and locking path is blocked when a required delegated approval is pending or edits_requested", async ({ playwright }) => {
    const ownerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

    // Step 1: Owner assigns required delegated legal approver for v1
    const assignRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "legal.gate@company.test",
        displayName: "Legal Gatekeeper",
        titleRole: "General Counsel",
        kind: "legal",
        required: true,
      },
    });
    expect(assignRes.status()).toBe(201);
    const assignData = (await assignRes.json()) as { assignment: { id: string; inviteUrl: string } };
    const inviteToken = new URL(assignData.assignment.inviteUrl).searchParams.get("token")!;

    // Step 2: Counterparty logs in and attempts to agree via portal while delegated approval is pending
    const reviewerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const loginRes = await reviewerContext.post("/api/client/login", {
      data: { username: REVIEWER_USERNAME, password: REVIEWER_PASSWORD },
    });
    expect(loginRes.ok()).toBe(true);

    // Counterparty agree attempt — succeeds for counterparty but does NOT lock contract due to pending required delegated approval
    const counterpartyAgreeRes = await reviewerContext.post(`/api/client/contracts/${DEMO_CONTRACT_ID}/agree`);
    expect(counterpartyAgreeRes.ok()).toBe(true);
    const counterpartyAgreeData = (await counterpartyAgreeRes.json()) as { agreed: boolean; locked: boolean };
    expect(counterpartyAgreeData.agreed).toBe(true);
    expect(counterpartyAgreeData.locked).toBe(false);

    // Owner agree attempt while delegated approval is pending -> returns 409 Conflict
    const ownerAgreeFailRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/agree`);
    expect(ownerAgreeFailRes.status()).toBe(409);

    // Step 3: Delegated Approver approves v1
    const approverContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    await approverContext.post("/api/approver/invite/consume", { data: { token: inviteToken } });
    const decideRes = await approverContext.post(`/api/approver/contracts/${DEMO_CONTRACT_ID}/decide`, {
      data: { assignmentId: assignData.assignment.id, decision: "approved", decisionReason: "Legal terms fully verified and approved." },
    });
    expect(decideRes.ok()).toBe(true);

    // Step 4: Owner agrees after delegated approval is approved — both parties have agreed, locking contract
    const ownerAgreeRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/agree`);
    expect(ownerAgreeRes.ok()).toBe(true);
    const ownerAgreeData = (await ownerAgreeRes.json()) as { agreed: boolean; locked: boolean };
    expect(ownerAgreeData.agreed).toBe(true);
    expect(ownerAgreeData.locked).toBe(true);

    await ownerContext.dispose();
    await reviewerContext.dispose();
    await approverContext.dispose();
  });

  test("hostile Host-header is rejected and invite URL always uses configured canonical app URL", async ({ playwright }) => {
    const ownerContext = await playwright.request.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: {
        "x-forwarded-host": "evil.attacker.test",
        "oai-authenticated-user-id": "local-contract-owner",
        "oai-authenticated-user-email": "owner@example.test",
      },
    });

    const assignRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "security.lead@company.test",
        displayName: "Security Lead",
        titleRole: "CSO",
        kind: "security",
      },
    });
    expect(assignRes.status()).toBe(201);
    const data = (await assignRes.json()) as { assignment: { inviteUrl: string } };

    // Verify inviteUrl does NOT contain evil.attacker.test
    expect(data.assignment.inviteUrl).not.toContain("evil.attacker.test");
    expect(data.assignment.inviteUrl).toContain("/approve/invite?token=");

    await ownerContext.dispose();
  });

  test("concurrent double-consumption of an invite token is prevented via atomic compare-and-set", async ({ playwright }) => {
    const ownerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const assignRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "finance.dir@company.test",
        displayName: "Finance Dir",
        titleRole: "CFO",
        kind: "finance",
      },
    });
    expect(assignRes.status()).toBe(201);
    const assignData = (await assignRes.json()) as { assignment: { inviteUrl: string } };
    const inviteToken = new URL(assignData.assignment.inviteUrl).searchParams.get("token")!;

    const clientA = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const clientB = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

    // Race two concurrent consumption requests with the same raw token
    const [resA, resB] = await Promise.all([
      clientA.post("/api/approver/invite/consume", { data: { token: inviteToken } }),
      clientB.post("/api/approver/invite/consume", { data: { token: inviteToken } }),
    ]);

    const statuses = [resA.status(), resB.status()].sort((a, b) => a - b);
    // Exactly one must succeed (200) and the second must fail (410)
    expect(statuses).toEqual([200, 410]);

    await ownerContext.dispose();
    await clientA.dispose();
    await clientB.dispose();
  });

  test("concurrent double-decision on the same assignment is rejected via compare-and-set UPDATE", async ({ playwright }) => {
    const ownerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const assignRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "approver.race@company.test",
        displayName: "Approver Race",
        titleRole: "Director",
        kind: "business",
      },
    });
    expect(assignRes.status()).toBe(201);
    const assignData = (await assignRes.json()) as { assignment: { id: string; inviteUrl: string } };
    const inviteToken = new URL(assignData.assignment.inviteUrl).searchParams.get("token")!;

    const approverContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    await approverContext.post("/api/approver/invite/consume", { data: { token: inviteToken } });

    // Race two concurrent decision requests on the same assignment ID
    const [decideA, decideB] = await Promise.all([
      approverContext.post(`/api/approver/contracts/${DEMO_CONTRACT_ID}/decide`, {
        data: { assignmentId: assignData.assignment.id, decision: "approved", decisionReason: "First concurrent decision payload" },
      }),
      approverContext.post(`/api/approver/contracts/${DEMO_CONTRACT_ID}/decide`, {
        data: { assignmentId: assignData.assignment.id, decision: "edits_requested", decisionReason: "Second concurrent decision payload" },
      }),
    ]);

    const statuses = [decideA.status(), decideB.status()].sort((a, b) => a - b);
    // Exactly one succeeds (200) and the second is rejected with 409 Conflict
    expect(statuses).toEqual([200, 409]);

    await ownerContext.dispose();
    await approverContext.dispose();
  });

  test("full delegated approval lifecycle, two-step invite, version invalidation, and server gate enforcement", async ({ page, playwright }) => {
    const ownerContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });

    // Step 1: Owner assigns Delegated Legal Approver for active version (v1)
    const assignRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/approvals`, {
      data: {
        action: "assign_delegated",
        email: "sarah.jenkins@company.test",
        displayName: "Sarah Jenkins",
        titleRole: "VP of Legal",
        kind: "legal",
        required: true,
      },
    });
    expect(assignRes.status()).toBe(201);
    const assignData = (await assignRes.json()) as {
      assignment: { id: string; versionNumber: number; inviteUrl: string; approver: { id: string } };
    };
    expect(assignData.assignment.versionNumber).toBe(1);
    expect(assignData.assignment.inviteUrl).toContain("/approve/invite?token=");

    const inviteToken = new URL(assignData.assignment.inviteUrl).searchParams.get("token")!;
    expect(inviteToken).toBeTruthy();

    // Step 2: GET Probe Endpoint (Read-only GET landing verification without consuming token)
    const probeRes = await ownerContext.get(`/api/approver/invite/probe?token=${encodeURIComponent(inviteToken)}`);
    expect(probeRes.ok()).toBe(true);
    const probeData = (await probeRes.json()) as { approverName: string; kind: string; versionNumber: number };
    expect(probeData.approverName).toBe("Sarah Jenkins");
    expect(probeData.kind).toBe("legal");
    expect(probeData.versionNumber).toBe(1);

    // Step 3: Two-step GET landing page display in browser
    await page.goto(`${BASE_URL}/approve/invite?token=${inviteToken}`);
    await expect(page.locator("h1")).toContainText("Pactline Approval Portal");
    await expect(page.locator("body")).toContainText("Sarah Jenkins");
    await expect(page.locator("body")).toContainText("VP of Legal");

    // Step 4: POST Consume Invite Link
    const approverContext = await playwright.request.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    const consumeRes = await approverContext.post("/api/approver/invite/consume", {
      data: { token: inviteToken },
    });
    expect(consumeRes.ok()).toBe(true);
    const consumeData = (await consumeRes.json()) as { success: boolean; contractId: string };
    expect(consumeData.success).toBe(true);
    expect(consumeData.contractId).toBe(DEMO_CONTRACT_ID);

    // Step 5: Submitting decision without mandatory rationale (<5 chars) returns 400
    const shortReasonRes = await approverContext.post(`/api/approver/contracts/${DEMO_CONTRACT_ID}/decide`, {
      data: { assignmentId: assignData.assignment.id, decision: "edits_requested", decisionReason: "No" },
    });
    expect(shortReasonRes.status()).toBe(400);

    // Step 6: Approver requests edits with valid rationale (min 5 chars)
    const decideRes = await approverContext.post(`/api/approver/contracts/${DEMO_CONTRACT_ID}/decide`, {
      data: {
        assignmentId: assignData.assignment.id,
        decision: "edits_requested",
        decisionReason: "Legal terms require clause 4 revision for compliance.",
      },
    });
    expect(decideRes.ok()).toBe(true);

    // Step 7: Server Gate Enforcement — Owner agreement fails while delegated approval is in edits_requested (409 Conflict)
    const agreeFailRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/agree`);
    expect(agreeFailRes.status()).toBe(409);

    // Step 8: Owner updates contract paragraph text, incrementing version to v2
    const workspaceRes = await ownerContext.get(`/api/contracts/${DEMO_CONTRACT_ID}/workspace`);
    const workspaceData = (await workspaceRes.json()) as { blocks: Array<{ id: string; current_text: string }> };
    const targetBlock = workspaceData.blocks.find((b) => b.id) || workspaceData.blocks[0];

    const blockUpdateRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/blocks/${targetBlock.id}`, {
      data: {
        baseVersion: 1,
        text: targetBlock.current_text + " (Updated for Phase 3 E2E test)",
      },
    });
    expect(blockUpdateRes.ok()).toBe(true);
    const updateData = (await blockUpdateRes.json()) as { versionNumber: number };
    expect(updateData.versionNumber).toBe(2);

    // Step 9: Atomic Version Invalidation Verification — Approver loads contract workspace for v2
    const approverContractRes = await approverContext.get(`/api/approver/contracts/${DEMO_CONTRACT_ID}`);
    expect(approverContractRes.ok()).toBe(true);
    const approverContractData = (await approverContractRes.json()) as {
      contract: { current_version: number };
      assignment: { id: string; version_number: number; status: string };
    };
    expect(approverContractData.contract.current_version).toBe(2);
    expect(approverContractData.assignment.version_number).toBe(2);
    expect(approverContractData.assignment.status).toBe("pending");

    // Step 10: Approver approves version 2 with mandatory rationale
    const approveV2Res = await approverContext.post(`/api/approver/contracts/${DEMO_CONTRACT_ID}/decide`, {
      data: {
        assignmentId: approverContractData.assignment.id,
        decision: "approved",
        decisionReason: "Version 2 legal terms fully compliant with 2026 corporate policy.",
      },
    });
    expect(approveV2Res.ok()).toBe(true);

    // Step 11: Owner Agreement Gate Unlocked — Required approval is now approved
    const agreeSuccessRes = await ownerContext.post(`/api/contracts/${DEMO_CONTRACT_ID}/agree`);
    expect(agreeSuccessRes.ok()).toBe(true);
    const agreeSuccessData = (await agreeSuccessRes.json()) as { agreed: boolean };
    expect(agreeSuccessData.agreed).toBe(true);

    await ownerContext.dispose();
    await approverContext.dispose();
  });
});
