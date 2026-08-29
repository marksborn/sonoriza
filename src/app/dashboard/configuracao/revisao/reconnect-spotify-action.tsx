import { signIn } from "@/lib/auth";

export function ReconnectSpotifyAction() {
  async function reconnectSpotify() {
    "use server";
    await signIn(
      "spotify",
      { redirectTo: "/dashboard/historico" },
      { show_dialog: "true" },
    );
  }

  return (
    <form action={reconnectSpotify} className="mt-3">
      <button
        type="submit"
        className="inline-flex items-center rounded-xl border border-orange-300/25 bg-orange-400/10 px-3 py-2 text-xs font-black text-orange-200 transition hover:border-orange-200/50 hover:bg-orange-400/15 hover:text-orange-100"
      >
        Reconectar Spotify
      </button>
    </form>
  );
}
