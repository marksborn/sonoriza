import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Sonoriza — playlists no seu tempo",
    short_name: "Sonoriza",
    description:
      "Playlists dinâmicas de músicas e podcasts moldadas pela sua agenda, duração e contexto.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    background_color: "#0B021F",
    theme_color: "#0B021F",
    lang: "pt-BR",
    categories: ["music", "productivity"],
    icons: [
      {
        src: "/pwa-icon/192",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa-icon/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/pwa-icon/512",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
