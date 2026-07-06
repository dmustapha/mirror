// File: web/app/layout.tsx
import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import StatusBar from "@/components/StatusBar";

export const metadata: Metadata = {
  title: "Mirror — BOT Chain query layer, checkpointed on-chain",
  description:
    "Self-hosted BOT Chain indexer whose database checkpoints into blob transactions on the chain it indexes. 60-second trustless bootstrap.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <nav>
          <Link href="/" className="brand">MIRROR</Link>
          <Link href="/checkpoints">Checkpoints</Link>
          <Link href="/blobs">Blob Activity</Link>
          <Link href="/integrations">Integrations</Link>
          <Link href="/proof">Proof</Link>
        </nav>
        <StatusBar />
        <main>{children}</main>
      </body>
    </html>
  );
}
