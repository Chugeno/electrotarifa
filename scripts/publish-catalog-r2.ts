// Publica snapshot del catálogo (paternal.db local) → Cloudflare R2 (bucket electrotarifa-catalog).
//
//   npx tsx scripts/publish-catalog-r2.ts
//
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as zlib from "zlib";
import { createClient } from "@libsql/client";

const BUCKET = "electrotarifa-catalog";

interface NormalizedProduct {
  uid: string;
  provider: string;
  id: number;
  sku: string;
  name: string;
  brand: string;
  slug: string;
  type: string;
  price: number;
  price_neto: number;
  iva_rate: number;
  iva_amount: number;
  regular_price: number;
  sale_price: number;
  price_range_min: number | null;
  price_range_max: number | null;
  permalink: string;
  image_url: string;
  categories_text: string;
  is_in_stock: number;
  variations_json: string;
}

interface NormalizedLink {
  uid: string;
  group_key: string;
  source: string;
}

function normalizeProduct(r: Record<string, unknown>): NormalizedProduct {
  const price = Number(r.price || 0);
  const ivaRate = Number(r.iva_rate || 21);
  let priceNeto = Number(r.price_neto || 0);
  let ivaAmount = Number(r.iva_amount || 0);

  if (!priceNeto && price > 0) {
    priceNeto = Math.round((price / (1 + ivaRate / 100)) * 100) / 100;
  }
  if (!ivaAmount && price > 0) {
    ivaAmount = Math.round((price - priceNeto) * 100) / 100;
  }

  return {
    uid: String(r.uid),
    provider: String(r.provider ?? ""),
    id: Number(r.id ?? 0),
    sku: String(r.sku ?? ""),
    name: String(r.name ?? ""),
    brand: String(r.brand ?? ""),
    slug: String(r.slug ?? ""),
    type: String(r.type || "simple"),
    price,
    price_neto: priceNeto,
    iva_rate: ivaRate,
    iva_amount: ivaAmount,
    regular_price: Number(r.regular_price ?? 0),
    sale_price: Number(r.sale_price ?? 0),
    price_range_min: r.price_range_min != null ? Number(r.price_range_min) : null,
    price_range_max: r.price_range_max != null ? Number(r.price_range_max) : null,
    permalink: String(r.permalink ?? ""),
    image_url: String(r.image_url ?? ""),
    categories_text: String(r.categories_text ?? ""),
    is_in_stock: Number(r.is_in_stock ?? 0),
    variations_json: r.variations_json ? String(r.variations_json) : "[]",
  };
}

function putR2Object(key: string, filePath: string, contentType: string, contentEncoding?: string): void {
  const args = [
    "wrangler",
    "r2",
    "object",
    "put",
    `${BUCKET}/${key}`,
    "--file",
    filePath,
    "--content-type",
    contentType,
  ];
  if (contentEncoding) {
    args.push("--content-encoding", contentEncoding);
  }
  args.push("--remote");
  execFileSync("npx", args, { stdio: "inherit" });
}

async function main() {
  const t0 = Date.now();
  const local = createClient({ url: "file:paternal.db" });

  let tmpDir: string | null = null;
  try {
    console.log("📦 Leyendo catálogo y vínculos desde paternal.db…");
    const [productsRes, linksRes] = await Promise.all([
      local.execute(`
        SELECT uid, provider, id, sku, name, brand, slug, type, price, price_neto, iva_rate, iva_amount,
               regular_price, sale_price, price_range_min, price_range_max, permalink, image_url,
               categories_text, is_in_stock, variations_json
        FROM products
        ORDER BY (price > 0) DESC, is_in_stock DESC, price ASC
      `),
      local.execute(`
        SELECT uid, group_key, source FROM product_links WHERE source != 'unlinked'
      `),
    ]);

    const products = productsRes.rows.map((r) => normalizeProduct(r as unknown as Record<string, unknown>));
    const links: NormalizedLink[] = linksRes.rows.map((r) => ({
      uid: String(r.uid),
      group_key: String(r.group_key),
      source: String(r.source || "auto"),
    }));

    const nowIso = new Date().toISOString();

    const catalogGz = zlib.gzipSync(
      Buffer.from(JSON.stringify({ version: nowIso, linksVersion: nowIso, products, links })),
      { level: 9 }
    );
    const linksBuf = Buffer.from(JSON.stringify(links));
    const versionBuf = Buffer.from(
      JSON.stringify({ version: nowIso, linksVersion: nowIso, count: products.length })
    );

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "et-r2-"));
    const catalogPath = path.join(tmpDir, "catalog.json.gz");
    const linksPath = path.join(tmpDir, "links.json");
    const versionPath = path.join(tmpDir, "version.json");

    fs.writeFileSync(catalogPath, catalogGz);
    fs.writeFileSync(linksPath, linksBuf);
    fs.writeFileSync(versionPath, versionBuf);

    const gzMb = (catalogGz.byteLength / (1024 * 1024)).toFixed(2);
    console.log(
      `☁️  Subiendo a R2 (${BUCKET}) — ${products.length} productos, ${links.length} links, ${gzMb} MB gzip…`
    );

    putR2Object("catalog.json.gz", catalogPath, "application/json", "gzip");
    putR2Object("links.json", linksPath, "application/json");
    putR2Object("version.json", versionPath, "application/json");

    console.log(
      `✅ Publicado en R2 en ${((Date.now() - t0) / 1000).toFixed(1)}s — productos: ${products.length}, links: ${links.length}, tamaño comprimido: ${gzMb} MB`
    );
  } finally {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    local.close();
  }
}

main().catch((e) => {
  console.error("❌ Error publicando catálogo en R2:", e?.message || e);
  process.exit(1);
});
