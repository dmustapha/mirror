// File: web/app/layout.tsx
import type { Metadata } from "next";
import Link from "next/link";
import { Unbounded, Manrope } from "next/font/google";
import "./globals.css";
import StatusBar from "@/components/StatusBar";

const display = Unbounded({ subsets: ["latin"], weight: ["400", "700", "900"], variable: "--font-display" });
const body = Manrope({ subsets: ["latin"], weight: ["400", "500", "700"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Mirror — BOT Chain query layer, checkpointed on-chain",
  description:
    "Self-hosted BOT Chain indexer whose database checkpoints into blob transactions on the chain it indexes. A day of data restores in under a minute; the full history in under ten.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable}`}>
        <nav>
          <Link href="/" className="brand">MIRR<i>O</i>R</Link>
          <Link href="/checkpoints">Checkpoints</Link>
          <Link href="/blobs">Blob Activity</Link>
          <Link href="/integrations">Integrations</Link>
          <Link href="/proof">Proof</Link>
          <StatusBar />
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
