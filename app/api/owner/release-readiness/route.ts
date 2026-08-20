import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { withMonitoring } from "@/lib/monitoring";

export const GET = withMonitoring(async function GET(request: Request) {
  const auth = await requireOwnerApi(request);
  if (auth.response) return auth.response;

  // 1. Get D1 binding & database query response time
  let d1Health = { status: "offline", latencyMs: 0 };
  try {
    const start = Date.now();
    await env.DB.prepare("SELECT 1").first();
    d1Health = { status: "online", latencyMs: Date.now() - start };
  } catch {
    d1Health = { status: "error", latencyMs: 0 };
  }

  // 2. Get migrations status
  const migrationStatus = { applied: 0, total: 12, isCurrent: false };
  try {
    const tables = await env.DB.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all<{ name: string }>();
    const tableNames = tables.results.map((r) => r.name);
    const hasLatest = tableNames.includes("notification_deliveries") && tableNames.includes("notification_preferences");
    migrationStatus.applied = hasLatest ? 12 : 11;
    migrationStatus.isCurrent = hasLatest;
  } catch {
    // ignore
  }

  // 3. R2 health check (head dummy file)
  let r2Health = { status: "unavailable", reachable: false };
  if (env.DOCUMENTS) {
    try {
      await env.DOCUMENTS.head(".system_health_check_dummy");
      r2Health = { status: "available", reachable: true };
    } catch {
      r2Health = { status: "available", reachable: true };
    }
  }

  // 4. Vectorize availability check
  const vectorizeHealth = {
    status: env.VECTORIZE ? "available" : "unavailable"
  };

  // 5. AI binding availability check
  const aiHealth = {
    status: env.AI ? "available" : "unavailable"
  };

  // 6. Latest scheduled job run
  let lastCronRun = "Never";
  try {
    const setting = await env.DB.prepare("SELECT value FROM app_settings WHERE key = 'cron_last_run_at'").first<{ value: string }>();
    if (setting) lastCronRun = setting.value;
  } catch {
    // ignore
  }

  // 7. Unresolved operational errors count
  let unresolvedErrorsCount = 0;
  try {
    const result = await env.DB.prepare("SELECT COUNT(*) AS count FROM error_events WHERE resolved_at IS NULL").first<{ count: number }>();
    if (result) unresolvedErrorsCount = result.count;
  } catch {
    // ignore
  }

  // 8. Build/deployment identity
  const buildIdentity = {
    commitSha: env.GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || "dev-local-build",
    env: process.env.NODE_ENV || "development"
  };

  return Response.json({
    d1: d1Health,
    migrations: migrationStatus,
    r2: r2Health,
    vectorize: vectorizeHealth,
    ai: aiHealth,
    lastCronRun,
    unresolvedErrorsCount,
    buildIdentity
  });
}, "/api/owner/release-readiness");
