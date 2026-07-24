import "./globals.css";

export const metadata = {
  title: "BuildLabs Voice Intake",
  description:
    "Governed browser voice intake and operator review for BuildLabs ElevenAgents sessions.",
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
