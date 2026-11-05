import { Hono } from "hono";
import { cors } from "hono/cors";
import { auth } from "./auth.js";
import * as db from "./db.js";

const app = new Hono();

// CORS & Preflight
app.use(
  "*",
  cors({
    origin: (origin) => origin || "*",
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    exposeHeaders: ["Set-Cookie"],
    credentials: true,
  })
);

// Better Auth Endpoints
app.on(["POST", "GET"], "/api/auth/*", (c) => {
  return auth.handler(c.req.raw);
});

// Helper: Get user session from request
async function getUserSession(c: any) {
  try {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    return session;
  } catch (e) {
    return null;
  }
}

// ----------------- Public Catalog API -----------------

// API: Search products
app.get("/api/search", async (c) => {
  const query = c.req.query("q") || "";
  const provider = c.req.query("provider") || "";
  const category = c.req.query("category") || "";
  const limit = Math.min(Number(c.req.query("limit") || 40), 100);
  const page = Math.max(Number(c.req.query("page") || 1), 1);
  const offset = (page - 1) * limit;

  const res = await db.searchProducts(query, provider, category, limit, offset);
  return c.json({
    ...res,
    page,
    limit,
  });
});

// API: Providers summary
app.get("/api/providers", async (c) => {
  const summary = await db.getProvidersSummary();
  return c.json(summary);
});

// API: Categories
app.get("/api/categories", async (c) => {
  const provider = c.req.query("provider") || "";
  const cats = await db.getCategories(provider);
  return c.json(cats);
});

// API: Product details
app.get("/api/product/:uid", async (c) => {
  const uid = c.req.param("uid");
  const product = await db.getProductByUid(uid);
  if (!product) return c.json({ error: "Producto no encontrado" }, 404);
  return c.json(product);
});

// ----------------- Carts API (User Scoped) -----------------

async function currentUserId(c: any): Promise<string | null> {
  const session = await getUserSession(c);
  return session?.user?.id || null;
}

// Devuelve el id del carrito solo si pertenece al usuario actual (o ambos son invitados).
async function ownedCartId(c: any): Promise<number | null> {
  const cartId = Number(c.req.param("id"));
  if (!Number.isFinite(cartId)) return null;
  const owner = await db.getCartOwner(cartId);
  if (owner === undefined) return null; // no existe
  return owner === (await currentUserId(c)) ? cartId : null;
}

const notFound = (c: any) => c.json({ error: "Carrito no encontrado" }, 404);

// List carts for current session/user
app.get("/api/carts", async (c) => {
  return c.json(await db.listCarts(await currentUserId(c)));
});

// Create new cart
app.post("/api/carts", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 80) || "Nuevo Presupuesto";
  return c.json(await db.createCart(name, await currentUserId(c)), 201);
});

// Export ALL carts of the user (registered before /:id routes)
app.get("/api/carts/export-all", async (c) => {
  const userId = await currentUserId(c);
  const list = await db.listCarts(userId);
  const carts = (await Promise.all(list.map((x) => db.getCartDetails(x.id)))).filter(Boolean) as any[];
  const withPrices = c.req.query("prices") !== "0";
  return csvResponse(c, buildCsv(carts, withPrices), `presupuestos_todos${withPrices ? "" : "_sin_precios"}.csv`);
});

// Get specific cart details
app.get("/api/carts/:id", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  return c.json(await db.getCartDetails(cartId));
});

// Rename cart
app.put("/api/carts/:id", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 80);
  if (!name) return c.json({ error: "Nombre requerido" }, 400);
  await db.renameCart(cartId, name);
  return c.json({ success: true, name });
});

// Delete cart
app.delete("/api/carts/:id", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  await db.deleteCart(cartId);
  return c.json({ success: true });
});

// Add or update cart item
app.post("/api/carts/:id/items", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  const body = await c.req.json().catch(() => ({}));
  return c.json(await db.addOrUpdateCartItem(cartId, body));
});

// Update item quantity
app.put("/api/carts/:id/items/:itemId", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  const body = await c.req.json().catch(() => ({}));
  return c.json(await db.updateCartItemQty(cartId, Number(c.req.param("itemId")), Number(body.delta || 0)));
});

// Remove item from cart
app.delete("/api/carts/:id/items/:itemId", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  return c.json(await db.removeCartItem(cartId, Number(c.req.param("itemId"))));
});

// Clear cart
app.post("/api/carts/:id/clear", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  return c.json(await db.clearCart(cartId));
});

// Export cart CSV  (?prices=0 → lista de materiales sin precios)
app.get("/api/carts/:id/export", async (c) => {
  const cartId = await ownedCartId(c);
  if (!cartId) return notFound(c);
  const cart = await db.getCartDetails(cartId);
  const withPrices = c.req.query("prices") !== "0";
  const safe = String(cart!.name).replace(/[^\w\-]+/g, "_").slice(0, 40) || cartId;
  return csvResponse(c, buildCsv([cart], withPrices), `presupuesto_${safe}${withPrices ? "" : "_sin_precios"}.csv`);
});

// ----------------- CSV (formato regional AR: ';' y coma decimal) -----------------

const q = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
const money = (n: number) => n.toFixed(2).replace(".", ",");

function buildCsv(carts: any[], withPrices: boolean): string {
  const header = withPrices
    ? ["Carrito", "Proveedor", "SKU", "Producto", "Variante", "Cantidad", "Precio Unitario", "Subtotal", "Link"]
    : ["Carrito", "Proveedor", "SKU", "Producto", "Variante", "Cantidad", "Link"];
  const lines = [header.join(";")];
  const grand = new Map<string, number>();
  let grandTotal = 0;

  for (const cart of carts) {
    const byProv = new Map<string, any[]>();
    for (const it of cart.items) {
      const p = it.provider || "Paternal SRL";
      if (!byProv.has(p)) byProv.set(p, []);
      byProv.get(p)!.push(it);
    }
    let cartTotal = 0;
    for (const [prov, items] of [...byProv].sort((a, b) => a[0].localeCompare(b[0]))) {
      let provTotal = 0;
      for (const it of items) {
        const sub = it.price * it.quantity;
        provTotal += sub;
        const base = [q(cart.name), q(prov), q(it.sku), q(it.name), q(it.variant_label), it.quantity];
        lines.push((withPrices ? [...base, money(it.price), money(sub), q(it.permalink)] : [...base, q(it.permalink)]).join(";"));
      }
      cartTotal += provTotal;
      grand.set(prov, (grand.get(prov) || 0) + provTotal);
      if (withPrices) lines.push([q(cart.name), q(prov), "", q(`SUBTOTAL ${prov}`), "", "", "", money(provTotal), ""].join(";"));
    }
    grandTotal += cartTotal;
    if (withPrices) lines.push([q(cart.name), "", "", q(`TOTAL CARRITO ${cart.name}`), "", "", "", money(cartTotal), ""].join(";"));
    lines.push("");
  }

  if (withPrices && carts.length > 1) {
    lines.push(q("RESUMEN GENERAL POR PROVEEDOR"));
    for (const [prov, tot] of [...grand].sort((a, b) => a[0].localeCompare(b[0]))) {
      lines.push(["", q(prov), "", q(`TOTAL ${prov}`), "", "", "", money(tot), ""].join(";"));
    }
    lines.push(["", "", "", q("TOTAL GENERAL"), "", "", "", money(grandTotal), ""].join(";"));
  }
  return "\ufeff" + lines.join("\r\n");
}

function csvResponse(c: any, body: string, filename: string) {
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  return c.body(body);
}

export default app;
