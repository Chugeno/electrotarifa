import { betterAuth } from "better-auth";
import { createClient } from "@libsql/client";
import { LibsqlDialect } from "@libsql/kysely-libsql";

const dbPath = process.env.DATABASE_URL || "file:paternal.db";

export const client = createClient({
  url: dbPath,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

async function sendTransactionalEmail(opts: { to: string; name?: string; subject: string; html: string }) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || "eugenioazurmendi@gmail.com";
  if (!apiKey) {
    console.log(`[Email simulado → ${opts.to}] ${opts.subject}\n${opts.html}`);
    return;
  }
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: { name: "ElectroTarifa", email: senderEmail },
      to: [{ email: opts.to, name: opts.name || opts.to }],
      subject: opts.subject,
      htmlContent: opts.html,
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Error enviando email por Brevo:", res.status, errText);
  }
}

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
    ...(process.env.BETTER_AUTH_URL?.startsWith("https://") ? [] : ["http://localhost:8000", "http://127.0.0.1:8000"]),
  ],
  // En producción BETTER_AUTH_SECRET es obligatorio (wrangler secret put BETTER_AUTH_SECRET).
  secret: process.env.BETTER_AUTH_SECRET || (process.env.DATABASE_URL?.startsWith("libsql://") ? undefined : "dev-only-local-secret"),
  rateLimit: {
    enabled: true,
    window: 10,
    max: 10,
  },
  user: {
    // Permite que cada usuario elimine su cuenta (POST /api/auth/delete-user con { password }).
    deleteUser: {
      enabled: true,
      beforeDelete: async (user) => {
        const { deleteUserCarts } = await import("./db.js");
        await deleteUserCarts(user.id);
      },
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await sendTransactionalEmail({
        to: user.email,
        name: user.name,
        subject: "Confirmá tu cuenta en ElectroTarifa",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;">
            <h2 style="margin:0 0 12px;color:#0f172a;">¡Hola ${user.name || ""}! ⚡</h2>
            <p style="color:#334155;font-size:14px;line-height:1.5;">
              Hacé clic en el siguiente botón para confirmar tu correo y activar tu cuenta en <strong>ElectroTarifa</strong>:
            </p>
            <p style="margin:24px 0;">
              <a href="${url}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;font-size:14px;display:inline-block;">
                Confirmar mi correo
              </a>
            </p>
            <p style="color:#64748b;font-size:12px;">Si no creaste esta cuenta, podés ignorar este mensaje.</p>
          </div>
        `,
      });
    },
  },
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: Boolean(process.env.BREVO_API_KEY),
    sendResetPassword: async ({ user, url }) => {
      await sendTransactionalEmail({
        to: user.email,
        name: user.name,
        subject: "Restablecé tu contraseña en ElectroTarifa",
        html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;border:1px solid #e2e8f0;border-radius:12px;">
            <h2 style="margin:0 0 12px;color:#0f172a;">Recuperación de contraseña 🔒</h2>
            <p style="color:#334155;font-size:14px;line-height:1.5;">
              Recibimos una solicitud para cambiar la contraseña de tu cuenta en <strong>ElectroTarifa</strong>.
            </p>
            <p style="margin:24px 0;">
              <a href="${url}" style="background:#2563eb;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold;font-size:14px;display:inline-block;">
                Elegir nueva contraseña
              </a>
            </p>
            <p style="color:#64748b;font-size:12px;">Este enlace vence en 1 hora. Si no lo solicitaste, ignorá este correo.</p>
          </div>
        `,
      });
    },
  },
});
