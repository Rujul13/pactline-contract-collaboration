"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type Diagnostics = {
  d1: { status: string; latencyMs: number };
  migrations: { applied: number; total: number; isCurrent: boolean };
  r2: { status: string; reachable: boolean; details?: string };
  vectorize: { status: string };
  ai: { status: string };
  lastCronRun: string;
  unresolvedErrorsCount: number;
  buildIdentity: { commitSha: string; env: string };
  notifications?: Array<{ id: string; recipient_email: string; template_name: string; status: string; created_at: string }>;
};

type ErrorEvent = {
  id: string;
  request_id: string;
  route: string;
  method: string;
  actor_scope: string;
  contract_id: string | null;
  severity: string;
  message: string;
  fingerprint: string;
  metadata: Record<string, unknown> | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
};

export default function ReleaseDashboardPage() {
  const router = useRouter();
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [errors, setErrors] = useState<ErrorEvent[]>([]);
  const [selectedError, setSelectedError] = useState<ErrorEvent | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    async function loadData() {
      try {
        const [diagRes, errRes] = await Promise.all([
          fetch("/api/owner/release-readiness", { cache: "no-store" }),
          fetch("/api/owner/monitoring/errors", { cache: "no-store" })
        ]);

        if (diagRes.status === 401 || errRes.status === 401) {
          router.replace(`/owner/login?return_to=${encodeURIComponent("/owner/release-dashboard")}`);
          return;
        }

        if (!diagRes.ok || !errRes.ok) {
          if (active) {
            setMessage("Failed to retrieve diagnostics data.");
            setLoading(false);
          }
          return;
        }

        const diagData = await diagRes.json() as Diagnostics;
        const errData = await errRes.json() as { errors: ErrorEvent[] };

        if (active) {
          setDiagnostics(diagData);
          setErrors(errData.errors);
        }
      } catch {
        if (active) setMessage("Failed to fetch diagnostics.");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadData();
    return () => {
      active = false;
    };
  }, [router, tick]);

  async function resolveError(id: string) {
    setResolvingId(id);
    try {
      const res = await fetch(`/api/owner/monitoring/errors/${id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" }
      });
      if (res.ok) {
        setMessage("Operational error resolved successfully.");
        if (selectedError?.id === id) {
          setSelectedError(null);
        }
        setTick((t) => t + 1);
      } else {
        setMessage("Failed to resolve operational error.");
      }
    } catch {
      setMessage("Error resolving event.");
    } finally {
      setResolvingId(null);
    }
  }

  if (loading) {
    return (
      <main className="workflow-loading">
        <span className="portal-spinner" />
        <p>Loading operational diagnostics dashboard…</p>
      </main>
    );
  }

  return (
    <main className="workflow-shell" style={{ padding: "2rem", maxWidth: "1200px", margin: "0 auto" }}>
      <header className="workflow-top" style={{ marginBottom: "2rem" }}>
        <Link href="/">← Owner Workspace</Link>
        <div>
          <small>System Status</small>
          <h1>Release & Observability Dashboard</h1>
          {diagnostics && (
            <p>
              Env: <strong style={{ textTransform: "uppercase" }}>{diagnostics.buildIdentity.env}</strong> · Commit: <code>{diagnostics.buildIdentity.commitSha.slice(0, 7)}</code>
            </p>
          )}
        </div>
      </header>

      {message && (
        <div className="workflow-message" role="status" style={{ marginBottom: "1.5rem" }}>
          {message}
        </div>
      )}

      {diagnostics && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "1.5rem", marginBottom: "2rem" }}>
          {/* Card: Cloudflare Worker Bindings */}
          <div className="workflow-card" style={{ padding: "1.5rem" }}>
            <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Worker Bindings</h2>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.75rem" }}>
              <li style={{ display: "flex", justifyContent: "space-between" }}>
                <span>D1 Database:</span>
                <span style={{ color: diagnostics.d1.status === "online" ? "green" : "red", fontWeight: "bold" }}>
                  {diagnostics.d1.status === "online" ? `Online (${diagnostics.d1.latencyMs}ms)` : "Offline"}
                </span>
              </li>
              <li style={{ display: "flex", justifyContent: "space-between" }}>
                <span>R2 Document Storage:</span>
                <span style={{ color: diagnostics.r2.reachable ? "green" : "red", fontWeight: "bold" }}>
                  {diagnostics.r2.status}
                </span>
              </li>
              <li style={{ display: "flex", justifyContent: "space-between" }}>
                <span>Vectorize Binding:</span>
                <span style={{ color: diagnostics.vectorize.status === "available" ? "green" : "red", fontWeight: "bold" }}>
                  {diagnostics.vectorize.status}
                </span>
              </li>
              <li style={{ display: "flex", justifyContent: "space-between" }}>
                <span>AI Binding:</span>
                <span style={{ color: diagnostics.ai.status === "available" ? "green" : "red", fontWeight: "bold" }}>
                  {diagnostics.ai.status}
                </span>
              </li>
            </ul>
          </div>

          {/* Card: Schema Capability Check */}
          <div className="workflow-card" style={{ padding: "1.5rem" }}>
            <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Schema Capability Check</h2>
            <div style={{ fontSize: "2.5rem", fontWeight: "bold", margin: "0.5rem 0" }}>
              {diagnostics.migrations.applied} / {diagnostics.migrations.total}
            </div>
            <p style={{ margin: 0, color: diagnostics.migrations.isCurrent ? "green" : "orange", fontWeight: "bold" }}>
              {diagnostics.migrations.isCurrent ? "✓ Capabilities fully present" : "⚠ Incomplete capabilities"}
            </p>
            <span style={{ fontSize: "0.8rem", color: "#666" }}>Non-authoritative schema check</span>
          </div>

          {/* Card: Scheduled Tasks */}
          <div className="workflow-card" style={{ padding: "1.5rem" }}>
            <h2 style={{ fontSize: "1.1rem", marginBottom: "1rem" }}>Cron & Telemetry</h2>
            <div style={{ marginBottom: "0.5rem" }}>
              <span style={{ color: "#666" }}>Last Scheduler Run:</span>
              <div style={{ fontFamily: "monospace", fontSize: "0.9rem", marginTop: "0.25rem" }}>
                {diagnostics.lastCronRun !== "Never" ? new Date(diagnostics.lastCronRun).toLocaleString() : "Never"}
              </div>
            </div>
            <div>
              <span style={{ color: "#666" }}>Unresolved Error Log:</span>
              <div style={{ fontSize: "1.2rem", fontWeight: "bold", color: diagnostics.unresolvedErrorsCount > 0 ? "red" : "green" }}>
                {diagnostics.unresolvedErrorsCount} active error{diagnostics.unresolvedErrorsCount === 1 ? "" : "s"}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Grid: Unresolved Errors and Expanded Details Drawer */}
      <div style={{ display: "grid", gridTemplateColumns: selectedError ? "1fr 1fr" : "1fr", gap: "1.5rem" }}>
        {/* Error Events List */}
        <section className="workflow-card" style={{ padding: "1.5rem" }}>
          <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem" }}>Active Error Telemetry</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
            {errors.length ? (
              errors.map((item) => (
                <article
                  key={item.id}
                  onClick={() => setSelectedError(item)}
                  style={{
                    padding: "1rem",
                    border: selectedError?.id === item.id ? "1px solid var(--color-primary, #0070f3)" : "1px solid #ddd",
                    borderRadius: "4px",
                    cursor: "pointer",
                    background: selectedError?.id === item.id ? "#f5f9ff" : "#fff",
                    transition: "border 0.2s"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                    <strong style={{ color: "red", textTransform: "uppercase" }}>{item.severity} · {item.method} {item.route}</strong>
                    <span style={{ background: "#eee", padding: "2px 6px", borderRadius: "10px", fontSize: "0.8rem" }}>
                      {item.occurrence_count} times
                    </span>
                  </div>
                  <p style={{ margin: "0 0 0.5rem 0", fontSize: "0.95rem", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {item.message}
                  </p>
                  <small style={{ color: "#666" }}>
                    Last Seen: {new Date(item.last_seen_at).toLocaleString()}
                  </small>
                </article>
              ))
            ) : (
              <div className="workflow-empty">No active operational errors recorded.</div>
            )}
          </div>
        </section>

        {/* Detailed Drawer */}
        {selectedError && (
          <section className="workflow-card" style={{ padding: "1.5rem", position: "sticky", top: "2rem", alignSelf: "start" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
              <h2 style={{ fontSize: "1.2rem", margin: 0 }}>Error Details</h2>
              <button
                style={{ background: "none", border: "none", fontSize: "1.5rem", cursor: "pointer", padding: "0 0.5rem" }}
                onClick={() => setSelectedError(null)}
              >
                ×
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "1rem", fontSize: "0.9rem" }}>
              <div>
                <strong>Request ID:</strong>
                <div style={{ fontFamily: "monospace", padding: "0.25rem", background: "#f0f0f0", borderRadius: "3px" }}>{selectedError.request_id}</div>
              </div>

              <div>
                <strong>Method & Path:</strong>
                <div>{selectedError.method} {selectedError.route}</div>
              </div>

              <div>
                <strong>Actor Scope:</strong>
                <div>{selectedError.actor_scope}</div>
              </div>

              <div>
                <strong>Message:</strong>
                <div style={{ color: "red", fontWeight: "500", marginTop: "0.25rem" }}>{selectedError.message}</div>
              </div>

              <div>
                <strong>Sanitized Telemetry Metadata:</strong>
                <pre style={{
                  padding: "0.75rem",
                  background: "#1e1e1e",
                  color: "#d4d4d4",
                  borderRadius: "4px",
                  overflowX: "auto",
                  fontSize: "0.8rem",
                  maxHeight: "220px",
                  marginTop: "0.25rem"
                }}>
                  {JSON.stringify(selectedError.metadata, null, 2)}
                </pre>
              </div>

              <div style={{ display: "flex", gap: "1rem", marginTop: "1rem" }}>
                <button
                  className="workflow-primary"
                  disabled={resolvingId !== null}
                  onClick={() => void resolveError(selectedError.id)}
                  style={{ flex: 1 }}
                >
                  {resolvingId === selectedError.id ? "Resolving..." : "Mark as Resolved"}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Notifications Queue Log Section */}
      <section className="workflow-card" style={{ padding: "1.5rem", marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1.2rem", marginBottom: "1rem" }}>Notification Queue Log (Provider Stub)</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {diagnostics.notifications && diagnostics.notifications.length ? (
            diagnostics.notifications.map((notif) => {
              let displayStatus = notif.status;
              if (notif.status === "queued") displayStatus = "Queued — local stub";
              else if (notif.status === "logged") displayStatus = "Logged — local stub";
              else if (notif.status === "failed") displayStatus = "Failed — local stub";

              return (
                <div
                  key={notif.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "0.75rem 1rem",
                    border: "1px solid #eee",
                    borderRadius: "4px",
                    background: "#fafafa"
                  }}
                >
                  <div>
                    <strong>{notif.recipient_email}</strong>
                    <span style={{ color: "#666", marginLeft: "1rem", fontSize: "0.85rem" }}>
                      Template: <code>{notif.template_name}</code>
                    </span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                    <span
                      style={{
                        padding: "3px 8px",
                        borderRadius: "12px",
                        fontSize: "0.75rem",
                        fontWeight: "bold",
                        background: notif.status === "logged" ? "#e6f4ea" : "#fef7e0",
                        color: notif.status === "logged" ? "#137333" : "#b06000"
                      }}
                    >
                      {displayStatus}
                    </span>
                    <small style={{ color: "#888" }}>
                      {new Date(notif.created_at).toLocaleString()}
                    </small>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="workflow-empty">No notification deliveries recorded in queue.</div>
          )}
        </div>
      </section>
    </main>
  );
}
