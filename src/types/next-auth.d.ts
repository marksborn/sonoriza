import type { DefaultSession } from "next-auth";

// Auth.js v5 with the database session strategy exposes the user id on the
// session; teach TypeScript about it so `session.user.id` is typed.
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
}
