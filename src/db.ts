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
  group_key?: string | null;
  offers?: Array<{
    uid: string;
    provider: string;
    id: number;
    sku: string;
    name: string;
    brand: string;
    price: number;
    price_neto: number;
    iva_rate: number;
    iva_amount: number;
    is_in_stock: number;
    permalink: string;
    image_url: string;
    source?: string;
  }>;
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
  offset = 0,
  collapseGroups = !provider
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

      const enriched = await enrichAndConsolidateProducts(products.slice(0, limit), collapseGroups);
      return { total: Math.max(total, enriched.length), products: enriched };
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

      const enriched = await enrichAndConsolidateProducts(products.slice(0, limit), collapseGroups);
      return { total: Math.max(total, enriched.length), products: enriched };
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

    const products = await enrichAndConsolidateProducts(rowsRes.rows.map(formatProduct), collapseGroups);
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
  const enriched = await enrichAndConsolidateProducts([formatProduct(res.rows[0])], false);
  return enriched[0] || null;
}

// ------------------- Multi-Provider Product Links & Consolidation -------------------

export async function enrichAndConsolidateProducts(products: Product[], collapseGroups = true): Promise<Product[]> {
  if (!products.length) return products;
  try {
    const uids = products.map((p) => p.uid);
    const placeholders = uids.map(() => "?").join(",");
    const linkRes = await client.execute({
      sql: `SELECT uid, group_key, source FROM product_links WHERE uid IN (${placeholders}) AND source != 'unlinked'`,
      args: uids,
    });
    if (linkRes.rows.length === 0) return products;

    const uidToGroup = new Map<string, string>();
    const groupKeys = new Set<string>();
    for (const r of linkRes.rows) {
      const gk = String(r.group_key);
      uidToGroup.set(String(r.uid), gk);
      groupKeys.add(gk);
    }

    const gkArr = Array.from(groupKeys);
    const gkPh = gkArr.map(() => "?").join(",");
    const sibRes = await client.execute({
      sql: `
        SELECT p.*, pl.group_key, pl.source as link_source
        FROM products p
        JOIN product_links pl ON p.uid = pl.uid
        WHERE pl.group_key IN (${gkPh}) AND pl.source != 'unlinked'
      `,
      args: gkArr,
    });

    const byGroup = new Map<string, Array<Product & { link_source?: string }>>();
    for (const row of sibRes.rows) {
      const fp = formatProduct(row) as Product & { link_source?: string };
      fp.link_source = String(row.link_source || "auto");
      const gk = String(row.group_key);
      if (!byGroup.has(gk)) byGroup.set(gk, []);
      byGroup.get(gk)!.push(fp);
    }

    // Ordenar ofertas de cada grupo: 1º en stock y con precio > 0, luego menor precio
    for (const [, list] of byGroup) {
      list.sort((a, b) => {
        const aOk = a.is_in_stock > 0 && a.price > 0 ? 1 : 0;
        const bOk = b.is_in_stock > 0 && b.price > 0 ? 1 : 0;
        if (aOk !== bOk) return bOk - aOk;
        const aHasP = a.price > 0 ? 1 : 0;
        const bHasP = b.price > 0 ? 1 : 0;
        if (aHasP !== bHasP) return bHasP - aHasP;
        return a.price - b.price;
      });
    }

    const out: Product[] = [];
    const seenGroups = new Set<string>();

    for (const p of products) {
      const gk = uidToGroup.get(p.uid);
      if (!gk) {
        out.push(p);
        continue;
      }
      const siblings = byGroup.get(gk) || [p];
      if (siblings.length <= 1) {
        out.push(p);
        continue;
      }

      const offers = siblings.map((s) => ({
        uid: s.uid,
        provider: s.provider,
        id: s.id,
        sku: s.sku,
        name: s.name,
        brand: s.brand,
        price: s.price,
        price_neto: s.price_neto,
        iva_rate: s.iva_rate,
        iva_amount: s.iva_amount,
        is_in_stock: s.is_in_stock,
        permalink: s.permalink,
        image_url: s.image_url,
        source: s.link_source || "auto",
      }));

      if (collapseGroups) {
        if (seenGroups.has(gk)) continue;
        seenGroups.add(gk);
        const best = { ...siblings[0] };
        if (!best.image_url) {
          const withImg = siblings.find((s) => s.image_url);
          if (withImg) best.image_url = withImg.image_url;
        }
        best.group_key = gk;
        best.offers = offers;
        out.push(best);
      } else {
        out.push({
          ...p,
          group_key: gk,
          offers,
        });
      }
    }

    return out;
  } catch (e) {
    // Si product_links aún no existe en algún entorno, devolver productos sin romper
    return products;
  }
}

