import "./globals.css";

export const metadata = {
  title: "BuildLabs Voice Intake",
  description:
    "Local operator review for completed BuildLabs ElevenLabs intake sessions.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  robots: { index: false, follow: false },
};

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
