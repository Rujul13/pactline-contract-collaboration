import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { BASE_URL } from "../../playwright.config";
import { DEMO_CONTRACT_ID, resetDemo, REVIEWER_PASSWORD, REVIEWER_USERNAME } from "./fixtures";

test.describe.serial("vendor and customer happy path", () => {
  test.beforeAll(async () => {
    await resetDemo();
  });

  test("review round, comment, propose, counter, approve, lock, transition, amend, export calendar", async ({ page, browser }) => {
    test.setTimeout(60000);
    // `resolveProposal()` and `agreeAsOwner()` in app/page.tsx never wire up a UI
    // field for `decisionReason` — every accept/reject/counter falls through to a
    // native `window.prompt(...)`, and `agreeAsOwner`/`amendment()` use
    // `window.confirm(...)`. A plain `dialog.accept()` on a prompt keeps its
    // (empty) default value, which fails the server's `reason.length >= 3` check,
    // so prompts specifically need a non-empty answer.
    page.on("dialog", (dialog) => {
      if (dialog.type() === "prompt") void dialog.accept("Resolved during automated end-to-end review.");
      else void dialog.accept();
    });

    // Review round: close the seeded open round, then open a new one.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await expect(page.getByRole("heading", { name: "Demo Master Services Agreement" })).toBeVisible();
    await page.getByPlaceholder("All requested changes have been addressed.").fill("Initial pass complete.");
    await page.getByRole("button", { name: "Close review round" }).click();
    await expect(page.getByRole("status")).toContainText("Review round closed.");
    await page.getByRole("button", { name: "Open next review round" }).click();
    await expect(page.getByRole("status")).toContainText("New review round opened.");

    // Vendor adds a comment.
    await page.getByPlaceholder("Explain the business or legal concern…").fill("Please confirm the payment terms are acceptable.");
    await page.getByRole("button", { name: "Add comment" }).click();
    await expect(page.getByRole("status")).toContainText("Comment added.");

    // Reviewer signs in from a SEPARATE browser context (not context.newPage()).
    // The reviewer's login sets a Path=/ session cookie (__Host-pactline_client).
    // If the reviewer page shared the owner page's context/cookie jar, every
    // subsequent owner API call would carry that cookie and requireOwnerApi()
    // (lib/owner-boundary.ts) hard-denies any request that has a client-session
    // cookie, regardless of the owner's own auth — a fully isolated context is
    // required to keep the two security domains apart, exactly as the app does
    // in production with two separate browsers/devices.
    const reviewerContext = await browser.newContext({ baseURL: BASE_URL });
    const reviewerPage = await reviewerContext.newPage();
    await reviewerPage.goto(`/review/${DEMO_CONTRACT_ID}`);
    await reviewerPage.locator("#review-username").fill(REVIEWER_USERNAME);
    await reviewerPage.locator("#review-password").fill(REVIEWER_PASSWORD);
    await reviewerPage.getByRole("button", { name: "Sign in securely" }).click();
    await expect(reviewerPage.getByText("Pactline customer review")).toBeVisible();
    const feesParagraph = reviewerPage.locator(".paragraph-content", { hasText: "Vendor Company will perform the services in a professional" });
    await feesParagraph.click();
    await reviewerPage.locator('textarea[id^="review-block-"]').fill("Vendor Company will perform the services in a professional, workmanlike, and timely manner using qualified personnel.");
    await reviewerPage.getByRole("button", { name: "Submit proposed changes" }).click();
    await expect(reviewerPage.getByText(/proposed change.*sent to the vendor workspace/)).toBeVisible();

    // Vendor counters the proposal from the main editor.
    //
    // app/page.tsx renders proposal-resolution controls in two places:
    //  - the review rail (aside.review-rail) shows compact "✓ Accept" / "Counter"
    //    / "Reject" buttons per proposal card; "Counter" there only focuses the
    //    proposal, it does not submit anything.
    //  - the INLINE panel that appears under the paragraph itself, once a
    //    proposal is focused (via the proposal card's "View in document →"
    //    jump button), shows "✓ Accept change" / "Counter propose" / "Reject
    //    change". Clicking "Counter propose" there only opens a counter-editor
    //    textarea (id="counter-{proposalId}") — the actual submit button is a
    //    separate "Send counterproposal" button that appears once the editor is
    //    open. This is the button pair tests/rendered-html.test.mjs was
    //    checking for; the brief's original two-clicks-on-"Counter propose"
    //    guess was wrong because the second click was actually still available
    //    (decision-row buttons stay mounted) but does nothing but reset the
    //    draft, never resolveProposal("counter").
    await page.goto(`/?contract=${DEMO_CONTRACT_ID}`);
    const pendingProposalJump = page.locator(".proposal-card:not(.resolved) .proposal-jump");
    await pendingProposalJump.click();
    await page.getByRole("button", { name: "Counter propose", exact: true }).click();
    const counterBox = page.locator('textarea[id^="counter-"]');
    await counterBox.fill("Vendor Company will perform the services in a professional and workmanlike manner using qualified, appropriately experienced personnel.");
    await page.getByRole("button", { name: "Send counterproposal" }).click();
    await expect(page.getByText("Counterproposal sent back to the reviewer.")).toBeVisible();

    // Reviewer accepts the owner's counter text by re-submitting it as their own
    // proposal (the review page has no direct "accept the owner's counter"
    // action — "Continue negotiation with this text" just stages the owner's
    // counter text as the reviewer's next draft, which supersedes the countered
    // proposal on submit). The owner then has to resolve that new pending
    // proposal — this step is required for both sides' "agree" buttons to ever
    // become clickable: the reviewer's footer button is client-side disabled
    // while `counters.length > 0`, and both the lifecycle "approved" transition
    // and the /agree endpoints hard-reject while any proposal is still
    // status='pending' (a leftover 'countered' proposal does NOT block them,
    // but a fresh 'pending' one does).
    await reviewerPage.reload();
    await expect(reviewerPage.getByText("Vendor counterproposal", { exact: true })).toBeVisible();
    await reviewerPage.getByRole("button", { name: "Continue negotiation with this text" }).click();
    await reviewerPage.getByRole("button", { name: "Submit proposed changes" }).click();
    await expect(reviewerPage.getByText(/proposed change.*sent to the vendor workspace/)).toBeVisible();

    await page.reload();
    await pendingProposalJump.click();
    await page.getByRole("button", { name: "✓ Accept change", exact: true }).click();
    await expect(page.getByText(/Change accepted/)).toBeVisible();

    // Owner requires and approves an internal approval.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByRole("button", { name: "Add requirement" }).click();
    await expect(page.getByRole("status")).toContainText("approval required.");
    await page.getByPlaceholder("Approved because the position is within policy.").fill("Standard services terms, within policy.");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Approval recorded.");

    // Move the lifecycle stage back to external_review (the approval requirement forced internal_review), then to approved.
    await page.getByLabel("Lifecycle stage").selectOption("external_review");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");
    await page.getByLabel("Lifecycle stage").selectOption("approved");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");

    // Mutual agreement locks the contract.
    //
    // agreeAsOwner()'s button label is dynamic: "✓ Approve version" (nobody has
    // agreed yet) -> "🔒 Lock version" (client already agreed) -> "✓ Owner
    // approved" / "🔒 Locked" afterwards. At this point in the flow neither
    // party has agreed to the current (post-accept) version yet, so it reads
    // exactly "✓ Approve version" — a literal string, not a template with
    // per-render dynamic text, so an exact match is used per the brief's Step 1
    // guidance rather than the placeholder /Approve version|Agree/ regex.
    await page.goto(`/?contract=${DEMO_CONTRACT_ID}`);
    await page.getByRole("button", { name: "✓ Approve version", exact: true }).click();
    await expect(page.getByText(/agreement is recorded|final document is locked/)).toBeVisible();
    await reviewerPage.reload();
    await reviewerPage.getByRole("button", { name: "Agree to this version", exact: true }).click();
    await expect(reviewerPage.getByText(/final document is locked/)).toBeVisible();

    // approved -> executed now that the contract is locked.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    await page.getByLabel("Lifecycle stage").selectOption("executed");
    await page.getByRole("button", { name: "Save lifecycle details" }).click();
    await expect(page.getByRole("status")).toContainText("Lifecycle details saved");

    // Amendment (its window.confirm(...) is handled by the page-level dialog listener registered above).
    await page.getByRole("button", { name: "Create amendment" }).click();
    await expect(page).toHaveURL(/\/workflow\/(?!sample-services-agreement)/);

    // Calendar export. The link's response carries content-disposition: attachment,
    // so Chromium turns the click into a download rather than a same-page fetch —
    // by the time `response.text()` would run, the browser has already navigated
    // away from that response and its body is gone ("No resource with given
    // identifier found"). Read headers off the intercepted response (available
    // immediately) and read the body from the file Playwright actually saved.
    await page.goto(`/workflow/${DEMO_CONTRACT_ID}`);
    const [response, download] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes("/calendar") && candidate.status() === 200),
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Export .ics" }).click(),
    ]);
    expect(response.headers()["content-type"]).toContain("text/calendar");
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error("Playwright did not save the .ics download to disk");
    const body = readFileSync(downloadPath, "utf8");
    expect(body).toContain("BEGIN:VCALENDAR");

    await reviewerContext.close();
  });
});
