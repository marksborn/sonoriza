import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Sonoriza",
  description:
    "Open-source dynamic playlists shaped by your schedule, time and context.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
