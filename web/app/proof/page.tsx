// File: web/app/proof/page.tsx
"use client";
import { useEffect, useState } from "react";
import { API_BASE } from "@/lib/api";

export default function ProofPage() {
  const [proof, setProof] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    void fetch(`${API_BASE}/proof`).then((r) => r.json()).then(setProof).catch(() => {});
  }, []);

  return (
    <>
      <h1>Proof</h1>
      <p className="sub">
        Machine-readable twin of <span className="mono">submission/proof.md</span>. Reproduce from a
        clean machine: <span className="mono">docker compose up</span>, then wipe and restore.
      </p>
      <div className="panel">
        <pre className="mono" style={{ whiteSpace: "pre-wrap", margin: 0 }}>
          {proof ? JSON.stringify(proof, null, 2) : "loading…"}
        </pre>
      </div>
    </>
  );
}
