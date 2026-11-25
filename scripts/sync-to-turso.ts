// Sincroniza paternal.db (local, generado por los scrapers Python) → Turso.
//
//   npx tsx scripts/sync-to-turso.ts           # diario: diff de productos + upsert con reintentos
//   npx tsx scripts/sync-to-turso.ts --force   # fuerza upsert completo de todos los productos
//   npx tsx scripts/sync-to-turso.ts --full    # migración inicial: esquema + productos + usuarios + carritos
//
// Lee DATABASE_URL y DATABASE_AUTH_TOKEN desde .env (nunca se imprimen).
import "dotenv/config";
import { createClient, type InStatement } from "@libsql/client";

const FULL = process.argv.includes("--full");
const FORCE = FULL || process.argv.includes("--force");
const provIdx = process.argv.indexOf("--provider");
const ONLY_PROVIDER = provIdx >= 0 ? process.argv[provIdx + 1] : null;

const PRODUCTS_BATCH = 50;
const TABLE_BATCH = 100;
const FINGERPRINT_CHUNK = 5000;
const MAX_RETRY_ATTEMPTS = 5;
const IS_TTY = Boolean(process.stdout.isTTY);

const NON_RETRYABLE_MARKERS = [
  "SQLITE_CONSTRAINT",
  "SQLITE_ERROR",
  "SQL_INPUT_ERROR",
  "URL_INVALID",
  "URL_SCHEME_NOT_SUPPORTED",
  "UNAUTHORIZED",
  "HTTP status 400",
  "HTTP status 401",
  "HTTP status 403",
  "HTTP status 404",
];

const FINGERPRINT_SQL = `
  SELECT
    uid, provider, id, sku, name, brand, slug, type,
    price, regular_price, sale_price, price_range_min, price_range_max,
    price_neto, iva_rate, iva_amount, is_in_stock,
    permalink, image_url, categories_text, variations_json,
    LENGTH(COALESCE(images_json, '')) AS l_img,
    LENGTH(COALESCE(categories_json, '')) AS l_cat,
    LENGTH(COALESCE(attributes_json, '')) AS l_attr,
    LENGTH(COALESCE(short_description, '')) AS l_sdesc,
    LENGTH(COALESCE(description, '')) AS l_desc
  FROM products
`;

const url = process.env.DATABASE_URL;
if (!url?.startsWith("libsql://")) {
  console.error("❌ DATABASE_URL en .env debe apuntar a Turso (libsql://...).");
  process.exit(1);
}

const local = createClient({ url: "file:paternal.db" });
let remote = makeRemoteClient();

/** Creates a fresh Turso client without caching stale HTTP connections. */
function makeRemoteClient() {
  return createClient({ url: url!, authToken: process.env.DATABASE_AUTH_TOKEN });
}

/** Closes the current Turso client and recreates a clean connection. */
function resetRemote(): void {
  try {
    remote.close();
  } catch {
    // Ignore close errors on broken sockets.
  }
  remote = makeRemoteClient();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Formats an error and its nested cause chain for readable diagnostics. */
function formatError(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    if (typeof cur === "object") {
      const obj = cur as { message?: unknown; code?: unknown; cause?: unknown };
      const msg = typeof obj.message === "string" ? obj.message : String(cur);
      const code = typeof obj.code === "string" ? ` [code=${obj.code}]` : "";
      parts.push(`${msg}${code}`);
      cur = obj.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" <- ");
}

/** Returns false for deterministic SQL/auth errors so retries only handle transient failures. */
function isRetryableError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 4; depth++) {
    if (typeof cur === "object") {
      const obj = cur as { message?: unknown; code?: unknown; cause?: unknown };
      const code = typeof obj.code === "string" ? obj.code : "";
      const msg = typeof obj.message === "string" ? obj.message : String(cur);
      for (const marker of NON_RETRYABLE_MARKERS) {
        if (code.includes(marker) || msg.includes(marker)) {
          return false;
        }
      }
      cur = obj.cause;
    } else {
      const text = String(cur);
      if (NON_RETRYABLE_MARKERS.some((marker) => text.includes(marker))) {
        return false;
      }
      break;
    }
  }
  return true;
}

/** Executes a remote operation with exponential backoff and client reset on transient errors. */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = MAX_RETRY_ATTEMPTS
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRetryableError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const jitter = Math.floor(Math.random() * 400);
      const delayMs = 1500 * Math.pow(2, attempt - 1) + jitter;
      console.warn(
        `⚠️  [${label}] intento ${attempt}/${maxAttempts} falló (${formatError(err)}). Reintentando en ${delayMs}ms…`
      );
      resetRemote();
      await sleep(delayMs);
    }
  }
}

