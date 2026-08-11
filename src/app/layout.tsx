import type { Metadata, Viewport } from "next";

import { PwaServiceWorker } from "@/components/PwaServiceWorker";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Sonoriza — playlists no seu tempo",
    template: "%s · Sonoriza",
  },
  description:
    "Playlists dinâmicas de músicas e podcasts moldadas pela sua agenda, duração e contexto.",
  applicationName: "Sonoriza",
  manifest: "/manifest.webmanifest",
  keywords: [
    "playlists dinâmicas",
    "Spotify",
    "Google Agenda",
    "músicas",
    "podcasts",
  ],
  icons: {
    icon: [
      { url: "/pwa-icon/192", sizes: "192x192", type: "image/png" },
      { url: "/pwa-icon/512", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/pwa-icon/180", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Sonoriza",
    statusBarStyle: "black-translucent",
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
      <body>
        <PwaServiceWorker />
        {children}
      </body>
    </html>
  );
}
