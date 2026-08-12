import { z } from "zod";

/**
 * Runtime environment validation. Fails fast at startup with a readable error
 * instead of surfacing `undefined` deep inside an OAuth or database call.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),

  AUTH_URL: z.string().url().optional(),
  AUTH_SECRET: z.string().min(1),
  SONORIZA_ALLOWED_EMAILS: z.string().optional(),

  AUTH_SPOTIFY_ID: z.string().min(1),
  AUTH_SPOTIFY_SECRET: z.string().min(1),

  AUTH_GOOGLE_ID: z.string().min(1),
  AUTH_GOOGLE_SECRET: z.string().min(1),

  // HISTORY-01: Last.fm is an optional read-only historical source. The
  // endpoints used for backfill require an API key but no authenticated user
  // session or API secret.
  LASTFM_API_KEY: z.string().min(1).optional(),
  LASTFM_USERNAME: z.string().min(1).optional(),

  CRON_SECRET: z.string().min(1),

  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  WEB_PUSH_VAPID_SUBJECT: z
    .string()
    .min(1)
    .refine(
      (value) => value.startsWith("mailto:") || value.startsWith("https://"),
      "Use mailto: ou https:// para o subject VAPID",
    )
    .optional(),
});

// During `next build` the OAuth/cron secrets are not required, so we only hard-
// validate at real runtime. Parse lazily and cache the result.
let cached: z.infer<typeof schema> | null = null;

export function getEnv(): z.infer<typeof schema> {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
