import { env } from "cloudflare:workers";
import { requireOwnerApi } from "@/lib/owner-boundary";
import { calendarText, ownerContract } from "@/lib/workflow";

export async function GET(request: Request, context: { params: Promise<{ contractId: string }> }) {
  const auth = await requireOwnerApi(request); if (auth.response) return auth.response;
  const { contractId } = await context.params; const contract = await ownerContract(contractId, auth.user.userId); if (!contract) return Response.json({ error: "Contract not found" }, { status: 404 });
  const reminders = await env.DB.prepare("SELECT * FROM reminder_schedules WHERE contract_id=? ORDER BY due_at").bind(contractId).all<Record<string, unknown>>();
  return new Response(calendarText(contract, reminders.results), { headers: { "content-type": "text/calendar; charset=utf-8", "content-disposition": `attachment; filename="pactline-${contractId}-reminders.ics"`, "cache-control": "private, no-store" } });
}
