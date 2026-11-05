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
app.on(["POST", "GET"], "/api/auth/**", (c) => {
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

// List carts for current session/user
app.get("/api/carts", async (c) => {
  const session = await getUserSession(c);
  const userId = session?.user?.id || null;
  const carts = await db.listCarts(userId);
  return c.json(carts);
});

// Create new cart
app.post("/api/carts", async (c) => {
  const session = await getUserSession(c);
  const userId = session?.user?.id || null;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim() || "Nuevo Presupuesto";
  const cart = await db.createCart(name, userId);
  return c.json(cart, 201);
});

// Get specific cart details
app.get("/api/carts/:id", async (c) => {
  const cartId = Number(c.req.param("id"));
  const cart = await db.getCartDetails(cartId);
  if (!cart) return c.json({ error: "Carrito no encontrado" }, 404);
  return c.json(cart);
});

// Rename cart
app.put("/api/carts/:id", async (c) => {
  const cartId = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  if (!name) return c.json({ error: "Nombre requerido" }, 400);
  await db.renameCart(cartId, name);
  return c.json({ success: true, name });
});

// Delete cart
app.delete("/api/carts/:id", async (c) => {
  const session = await getUserSession(c);
  const userId = session?.user?.id || null;
  const cartId = Number(c.req.param("id"));
  const ok = await db.deleteCart(cartId, userId);
  if (!ok) return c.json({ error: "No se puede eliminar el último carrito" }, 400);
  return c.json({ success: true });
});

// Add or update cart item
app.post("/api/carts/:id/items", async (c) => {
  const cartId = Number(c.req.param("id"));
  const body = await c.req.json().catch(() => ({}));
  const updated = await db.addOrUpdateCartItem(cartId, body);
  return c.json(updated);
});

// Update item quantity
app.put("/api/carts/:id/items/:itemId", async (c) => {
  const cartId = Number(c.req.param("id"));
  const itemId = Number(c.req.param("itemId"));
  const body = await c.req.json().catch(() => ({}));
  const delta = Number(body.delta || 0);
  const updated = await db.updateCartItemQty(cartId, itemId, delta);
  return c.json(updated);
});

// Remove item from cart
app.delete("/api/carts/:id/items/:itemId", async (c) => {
  const cartId = Number(c.req.param("id"));
  const itemId = Number(c.req.param("itemId"));
  const updated = await db.removeCartItem(cartId, itemId);
  return c.json(updated);
});

// Clear cart
app.post("/api/carts/:id/clear", async (c) => {
  const cartId = Number(c.req.param("id"));
  const updated = await db.clearCart(cartId);
  return c.json(updated);
});

// Export cart CSV
app.get("/api/carts/:id/export", async (c) => {
  const cartId = Number(c.req.param("id"));
  const cart = await db.getCartDetails(cartId);
  if (!cart) return c.json({ error: "Carrito no encontrado" }, 404);

  const csvLines = [
    "Proveedor;SKU;Producto;Variante;Precio Unitario;Cantidad;Subtotal;Link",
  ];
  for (const item of cart.items) {
    const subtotal = item.price * item.quantity;
    const prov = (item.provider || "Paternal SRL").replace(/"/g, '""');
    const name = item.name.replace(/"/g, '""');
    const varLabel = (item.variant_label || "").replace(/"/g, '""');
    const priceStr = item.price.toFixed(2).replace(".", ",");
    const subtotalStr = subtotal.toFixed(2).replace(".", ",");
    csvLines.push(
      `"${prov}";"${item.sku}";"${name}";"${varLabel}";${priceStr};${item.quantity};${subtotalStr};"${item.permalink}"`
    );
  }

  const csvContent = "\ufeff" + csvLines.join("\r\n");
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="presupuesto_${cartId}.csv"`);
  return c.body(csvContent);
});

export default app;