/** Reports progress using carriage return on TTY and periodic lines in non-TTY logs. */
function reportProgress(label: string, done: number, total: number, lastLogged: number): number {
  if (IS_TTY) {
    process.stdout.write(`\r  ${label}: ${done}/${total}`);
    if (done >= total && total > 0) {
      console.log();
    }
    return done;
  }
  if (done >= total || done - lastLogged >= 500) {
    console.log(`  ${label}: ${done}/${total}`);
    return done;
  }
  return lastLogged;
}

function serializeFingerprint(row: Record<string, unknown>, fpCols: string[]): string {
  return fpCols
    .map((c) => {
      const v = row[c];
      return v === null || v === undefined ? "\0" : String(v);
    })
    .join("\u001f");
}

function buildProductUpsertSql(cols: string[]): string {
  const quotedCols = cols.map((c) => `"${c}"`).join(",");
  const placeholders = cols.map(() => "?").join(",");
  const updates = cols
    .filter((c) => c !== "uid")
    .map((c) => `"${c}"=excluded."${c}"`)
    .join(",");
  return `INSERT INTO "products" (${quotedCols}) VALUES (${placeholders}) ON CONFLICT("uid") DO UPDATE SET ${updates}`;
}

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
    await withRetry(`schema ${r.type} ${r.name}`, () => remote.execute(sql));
    console.log(`  ✓ ${r.type} ${r.name}`);
  }
}

