"use client";

import { use, useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function ApproverInviteLandingPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const params = use(searchParams);
  const token = params.token || "";
  const router = useRouter();

  const [loading, setLoading] = useState(!token ? false : true);
  const [error, setError] = useState<string | null>(!token ? "No invitation token was provided in the link." : null);
  const [details, setDetails] = useState<{
    contractTitle: string;
    versionNumber: number;
    approverName: string;
    titleRole: string;
    kind: string;
    expiresAt: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (typeof document !== "undefined") {
      const meta = document.createElement("meta");
      meta.name = "referrer";
      meta.content = "no-referrer";
      document.head.appendChild(meta);
    }

    if (!token) return;

    // Validate invite metadata via GET probe endpoint (read-only, does not consume)
    fetch(`/api/approver/invite/probe?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          throw new Error(data.error || "Invalid or expired invitation token");
        }
        return res.json() as Promise<{
          contractTitle: string;
          versionNumber: number;
          approverName: string;
          titleRole: string;
          kind: string;
          expiresAt: string;
        }>;
      })
      .then((data) => {
        setDetails(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [token]);

  const handleConsume = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/approver/invite/consume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error || "Failed to consume invitation link");
      }

      const data = (await res.json()) as { success: boolean; contractId: string };
      router.push(`/approve/${data.contractId}`);
    } catch (err: Error) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", backgroundColor: "#f8f9fa", display: "flex", alignItems: "center", justifyContent: "center", padding: "2rem" }}>
      <div className="workflow-card" style={{ maxWidth: "540px", width: "100%", padding: "2rem", borderRadius: "8px", boxShadow: "0 4px 12px rgba(0,0,0,0.08)", background: "#fff" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem", color: "#1a1a1a" }}>Pactline Approval Portal</h1>
        <p style={{ color: "#666", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
          Delegated Domain Approval Invitation
        </p>

        {loading ? (
          <div style={{ padding: "2rem 0", textAlign: "center", color: "#666" }}>
            Verifying invitation details...
          </div>
        ) : error ? (
          <div style={{ padding: "1rem", backgroundColor: "#fce8e6", color: "#c5221f", borderRadius: "4px", fontSize: "0.9rem", marginBottom: "1.5rem" }}>
            <strong>Invitation Unavailable:</strong> {error}
          </div>
        ) : details ? (
          <div>
            <div style={{ backgroundColor: "#f1f3f4", padding: "1rem", borderRadius: "6px", marginBottom: "1.5rem", fontSize: "0.9rem" }}>
              <div style={{ marginBottom: "0.5rem" }}>
                <span style={{ color: "#666" }}>Contract Title:</span>{" "}
                <strong style={{ color: "#202124" }}>{details.contractTitle}</strong> (Version {details.versionNumber})
              </div>
              <div style={{ marginBottom: "0.5rem" }}>
                <span style={{ color: "#666" }}>Approval Scope:</span>{" "}
                <strong style={{ textTransform: "uppercase", color: "#1a73e8" }}>{details.kind} REVIEW</strong>
              </div>
              <div style={{ marginBottom: "0.5rem" }}>
                <span style={{ color: "#666" }}>Assigned Approver:</span>{" "}
                <strong>{details.approverName}</strong> ({details.titleRole})
              </div>
              <div>
                <span style={{ color: "#666" }}>Invite Expires:</span>{" "}
                <span style={{ fontFamily: "monospace" }}>{new Date(details.expiresAt).toLocaleString()}</span>
              </div>
            </div>

            <p style={{ fontSize: "0.85rem", color: "#5f6368", marginBottom: "1.5rem" }}>
              Clicking below will accept this invitation and log you into the secure approver decision portal.
            </p>

            <button
              className="workflow-primary"
              onClick={() => void handleConsume()}
              disabled={submitting}
              style={{
                width: "100%",
                padding: "0.8rem 1.5rem",
                fontSize: "1rem",
                fontWeight: "bold",
                backgroundColor: "#1a73e8",
                color: "#fff",
                border: "none",
                borderRadius: "4px",
                cursor: submitting ? "not-allowed" : "pointer"
              }}
            >
              {submitting ? "Accessing Portal..." : "Accept & Access Approval Portal"}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