export async function linkProducts(uidA: string, uidB: string) {
  if (!uidA || !uidB || uidA === uidB) return { error: "UIDs inválidos" };
  const existing = await client.execute({
    sql: "SELECT uid, group_key, source FROM product_links WHERE uid IN (?, ?) AND source != 'unlinked'",
    args: [uidA, uidB],
  });

  let targetGroup = `manual_${Date.now()}`;
  const groupsToMerge: string[] = [];
  for (const r of existing.rows) {
    const gk = String(r.group_key);
    if (!groupsToMerge.includes(gk)) groupsToMerge.push(gk);
  }
  if (groupsToMerge.length > 0) {
    targetGroup = groupsToMerge[0];
  }

  const stmts: Array<{ sql: string; args: any[] }> = [];
  if (groupsToMerge.length > 1) {
    for (const oldGk of groupsToMerge.slice(1)) {
      stmts.push({
        sql: "UPDATE product_links SET group_key = ?, source = 'manual', updated_at = CURRENT_TIMESTAMP WHERE group_key = ?",
        args: [targetGroup, oldGk],
      });
    }
  }
  for (const u of [uidA, uidB]) {
    stmts.push({
      sql: "INSERT OR REPLACE INTO product_links (uid, group_key, source, updated_at) VALUES (?, ?, 'manual', CURRENT_TIMESTAMP)",
      args: [u, targetGroup],
    });
  }
  await client.batch(stmts, "write");
  return { success: true, group_key: targetGroup };
}

export async function unlinkProduct(uid: string) {
  if (!uid) return { error: "UID requerido" };
  await client.execute({
    sql: "INSERT OR REPLACE INTO product_links (uid, group_key, source, updated_at) VALUES (?, ?, 'unlinked', CURRENT_TIMESTAMP)",
    args: [uid, `unlinked_${uid}`],
  });
  return { success: true };
}

export async function analyzeCartOptimization(cartId: number) {
  const cart = await getCartDetails(cartId);
  if (!cart || !cart.items.length) {
    return { stockAlerts: [], savingsByProvider: [], consolidations: [] };
  }

  const uids = Array.from(new Set(cart.items.map((i) => i.product_uid).filter(Boolean)));
  if (!uids.length) {
    return { stockAlerts: [], savingsByProvider: [], consolidations: [] };
  }

  const ph = uids.map(() => "?").join(",");
  const curProdsRes = await client.execute({
    sql: `SELECT uid, provider, is_in_stock, price FROM products WHERE uid IN (${ph})`,
    args: uids,
  });
  const stockByUid = new Map<string, number>();
  for (const r of curProdsRes.rows) {
    stockByUid.set(String(r.uid), Number(r.is_in_stock));
  }

  const linkRes = await client.execute({
    sql: `SELECT uid, group_key FROM product_links WHERE uid IN (${ph}) AND source != 'unlinked'`,
    args: uids,
  });

  const uidToGroup = new Map<string, string>();
  const groupKeys = new Set<string>();
  for (const r of linkRes.rows) {
    const gk = String(r.group_key);
    uidToGroup.set(String(r.uid), gk);
    groupKeys.add(gk);
  }

  const groupOffers = new Map<string, Product[]>();
  if (groupKeys.size > 0) {
    const gkArr = Array.from(groupKeys);
    const gkPh = gkArr.map(() => "?").join(",");
    const sibRes = await client.execute({
      sql: `
        SELECT p.*, pl.group_key
        FROM products p
        JOIN product_links pl ON p.uid = pl.uid
        WHERE pl.group_key IN (${gkPh}) AND pl.source != 'unlinked'
      `,
      args: gkArr,
    });
    for (const row of sibRes.rows) {
      const gk = String(row.group_key);
      if (!groupOffers.has(gk)) groupOffers.set(gk, []);
      groupOffers.get(gk)!.push(formatProduct(row));
    }
  }

  // 1. Alertas de sin stock con alternativa disponible en otro proveedor
  const stockAlerts: any[] = [];
  for (const item of cart.items) {
    const inStock = stockByUid.get(item.product_uid) ?? 1;
    if (inStock === 0) {
      const gk = uidToGroup.get(item.product_uid);
      const alts = (gk ? groupOffers.get(gk) || [] : []).filter(
        (o) => o.uid !== item.product_uid && o.is_in_stock > 0 && o.price > 0
      );
      alts.sort((a, b) => a.price - b.price);
      if (alts.length > 0) {
        const best = alts[0];
        stockAlerts.push({
          itemId: item.id,
          name: item.name,
          quantity: item.quantity,
          fromProvider: item.provider,
          fromPrice: item.price,
          toProvider: best.provider,
          toPrice: best.price,
          toUid: best.uid,
          toProductId: best.id,
          toSku: best.sku,
          toName: best.name,
          toImageUrl: best.image_url || item.image_url,
          toPermalink: best.permalink,
        });
      }
    }
  }

  // 2. Ahorro agrupado por proveedor destino
  const byTargetProv = new Map<string, { targetProvider: string; totalSaving: number; swaps: any[] }>();
  for (const item of cart.items) {
    const gk = uidToGroup.get(item.product_uid);
    if (!gk) continue;
    const alts = (groupOffers.get(gk) || []).filter(
      (o) => o.provider !== item.provider && o.is_in_stock > 0 && o.price > 0 && o.price < item.price
    );
    for (const alt of alts) {
      const saving = (item.price - alt.price) * item.quantity;
      if (saving <= 0) continue;
      if (!byTargetProv.has(alt.provider)) {
        byTargetProv.set(alt.provider, { targetProvider: alt.provider, totalSaving: 0, swaps: [] });
      }
      const bucket = byTargetProv.get(alt.provider)!;
      bucket.totalSaving += saving;
      bucket.swaps.push({
        itemId: item.id,
        quantity: item.quantity,
        fromProvider: item.provider,
        fromName: item.name,
        fromPrice: item.price,
        toProvider: alt.provider,
        toUid: alt.uid,
        toProductId: alt.id,
        toSku: alt.sku,
        toName: alt.name,
        toPrice: alt.price,
        toImageUrl: alt.image_url || item.image_url,
        toPermalink: alt.permalink,
        saving,
      });
    }
  }
  const savingsByProvider = Array.from(byTargetProv.values()).sort((a, b) => b.totalSaving - a.totalSaving);

  // 3. Consolidación logística (pasar ítems sueltos de otros proveedores a un proveedor que ya tenés en el carrito)
  const cartProviders = Array.from(new Set(cart.items.map((i) => i.provider)));
  const consolidations: any[] = [];
  if (cartProviders.length > 1) {
    for (const targetProv of cartProviders) {
      const otherItems = cart.items.filter((i) => i.provider !== targetProv);
      const moves: any[] = [];
      let priceDelta = 0;
      for (const item of otherItems) {
        const gk = uidToGroup.get(item.product_uid);
        if (!gk) continue;
        const match = (groupOffers.get(gk) || []).find(
          (o) => o.provider === targetProv && o.is_in_stock > 0 && o.price > 0
        );
        if (match) {
          const diff = (match.price - item.price) * item.quantity;
          priceDelta += diff;
          moves.push({
            itemId: item.id,
            quantity: item.quantity,
            fromProvider: item.provider,
            fromName: item.name,
            fromPrice: item.price,
            toProvider: match.provider,
            toUid: match.uid,
            toProductId: match.id,
            toSku: match.sku,
            toName: match.name,
            toPrice: match.price,
            toImageUrl: match.image_url || item.image_url,
            toPermalink: match.permalink,
            diff,
          });
        }
      }
      if (moves.length > 0) {
        consolidations.push({
          targetProvider: targetProv,
          movableCount: moves.length,
          totalOtherCount: otherItems.length,
          priceDelta,
          moves,
        });
      }
    }
  }

  return { stockAlerts, savingsByProvider, consolidations };
}

