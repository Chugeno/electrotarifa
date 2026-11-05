// Sincroniza paternal.db (local, generado por los scrapers Python) → Turso.
//
//   npx tsx scripts/sync-to-turso.ts           # diario: solo upsert de productos
//   npx tsx scripts/sync-to-turso.ts --full    # migración inicial: esquema + productos + usuarios + carritos
//
// Lee DATABASE_URL y DATABASE_AUTH_TOKEN desde .env (nunca se imprimen).
import "dotenv/config";
import { createClient, type InStatement } from "@libsql/client";

const FULL = process.argv.includes("--full");
const BATCH = 100;

const url = process.env.DATABASE_URL;
if (!url?.startsWith("libsql://")) {
  console.error("❌ DATABASE_URL en .env debe apuntar a Turso (libsql://...).");
  process.exit(1);
}

const local = createClient({ url: "file:paternal.db" });
const remote = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });

async function copySchema() {
  // Tablas, índices y triggers. Las tablas sombra de FTS5 se crean solas con el CREATE VIRTUAL TABLE.
  const rows = await local.execute(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'
       AND name NOT GLOB 'products_fts*_*'
     ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END`
  );
  for (const r of rows.rows) {
    const sql = String(r.sql)
      .replace(/^CREATE TABLE (?!IF NOT EXISTS)/i, "CREATE TABLE IF NOT EXISTS ")
      .replace(/^CREATE VIRTUAL TABLE (?!IF NOT EXISTS)/i, "CREATE VIRTUAL TABLE IF NOT EXISTS ")
      .replace(/^CREATE (UNIQUE )?INDEX (?!IF NOT EXISTS)/i, "CREATE $1INDEX IF NOT EXISTS ")
      .replace(/^CREATE TRIGGER (?!IF NOT EXISTS)/i, "CREATE TRIGGER IF NOT EXISTS ");
    await remote.execute(sql);
    console.log(`  ✓ ${r.type} ${r.name}`);
  }
}

async function copyTable(table: string, mode: "upsert" | "insert-ignore") {
  const total = Number((await local.execute(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0].n);
  const verb = mode === "upsert" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  let done = 0;
  for (let off = 0; off < total; off += BATCH) {
    const res = await local.execute({ sql: `SELECT * FROM "${table}" LIMIT ? OFFSET ?`, args: [BATCH, off] });
    const cols = res.columns;
    const stmts: InStatement[] = res.rows.map((row) => ({
      sql: `${verb} INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      args: cols.map((c) => row[c] as any),
    }));
    if (stmts.length) await remote.batch(stmts, "write");
    done += stmts.length;
    process.stdout.write(`\r  ${table}: ${done}/${total}`);
  }
  console.log();
}

async function main() {
  const t0 = Date.now();
  if (FULL) {
    console.log("🧱 Copiando esquema…");
    await copySchema();
    for (const t of ["user", "account", "session", "verification", "carts", "cart_items"]) {
      await copyTable(t, "insert-ignore");
    }
  }
  console.log("📦 Sincronizando productos…");
  await copyTable("products", "upsert");

  const [l, r] = await Promise.all([
    local.execute("SELECT COUNT(*) AS n FROM products"),
    remote.execute("SELECT COUNT(*) AS n FROM products"),
  ]);
  console.log(`✅ Listo en ${((Date.now() - t0) / 1000).toFixed(0)}s — local: ${l.rows[0].n}, Turso: ${r.rows[0].n}`);
}

main().catch((e) => {
  console.error("❌ Error de sincronización:", e?.message || e);
  process.exit(1);
});
