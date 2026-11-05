import { betterAuth } from "better-auth";
import { createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";
const dbPath = process.env.DATABASE_URL || "file:paternal.db";

export const client = createClient({
  url: dbPath,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

export const auth = betterAuth({
  database: {
    dialect: new LibsqlDialect({
      client,
    }),
    type: "sqlite",
  },
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:8000",
  trustedOrigins: [
    "https://electrotarifa.eugenioazurmendi.com.ar",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://192.168.1.57:8000",
    "http://100.69.233.120:8000",
    "http://100.*:*",
    "http://192.168.*:*",
    "http://10.*:*",
    "http://172.*:*",
    "http://*.ts.net:*",
    "https://*.ts.net",
  ],
  // En producción BETTER_AUTH_SECRET es obligatorio (wrangler secret put BETTER_AUTH_SECRET).
  secret: process.env.BETTER_AUTH_SECRET || (process.env.DATABASE_URL?.startsWith("libsql://") ? undefined : "dev-only-local-secret"),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
  },
});
