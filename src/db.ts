import { client } from "./auth.js";

export interface Product {
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
  price_range_min?: number;
  price_range_max?: number;
  permalink: string;
  image_url: string;
  images_json: string;
  categories_text: string;
  categories_json: string;
  attributes_json: string;
  variations_json: string;
  short_description: string;
  description: string;
  is_in_stock: number;
  images?: any[];
  categories?: any[];
  attributes?: any[];
  variations?: any[];
}

export function formatProduct(p: any): Product {
  const price = Number(p.price || 0);
  const ivaRate = Number(p.iva_rate || 21);
  let priceNeto = Number(p.price_neto || 0);
  let ivaAmount = Number(p.iva_amount || 0);

  if (!priceNeto && price > 0) {
    priceNeto = Math.round((price / (1 + ivaRate / 100)) * 100) / 100;
  }
  if (!ivaAmount && price > 0) {
    ivaAmount = Math.round((price - priceNeto) * 100) / 100;
  }

  return {
    ...p,
    price,
    price_neto: priceNeto,
    iva_rate: ivaRate,
    iva_amount: ivaAmount,
    images: p.images_json ? JSON.parse(p.images_json) : [],
    categories: p.categories_json ? JSON.parse(p.categories_json) : [],
    attributes: p.attributes_json ? JSON.parse(p.attributes_json) : [],
    variations: p.variations_json ? JSON.parse(p.variations_json) : [],
  };
}

