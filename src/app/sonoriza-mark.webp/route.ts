import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-static";

const SOURCE_FILE = path.join(process.cwd(), "public", "sonoriza-mark.svg");
const EMBEDDED_WEBP = /href="data:image\/webp;base64,([^"]+)"/;

export async function GET() {
  const source = await readFile(SOURCE_FILE, "utf8");
  const encoded = source.match(EMBEDDED_WEBP)?.[1];

  if (!encoded) {
    return new Response("Sonoriza mark source is invalid", { status: 500 });
  }

  return new Response(Buffer.from(encoded, "base64"), {
    headers: {
      "Content-Type": "image/webp",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