async function copyTable(
  table: string,
  mode: "upsert" | "insert-ignore",
  whereProvider: string | null = null
) {
  const whereClause = whereProvider ? " WHERE provider = ?" : "";
  const whereArgs = whereProvider ? [whereProvider] : [];
  const total = Number(
    (await local.execute({ sql: `SELECT COUNT(*) AS n FROM "${table}"${whereClause}`, args: whereArgs })).rows[0].n
  );
  const verb = mode === "upsert" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
  let done = 0;
  let lastLogged = 0;
  for (let off = 0; off < total; off += TABLE_BATCH) {
    const res = await local.execute({
      sql: `SELECT * FROM "${table}"${whereClause} ORDER BY rowid LIMIT ? OFFSET ?`,
      args: [...whereArgs, TABLE_BATCH, off],
    });
    const cols = res.columns;
    const stmts: InStatement[] = res.rows.map((row) => ({
      sql: `${verb} INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
      args: cols.map((c) => row[c] as any),
    }));
    if (stmts.length) {
      await withRetry(`${table} ${off}-${off + stmts.length}`, () => remote.batch(stmts, "write"));
    }
    done += stmts.length;
    lastLogged = reportProgress(table, done, total, lastLogged);
  }
  if (total === 0) {
    console.log(`  ${table}: 0/0`);
  }
}

/** Syncs products using row-level fingerprinting by default or full upsert when forced. */
async function syncProducts(onlyProvider: string | null, force: boolean): Promise<number> {
  const whereClause = onlyProvider ? " WHERE provider = ?" : "";
  const whereArgs = onlyProvider ? [onlyProvider] : [];

  if (force) {
    const total = Number(
      (await local.execute({ sql: `SELECT COUNT(*) AS n FROM products${whereClause}`, args: whereArgs })).rows[0].n
    );
    let done = 0;
    let lastLogged = 0;
    for (let off = 0; off < total; off += PRODUCTS_BATCH) {
      const res = await local.execute({
        sql: `SELECT * FROM products${whereClause} ORDER BY uid LIMIT ? OFFSET ?`,
        args: [...whereArgs, PRODUCTS_BATCH, off],
      });
      if (!res.rows.length) break;
      const cols = res.columns;
      const sql = buildProductUpsertSql(cols);
      const stmts: InStatement[] = res.rows.map((row) => ({
        sql,
        args: cols.map((c) => row[c] as any),
      }));
      await withRetry(`products ${off}-${off + stmts.length}`, () => remote.batch(stmts, "write"));
      done += stmts.length;
      lastLogged = reportProgress("products", done, total, lastLogged);
    }
    return done;
  }

  const remoteMap = new Map<string, string>();
  let fpCols: string[] | null = null;
  for (let off = 0; ; off += FINGERPRINT_CHUNK) {
    const res = await withRetry(`remote-fp ${off}`, () =>
      remote.execute({
        sql: `${FINGERPRINT_SQL}${whereClause} ORDER BY uid LIMIT ? OFFSET ?`,
        args: [...whereArgs, FINGERPRINT_CHUNK, off],
      })
    );
    if (!fpCols) {
      fpCols = res.columns.filter((c) => c !== "uid");
    }
    for (const row of res.rows) {
      remoteMap.set(String(row.uid), serializeFingerprint(row as unknown as Record<string, unknown>, fpCols));
    }
    if (res.rows.length < FINGERPRINT_CHUNK) break;
  }

  const localRes = await local.execute({
    sql: `${FINGERPRINT_SQL}${whereClause} ORDER BY uid`,
    args: whereArgs,
  });
  const localFpCols = localRes.columns.filter((c) => c !== "uid");
  const changedUids: string[] = [];
  for (const row of localRes.rows) {
    const uid = String(row.uid);
    const localFp = serializeFingerprint(row as unknown as Record<string, unknown>, localFpCols);
    if (remoteMap.get(uid) !== localFp) {
      changedUids.push(uid);
    }
  }

  const totalLocal = localRes.rows.length;
  console.log(
    `📊 Diff productos: ${changedUids.length} nuevos/modificados, ${totalLocal - changedUids.length} sin cambios (total local: ${totalLocal})`
  );

  if (changedUids.length === 0) {
    return 0;
  }

  let done = 0;
  let lastLogged = 0;
  for (let i = 0; i < changedUids.length; i += PRODUCTS_BATCH) {
    const uidSlice = changedUids.slice(i, i + PRODUCTS_BATCH);
    const placeholders = uidSlice.map(() => "?").join(",");
    const res = await local.execute({
      sql: `SELECT * FROM products WHERE uid IN (${placeholders})`,
      args: uidSlice,
    });
    if (!res.rows.length) continue;
    const cols = res.columns;
    const sql = buildProductUpsertSql(cols);
    const stmts: InStatement[] = res.rows.map((row) => ({
      sql,
      args: cols.map((c) => row[c] as any),
    }));
    await withRetry(`products ${i}-${i + stmts.length}`, () => remote.batch(stmts, "write"));
    done += stmts.length;
    lastLogged = reportProgress("products", done, changedUids.length, lastLogged);
  }

  return done;
}

async function main() {
  const t0 = Date.now();
  try {
    if (FULL) {
      console.log("🧱 Copiando esquema…");
      await copySchema();
      for (const t of ["user", "account", "session", "verification", "carts", "cart_items"]) {
        await copyTable(t, "insert-ignore");
      }
    }

    console.log(`📦 Sincronizando productos${ONLY_PROVIDER ? ` (${ONLY_PROVIDER})` : ""}${FORCE ? " [forzado]" : ""}…`);
    const syncedProducts = await syncProducts(ONLY_PROVIDER, FORCE);

    if (FORCE || syncedProducts > 0) {
      console.log("🔍 Reconstruyendo índice FTS5 en Turso…");
      await withRetry("rebuild fts5", () => remote.execute("INSERT INTO products_fts(products_fts) VALUES('rebuild')"));
    } else {
      console.log("⏭️  Sin cambios en productos: omitiendo rebuild de FTS5.");
    }

    console.log("⚡ Asegurando índices de ordenamiento y categorías en Turso…");
    await withRetry("ensure indexes", () =>
      remote.batch(
        [
          "CREATE INDEX IF NOT EXISTS idx_products_sort ON products((price > 0) DESC, is_in_stock DESC, price ASC)",
          "CREATE INDEX IF NOT EXISTS idx_products_provider_sort ON products(provider, (price > 0) DESC, is_in_stock DESC, price ASC)",
          "CREATE INDEX IF NOT EXISTS idx_products_cats ON products(categories_text, provider)",
        ],
        "write"
      )
    );

    console.log("🔗 Sincronizando vínculos de productos (product_links)…");
    await withRetry("create product_links", () =>
      remote.execute(`
        CREATE TABLE IF NOT EXISTS product_links (
          uid TEXT PRIMARY KEY,
          group_key TEXT NOT NULL,
          source TEXT DEFAULT 'auto',
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `)
    );
    await withRetry("create idx_product_links_group", () =>
      remote.execute("CREATE INDEX IF NOT EXISTS idx_product_links_group ON product_links(group_key)")
    );
    await copyTable("product_links", "insert-ignore");

    const [l, r] = await Promise.all([
      local.execute("SELECT COUNT(*) AS n FROM products"),
      withRetry("count remote products", () => remote.execute("SELECT COUNT(*) AS n FROM products")),
    ]);
    console.log(`✅ Listo en ${((Date.now() - t0) / 1000).toFixed(0)}s — local: ${l.rows[0].n}, Turso: ${r.rows[0].n}`);
  } finally {
    local.close();
    try {
      remote.close();
    } catch {
      // Ignore close error.
    }
  }
}

main().catch((e) => {
  console.error(`❌ Error de sincronización: ${formatError(e)}`);
  process.exit(1);
});
