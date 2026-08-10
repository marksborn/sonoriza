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
  icons: {
    icon: "/sonoriza-mark.webp",
  },
};

export const viewport: Viewport = {
  themeColor: "#0B021F",
  colorScheme: "dark",
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
