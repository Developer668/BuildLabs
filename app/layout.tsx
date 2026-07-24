import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ||
    requestHeaders.get("host") ||
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ||
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    metadataBase: new URL(origin),
    title: "BuildStax Call Lab",
    description:
      "Review transcripts from the BuildStax ElevenLabs phone intake agent.",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "BuildStax Call Lab",
      description:
        "A simple transcript viewer for the BuildStax phone intake agent.",
      images: [{ url: `${origin}/og.png`, width: 1733, height: 910 }],
      type: "website",
    },
    twitter: {
      card: "summary_large_image",
      title: "BuildStax Call Lab",
      description:
        "A simple transcript viewer for the BuildStax phone intake agent.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
