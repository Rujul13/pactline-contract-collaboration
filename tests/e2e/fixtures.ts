import { request as playwrightRequest } from "@playwright/test";
import { BASE_URL } from "../../playwright.config";

export const DEMO_CONTRACT_ID = "sample-services-agreement";
export const REVIEWER_USERNAME = "client.reviewer";
export const REVIEWER_PASSWORD = "ReviewDemo!2026";

export async function resetDemo(): Promise<void> {
  const context = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: { host: `localhost:${new URL(BASE_URL).port}` },
  });

  const response = await context.post("/api/demo/reset");
  if (!response.ok()) throw new Error(`Demo reset failed: ${response.status()} ${await response.text()}`);
  await context.dispose();
}
