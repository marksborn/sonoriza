/* eslint-disable @next/next/no-img-element -- ImageResponse needs a raw img element for the embedded brand asset. */
import { readFileSync } from "node:fs";
import path from "node:path";

import { ImageResponse } from "next/og";

export const runtime = "nodejs";

const ALLOWED_SIZES = new Set([180, 192, 512]);
const markDataUri = `data:image/webp;base64,${readFileSync(
  path.join(process.cwd(), "public", "sonoriza-mark.webp"),
).toString("base64")}`;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ size: string }> },
) {
  const { size } = await params;
  const pixels = Number(size);

  if (!Number.isInteger(pixels) || !ALLOWED_SIZES.has(pixels)) {
    return new Response("Not found", { status: 404 });
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0B021F",
        }}
      >
        <img
          alt=""
          src={markDataUri}
          width={Math.round(pixels * 0.58)}
          height={Math.round(pixels * 0.64)}
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    {
      width: pixels,
      height: pixels,
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    },
  );
}
