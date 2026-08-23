"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ApproverContractPortalPage({
  params,
}: {
  params: Promise<{ contractId: string }>;
}) {
  const { contractId } = use(params);
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<{
    contract: { id: string; title: string; status: string; current_version: number };
    assignment: { id: string; version_number: number; kind: string; required: number; status: string; decision_reason: string | null };
    snapshot: Array<{ block_key: string; order_index: number; kind: string; current_text: string }>;
    approver: { id: string; displayName: string; titleRole: string; email: string };
  } | null>(null);

  const [decisionReason, setDecisionReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/approver/contracts/${contractId}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 401) {
            router.push(`/approve/invite`);
            return null;
          }
          const errData = (await res.json()) as { error?: string };
          throw new Error(errData.error || "Failed to load contract approval workspace");
        }
        return res.json() as Promise<NonNullable<typeof data>>;
      })
      .then((resData) => {
        if (resData) {
          setData(resData);
          if (resData.assignment.decision_reason) {
            setDecisionReason(resData.assignment.decision_reason);
          }
        }
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [contractId, router]);

  const handleDecision = async (decision: "approved" | "edits_requested") => {
    if (!data) return;
    if (!decisionReason.trim() || decisionReason.trim().length < 5) {
      setError("Please provide a decision rationale of at least 5 characters.");
      return;
    }

    setSubmitting(true);
    setError(null);
    setActionSuccess(null);

    try {
      const res = await fetch(`/api/approver/contracts/${contractId}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assignmentId: data.assignment.id,
          decision,
          decisionReason: decisionReason.trim(),
        }),
      });

      if (!res.ok) {
        const errData = (await res.json()) as { error?: string };
        throw new Error(errData.error || "Failed to record decision");
      }

      const resJson = (await res.json()) as { status: string };
      setData({
        ...data,
        assignment: { ...data.assignment, status: resJson.status, decision_reason: decisionReason.trim() },
      });
      setActionSuccess(`Decision recorded: ${resJson.status === "approved" ? "APPROVED" : "EDITS REQUESTED"}`);
      setSubmitting(false);
    } catch (err: Error) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/approver/logout", { method: "POST" });
    router.push("/approve/invite");
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", backgroundColor: "#f8f9fa", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
        <div style={{ color: "#666" }}>Loading approval workspace...</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ minHeight: "100vh", backgroundColor: "#f8f9fa", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
        <div className="workflow-card" style={{ maxWidth: "480px", padding: "2rem", background: "#fff", borderRadius: "8px" }}>
          <h2 style={{ color: "#c5221f", marginTop: 0 }}>Access Restricted</h2>
          <p style={{ color: "#666", fontSize: "0.9rem" }}>{error}</p>
          <button className="workflow-primary" onClick={() => router.push("/approve/invite")} style={{ marginTop: "1rem" }}>
            Return to Invite Page
          </button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#f8f9fa" }}>
      {/* Approver Header */}
      <header style={{ backgroundColor: "#1e293b", color: "#fff", padding: "1rem 2rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <span style={{ fontSize: "1.2rem", fontWeight: "bold" }}>Pactline Approval Portal</span>
          <span style={{ marginLeft: "1rem", fontSize: "0.85rem", color: "#94a3b8" }}>
            Signed in as: <strong>{data.approver.displayName}</strong> ({data.approver.titleRole})
          </span>
        </div>
        <button
          onClick={() => void handleLogout()}
          style={{ backgroundColor: "transparent", border: "1px solid #475569", color: "#e2e8f0", padding: "0.4rem 0.8rem", borderRadius: "4px", cursor: "pointer", fontSize: "0.85rem" }}
        >
          Sign Out
        </button>
      </header>

      {/* Main Container */}
      <main style={{ maxWidth: "960px", margin: "2rem auto", padding: "0 1rem" }}>
        {/* Title & Metadata Banner */}
        <div className="workflow-card" style={{ padding: "1.5rem", background: "#fff", borderRadius: "8px", marginBottom: "1.5rem" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h1 style={{ margin: 0, fontSize: "1.4rem", color: "#0f172a" }}>{data.contract.title}</h1>
              <div style={{ marginTop: "0.5rem", fontSize: "0.85rem", color: "#64748b" }}>
                Active Contract Version: <strong>v{data.contract.current_version}</strong> | Stage: <code>{data.contract.status}</code>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: "0.75rem", textTransform: "uppercase", color: "#64748b", fontWeight: "bold" }}>Required Review</div>
              <div style={{ fontSize: "1.1rem", fontWeight: "bold", color: "#2563eb", textTransform: "uppercase" }}>
                {data.assignment.kind} Review
              </div>
            </div>
          </div>
        </div>

        {/* Feedback / Error Alerts */}
        {error && (
          <div style={{ padding: "1rem", backgroundColor: "#fef2f2", color: "#991b1b", border: "1px solid #fecaca", borderRadius: "6px", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
            <strong>Notice:</strong> {error}
          </div>
        )}
        {actionSuccess && (
          <div style={{ padding: "1rem", backgroundColor: "#f0fdf4", color: "#166534", border: "1px solid #bbf7d0", borderRadius: "6px", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
            ✓ {actionSuccess}
          </div>
        )}

        {/* Document Read-Only Preview */}
        <section className="workflow-card" style={{ padding: "1.5rem", background: "#fff", borderRadius: "8px", marginBottom: "1.5rem" }}>
          <h2 style={{ fontSize: "1.1rem", marginTop: 0, marginBottom: "1rem", color: "#334155" }}>
            Contract Snapshot (Version {data.contract.current_version})
          </h2>
          <div style={{ border: "1px solid #e2e8f0", borderRadius: "6px", padding: "1.5rem", backgroundColor: "#fafafa", maxHeight: "400px", overflowY: "auto" }}>
            {data.snapshot && data.snapshot.length > 0 ? (
              data.snapshot.map((block) => (
                <div key={block.block_key} style={{ marginBottom: "1rem", fontFamily: block.kind === "title" ? "sans-serif" : "serif" }}>
                  {block.kind === "title" && <h3 style={{ margin: "0 0 0.5rem 0", fontSize: "1.2rem" }}>{block.current_text}</h3>}
                  {block.kind === "heading" && <h4 style={{ margin: "0.5rem 0", fontSize: "1rem" }}>{block.current_text}</h4>}
                  {block.kind === "body" && <p style={{ margin: 0, lineHeight: 1.6, color: "#1e293b" }}>{block.current_text}</p>}
                </div>
              ))
            ) : (
              <p style={{ color: "#94a3b8", italic: "true" }}>No document blocks available for preview.</p>
            )}
          </div>
        </section>

        {/* Decision & Rationale Form */}
        <section className="workflow-card" style={{ padding: "1.5rem", background: "#fff", borderRadius: "8px" }}>
          <h2 style={{ fontSize: "1.1rem", marginTop: 0, marginBottom: "0.5rem", color: "#334155" }}>
            Formal Decision & Rationale
          </h2>
          <p style={{ fontSize: "0.85rem", color: "#64748b", marginBottom: "1rem" }}>
            Provide a mandatory rationale (minimum 5 characters) explaining your formal approval or requested modifications.
          </p>

          <textarea
            value={decisionReason}
            onChange={(e) => setDecisionReason(e.target.value)}
            disabled={data.assignment.status !== "pending" || submitting}
            placeholder="Enter formal compliance reason, policy notes, or requested edit details..."
            rows={4}
            style={{
              width: "100%",
              padding: "0.75rem",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              fontSize: "0.95rem",
              marginBottom: "1.5rem",
              boxSizing: "border-box"
            }}
          />

          <div style={{ display: "flex", gap: "1rem", justifyContent: "flex-end" }}>
            <button
              onClick={() => void handleDecision("edits_requested")}
              disabled={data.assignment.status !== "pending" || submitting}
              style={{
                padding: "0.75rem 1.5rem",
                backgroundColor: data.assignment.status === "edits_requested" ? "#dc2626" : "#fef2f2",
                color: data.assignment.status === "edits_requested" ? "#fff" : "#991b1b",
                border: "1px solid #fca5a5",
                borderRadius: "6px",
                fontWeight: "bold",
                cursor: data.assignment.status !== "pending" || submitting ? "not-allowed" : "pointer"
              }}
            >
              {data.assignment.status === "edits_requested" ? "✓ Edits Requested" : "⚠ Request Edits"}
            </button>

            <button
              onClick={() => void handleDecision("approved")}
              disabled={data.assignment.status !== "pending" || submitting}
              style={{
                padding: "0.75rem 1.5rem",
                backgroundColor: data.assignment.status === "approved" ? "#16a34a" : "#16a34a",
                color: "#fff",
                border: "none",
                borderRadius: "6px",
                fontWeight: "bold",
                opacity: data.assignment.status !== "pending" && data.assignment.status !== "approved" ? 0.6 : 1,
                cursor: data.assignment.status !== "pending" || submitting ? "not-allowed" : "pointer"
              }}
            >
              {data.assignment.status === "approved" ? "✓ Version Approved" : "✓ Approve Version " + data.contract.current_version}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
