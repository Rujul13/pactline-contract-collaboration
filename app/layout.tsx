import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pactline — Contract collaboration",
  description: "Secure Word-document collaboration with attributed paragraph proposals, version history, and cross-company review.",
  openGraph: {
    title: "Pactline — Contract collaboration",
    description: "Review Word contracts together, resolve paragraph proposals, and download one agreed final version.",
    images: [{ url: "/contract-collaboration-preview.png", width: 1792, height: 933, alt: "A contract document with two attributed review markers" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
