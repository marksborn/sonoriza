import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sonoriza — playlists no seu tempo",
    template: "%s · Sonoriza",
  },
  description:
    "Playlists dinâmicas de músicas e podcasts moldadas pela sua agenda, duração e contexto.",
  applicationName: "Sonoriza",
  keywords: [
    "playlists dinâmicas",
    "Spotify",
    "Google Agenda",
    "músicas",
    "podcasts",
  ],
};

export const viewport: Viewport = {
  themeColor: "#6724d9",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
