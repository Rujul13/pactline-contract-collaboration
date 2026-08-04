import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pactline — Contract collaboration",
  description: "Clause-by-clause contract negotiation with a complete, trusted history.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