export async function replaceCartItemsBatch(cartId: number, items: any[]) {
  const stmts: Array<{ sql: string; args: any[] }> = [
    { sql: "DELETE FROM cart_items WHERE cart_id = ?", args: [cartId] },
  ];
  for (const it of items) {
    stmts.push({
      sql: `
        INSERT INTO cart_items (
          cart_id, provider, product_uid, product_id, variation_id, name, variant_label,
          sku, price, quantity, image_url, permalink
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        cartId,
        String(it.provider || "Paternal SRL"),
        String(it.product_uid || ""),
        Number(it.product_id || 0),
        it.variation_id ? Number(it.variation_id) : null,
        String(it.name || ""),
        String(it.variant_label || ""),
        String(it.sku || ""),
        Number(it.price || 0),
        Number(it.quantity || 1),
        String(it.image_url || ""),
        String(it.permalink || ""),
      ],
    });
  }
  stmts.push({ sql: "UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", args: [cartId] });
  await client.batch(stmts, "write");
  return getCartDetails(cartId);
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

export async function getCartOwner(cartId: number): Promise<string | null | undefined> {
  const res = await client.execute({ sql: "SELECT user_id FROM carts WHERE id = ?", args: [cartId] });
  if (res.rows.length === 0) return undefined;
  return res.rows[0].user_id ? String(res.rows[0].user_id) : null;
}

// Si se borra el último carrito, listCarts() crea uno vacío automáticamente.
export async function deleteCart(cartId: number) {
  await client.batch(
    [
      { sql: "DELETE FROM cart_items WHERE cart_id = ?", args: [cartId] },
      { sql: "DELETE FROM carts WHERE id = ?", args: [cartId] },
    ],
    "write"
  );
  return true;
}

export async function deleteUserCarts(userId: string) {
  await client.batch(
    [
      { sql: "DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE user_id = ?)", args: [userId] },
      { sql: "DELETE FROM carts WHERE user_id = ?", args: [userId] },
    ],
    "write"
  );
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
