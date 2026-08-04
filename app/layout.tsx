import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pactline — Contract collaboration",
  description: "Secure Word-document collaboration with attributed paragraph proposals, version history, and cross-company review.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