export async function searchProducts(
  query = "",
  provider = "",
  category = "",
  limit = 40,
  offset = 0
) {
  const cleanedQ = query.trim();
  const exactSkuProds: Product[] = [];

  if (cleanedQ) {
    // 1. Prioritize Exact SKU match
    let skuSql = "SELECT * FROM products WHERE sku = ?";
    const skuParams: any[] = [cleanedQ];
    if (provider) {
      skuSql += " AND provider = ?";
      skuParams.push(provider);
    }
    const skuRes = await client.execute({ sql: skuSql, args: skuParams });
    for (const row of skuRes.rows) {
      exactSkuProds.push(formatProduct(row));
    }

    const tokens = cleanedQ
      .split(/\s+/)
      .map((t) => t.replace(/["'*]/g, "").trim())
      .filter(Boolean);

    const canUseFts = tokens.length > 0 && tokens.every((t) => t.length >= 3);

    if (canUseFts) {
      const ftsQuery = tokens.map((t) => `"${t}"`).join(" AND ");
      let sql = `
        SELECT p.*
        FROM products p
        JOIN products_fts fts ON p.rowid = fts.rowid
        WHERE products_fts MATCH ?
      `;
      const params: any[] = [ftsQuery];
      if (provider) {
        sql += " AND p.provider = ?";
        params.push(provider);
      }
      if (category) {
        sql += " AND p.categories_text LIKE ?";
        params.push(`%${category}%`);
      }

      const countSql = `SELECT COUNT(*) as cnt FROM (${sql})`;
      const countRes = await client.execute({ sql: countSql, args: params });
      const total = Number(countRes.rows[0]?.cnt || 0);

      sql += " ORDER BY (p.price > 0) DESC, p.is_in_stock DESC, p.price ASC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      const rowsRes = await client.execute({ sql, args: params });

      const products: Product[] = [];
      const seenUids = new Set<string>();

      if (offset === 0 && exactSkuProds.length > 0) {
        for (const p of exactSkuProds) {
          products.push(p);
          seenUids.add(p.uid);
        }
      }

      for (const row of rowsRes.rows) {
        const prod = formatProduct(row);
        if (!seenUids.has(prod.uid)) {
          products.push(prod);
          seenUids.add(prod.uid);
        }
      }

      return { total: Math.max(total, products.length), products: products.slice(0, limit) };
    } else {
      // Fallback for short words
      let sql = "SELECT p.* FROM products p WHERE 1=1";
      const params: any[] = [];
      for (const t of tokens) {
        sql += " AND (p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR p.categories_text LIKE ?)";
        params.push(`%${t}%`, `%${t}%`, `%${t}%`, `%${t}%`);
      }
      if (provider) {
        sql += " AND p.provider = ?";
        params.push(provider);
      }
      if (category) {
        sql += " AND p.categories_text LIKE ?";
        params.push(`%${category}%`);
      }

      const countSql = `SELECT COUNT(*) as cnt FROM (${sql})`;
      const countRes = await client.execute({ sql: countSql, args: params });
      const total = Number(countRes.rows[0]?.cnt || 0);

      sql += " ORDER BY (p.price > 0) DESC, p.is_in_stock DESC, p.price ASC LIMIT ? OFFSET ?";
      params.push(limit, offset);
      const rowsRes = await client.execute({ sql, args: params });

      const products: Product[] = [];
      const seenUids = new Set<string>();

      if (offset === 0 && exactSkuProds.length > 0) {
        for (const p of exactSkuProds) {
          products.push(p);
          seenUids.add(p.uid);
        }
      }

      for (const row of rowsRes.rows) {
        const prod = formatProduct(row);
        if (!seenUids.has(prod.uid)) {
          products.push(prod);
          seenUids.add(prod.uid);
        }
      }

      return { total: Math.max(total, products.length), products: products.slice(0, limit) };
    }
  } else {
    let sql = "SELECT * FROM products WHERE 1=1";
    const params: any[] = [];
    if (provider) {
      sql += " AND provider = ?";
      params.push(provider);
    }
    if (category) {
      sql += " AND categories_text LIKE ?";
      params.push(`%${category}%`);
    }

    const countSql = `SELECT COUNT(*) as cnt FROM (${sql})`;
    const countRes = await client.execute({ sql: countSql, args: params });
    const total = Number(countRes.rows[0]?.cnt || 0);

    sql += " ORDER BY (price > 0) DESC, is_in_stock DESC, price ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    const rowsRes = await client.execute({ sql, args: params });

    const products = rowsRes.rows.map(formatProduct);
    return { total, products };
  }
}

export async function getProvidersSummary() {
  const res = await client.execute(
    "SELECT provider, COUNT(*) as count FROM products GROUP BY provider ORDER BY count DESC"
  );
  return res.rows.map((r: any) => ({
    provider: String(r.provider),
    count: Number(r.count),
  }));
}

export async function getCategories(provider = "") {
  let sql = "SELECT categories_text FROM products WHERE categories_text != ''";
  const params: any[] = [];
  if (provider) {
    sql += " AND provider = ?";
    params.push(provider);
  }
  const res = await client.execute({ sql, args: params });
  const cats = new Set<string>();
  for (const row of res.rows) {
    const text = String(row.categories_text || "");
    for (const c of text.split(" | ")) {
      const clean = c.trim();
      if (clean) cats.add(clean);
    }
  }
  return Array.from(cats).sort();
}

export async function getProductByUid(uid: string) {
  const res = await client.execute({
    sql: "SELECT * FROM products WHERE uid = ?",
    args: [uid],
  });
  if (res.rows.length === 0) return null;
  return formatProduct(res.rows[0]);
}

// ------------------- Carts Functions (User Scoped) -------------------

export async function listCarts(userId?: string | null) {
  let sql = `
    SELECT c.*, 
           COUNT(i.id) as item_count, 
           COALESCE(SUM(i.price * i.quantity), 0) as total_amount
    FROM carts c
    LEFT JOIN cart_items i ON c.id = i.cart_id
  `;
  const params: any[] = [];

  if (userId) {
    sql += " WHERE c.user_id = ?";
    params.push(userId);
  } else {
    sql += " WHERE c.user_id IS NULL";
  }

  sql += " GROUP BY c.id ORDER BY c.updated_at DESC";

  let res = await client.execute({ sql, args: params });

  // Si no hay ningún carrito para este usuario o sesión anónima, crear uno por defecto
  if (res.rows.length === 0) {
    const defaultName = userId ? "Mi Presupuesto" : "Presupuesto Temporal";
    await createCart(defaultName, userId);
    res = await client.execute({ sql, args: params });
  }

  return res.rows.map((r: any) => ({
    id: Number(r.id),
    name: String(r.name),
    user_id: r.user_id ? String(r.user_id) : null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
    item_count: Number(r.item_count),
    total_amount: Number(r.total_amount),
  }));
}

export async function createCart(name: string, userId?: string | null) {
  const res = await client.execute({
    sql: "INSERT INTO carts (name, user_id) VALUES (?, ?)",
    args: [name.trim(), userId || null],
  });
  const cartId = Number(res.lastInsertRowid);
  return { id: cartId, name: name.trim(), user_id: userId || null, item_count: 0, total_amount: 0 };
}

export async function deleteCart(cartId: number, userId?: string | null) {
  let countSql = "SELECT COUNT(*) as cnt FROM carts WHERE 1=1";
  const countParams: any[] = [];
  if (userId) {
    countSql += " AND user_id = ?";
    countParams.push(userId);
  } else {
    countSql += " AND user_id IS NULL";
  }
  const countRes = await client.execute({ sql: countSql, args: countParams });
  const total = Number(countRes.rows[0]?.cnt || 0);
  if (total <= 1) return false;

  await client.execute({
    sql: "DELETE FROM carts WHERE id = ?",
    args: [cartId],
  });
  return true;
}

export async function renameCart(cartId: number, newName: string) {
  await client.execute({
    sql: "UPDATE carts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [newName.trim(), cartId],
  });
  return true;
}

export async function getCartDetails(cartId: number) {
  const cartRes = await client.execute({
    sql: "SELECT * FROM carts WHERE id = ?",
    args: [cartId],
  });
  if (cartRes.rows.length === 0) return null;
  const cart: any = cartRes.rows[0];

  const itemsRes = await client.execute({
    sql: "SELECT * FROM cart_items WHERE cart_id = ? ORDER BY id DESC",
    args: [cartId],
  });

  const items = itemsRes.rows.map((r: any) => ({
    id: Number(r.id),
    cart_id: Number(r.cart_id),
    provider: String(r.provider || "Paternal SRL"),
    product_uid: String(r.product_uid || ""),
    product_id: Number(r.product_id),
    variation_id: r.variation_id ? Number(r.variation_id) : null,
    name: String(r.name),
    variant_label: String(r.variant_label || ""),
    sku: String(r.sku || ""),
    price: Number(r.price),
    quantity: Number(r.quantity),
    image_url: String(r.image_url || ""),
    permalink: String(r.permalink || ""),
    created_at: String(r.created_at),
  }));

  const totalAmount = items.reduce((acc, i) => acc + i.price * i.quantity, 0);

  return {
    id: Number(cart.id),
    name: String(cart.name),
    user_id: cart.user_id ? String(cart.user_id) : null,
    created_at: String(cart.created_at),
    updated_at: String(cart.updated_at),
    items,
    total_amount: totalAmount,
  };
}

export async function addOrUpdateCartItem(cartId: number, itemData: any) {
  const productUid = itemData.product_uid || `${String(itemData.provider || "paternal").toLowerCase()}_${itemData.product_id}`;
  const variationId = itemData.variation_id ? Number(itemData.variation_id) : null;
  const provider = itemData.provider || "Paternal SRL";
  const quantity = Number(itemData.quantity || 1);

  const existingRes = await client.execute({
    sql: `
      SELECT id, quantity FROM cart_items 
      WHERE cart_id = ? AND product_uid = ? AND (variation_id = ? OR (variation_id IS NULL AND ? IS NULL))
    `,
    args: [cartId, productUid, variationId, variationId],
  });

  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    const newQty = Number(existing.quantity) + quantity;
    if (newQty <= 0) {
      await client.execute({
        sql: "DELETE FROM cart_items WHERE id = ?",
        args: [Number(existing.id)],
      });
    } else {
      await client.execute({
        sql: "UPDATE cart_items SET quantity = ? WHERE id = ?",
        args: [newQty, Number(existing.id)],
      });
    }
  } else {
    if (quantity > 0) {
      await client.execute({
        sql: `
          INSERT INTO cart_items (
            cart_id, provider, product_uid, product_id, variation_id, name, variant_label, 
            sku, price, quantity, image_url, permalink
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          cartId,
          provider,
          productUid,
          Number(itemData.product_id || 0),
          variationId,
          String(itemData.name || ""),
          String(itemData.variant_label || ""),
          String(itemData.sku || ""),
          Number(itemData.price || 0),
          quantity,
          String(itemData.image_url || ""),
          String(itemData.permalink || ""),
        ],
      });
    }
  }

  await client.execute({
    sql: "UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [cartId],
  });

  return getCartDetails(cartId);
}

export async function updateCartItemQty(cartId: number, itemId: number, delta: number) {
  const existingRes = await client.execute({
    sql: "SELECT id, quantity FROM cart_items WHERE cart_id = ? AND id = ?",
    args: [cartId, itemId],
  });
  if (existingRes.rows.length > 0) {
    const existing = existingRes.rows[0];
    const newQty = Number(existing.quantity) + delta;
    if (newQty <= 0) {
      await client.execute({
        sql: "DELETE FROM cart_items WHERE id = ?",
        args: [itemId],
      });
    } else {
      await client.execute({
        sql: "UPDATE cart_items SET quantity = ? WHERE id = ?",
        args: [newQty, itemId],
      });
    }
    await client.execute({
      sql: "UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [cartId],
    });
  }
  return getCartDetails(cartId);
}

export async function removeCartItem(cartId: number, itemId: number) {
  await client.execute({
    sql: "DELETE FROM cart_items WHERE cart_id = ? AND id = ?",
    args: [cartId, itemId],
  });
  await client.execute({
    sql: "UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [cartId],
  });
  return getCartDetails(cartId);
}

export async function clearCart(cartId: number) {
  await client.execute({
    sql: "DELETE FROM cart_items WHERE cart_id = ?",
    args: [cartId],
  });
  await client.execute({
    sql: "UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    args: [cartId],
  });
  return getCartDetails(cartId);
}
