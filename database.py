"""
Módulo de Base de Datos SQLite Multi-Proveedor con soporte para FTS5 Trigram
y persistencia de carritos/presupuestos para Paternal SRL y Electro Tucumán.
"""
import sqlite3
import json
import os
import re
from typing import List, Dict, Any, Optional

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paternal.db")

def get_connection(db_path: str = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db(db_path: str = DB_PATH) -> None:
    conn = get_connection(db_path)
    with conn:
        # Tabla principal multi-proveedor
        conn.execute("""
            CREATE TABLE IF NOT EXISTS products (
                uid TEXT PRIMARY KEY,
                provider TEXT NOT NULL DEFAULT 'Paternal SRL',
                id INTEGER NOT NULL,
                sku TEXT DEFAULT '',
                name TEXT NOT NULL,
                brand TEXT DEFAULT '',
                slug TEXT DEFAULT '',
                type TEXT DEFAULT 'simple',
                price REAL DEFAULT 0.0,
                price_neto REAL DEFAULT 0.0,
                iva_rate REAL DEFAULT 21.0,
                iva_amount REAL DEFAULT 0.0,
                regular_price REAL DEFAULT 0.0,
                sale_price REAL DEFAULT 0.0,
                price_range_min REAL,
                price_range_max REAL,
                permalink TEXT DEFAULT '',
                image_url TEXT DEFAULT '',
                images_json TEXT DEFAULT '[]',
                categories_text TEXT DEFAULT '',
                categories_json TEXT DEFAULT '[]',
                attributes_json TEXT DEFAULT '[]',
                variations_json TEXT DEFAULT '[]',
                short_description TEXT DEFAULT '',
                description TEXT DEFAULT '',
                is_in_stock INTEGER DEFAULT 1,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # Índices directos
        conn.execute("CREATE INDEX IF NOT EXISTS idx_products_provider ON products(provider)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_products_price ON products(price)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_products_type ON products(type)")

        # Migración segura de columnas adicionales
        for col, typedef in [("price_neto", "REAL DEFAULT 0.0"), ("iva_rate", "REAL DEFAULT 21.0"), ("iva_amount", "REAL DEFAULT 0.0")]:
            try:
                conn.execute(f"ALTER TABLE products ADD COLUMN {col} {typedef}")
            except sqlite3.OperationalError:
                pass

        # Re-crear tabla virtual FTS5 usando Trigram case_sensitive 0
        conn.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
                provider,
                sku,
                brand,
                name,
                categories_text,
                content='products',
                content_rowid='rowid',
                tokenize='trigram case_sensitive 0'
            )
        """)

        # Triggers de sincronización automática
        conn.execute("DROP TRIGGER IF EXISTS trg_products_insert")
        conn.execute("DROP TRIGGER IF EXISTS trg_products_delete")
        conn.execute("DROP TRIGGER IF EXISTS trg_products_update")

        conn.execute("""
            CREATE TRIGGER trg_products_insert AFTER INSERT ON products BEGIN
                INSERT INTO products_fts(rowid, provider, sku, brand, name, categories_text)
                VALUES (new.rowid, new.provider, new.sku, new.brand, new.name, new.categories_text);
            END;
        """)
        conn.execute("""
            CREATE TRIGGER trg_products_delete AFTER DELETE ON products BEGIN
                INSERT INTO products_fts(products_fts, rowid, provider, sku, brand, name, categories_text)
                VALUES ('delete', old.rowid, old.provider, old.sku, old.brand, old.name, old.categories_text);
            END;
        """)
        conn.execute("""
            CREATE TRIGGER trg_products_update AFTER UPDATE ON products BEGIN
                INSERT INTO products_fts(products_fts, rowid, provider, sku, brand, name, categories_text)
                VALUES ('delete', old.rowid, old.provider, old.sku, old.brand, old.name, old.categories_text);
                INSERT INTO products_fts(rowid, provider, sku, brand, name, categories_text)
                VALUES (new.rowid, new.provider, new.sku, new.brand, new.name, new.categories_text);
            END;
        """)

        # Tablas para carritos / presupuestos guardados
        conn.execute("""
            CREATE TABLE IF NOT EXISTS carts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        """)

        conn.execute("""
            CREATE TABLE IF NOT EXISTS cart_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cart_id INTEGER NOT NULL,
                provider TEXT NOT NULL DEFAULT 'Paternal SRL',
                product_uid TEXT DEFAULT '',
                product_id INTEGER NOT NULL,
                variation_id INTEGER,
                name TEXT NOT NULL,
                variant_label TEXT DEFAULT '',
                sku TEXT DEFAULT '',
                price REAL NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1,
                image_url TEXT DEFAULT '',
                permalink TEXT DEFAULT '',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cart_items_cart ON cart_items(cart_id)")

        # Carrito inicial por defecto
        cur = conn.execute("SELECT COUNT(*) as count FROM carts")
        if cur.fetchone()["count"] == 0:
            conn.execute("INSERT INTO carts (name) VALUES ('Presupuesto Principal')")

def rebuild_fts_index(db_path: str = DB_PATH) -> None:
    conn = get_connection(db_path)
    with conn:
        conn.execute("INSERT INTO products_fts(products_fts) VALUES('rebuild')")

def upsert_products_batch(products_data: List[Dict[str, Any]], db_path: str = DB_PATH) -> int:
    """Inserta o actualiza un lote de productos en SQLite."""
    conn = get_connection(db_path)
    
    # Asegurar campos de precios netos e IVA
    for p in products_data:
        price = float(p.get("price") or 0.0)
        p.setdefault("iva_rate", 21.0)
        iva_rate = float(p.get("iva_rate") or 21.0)
        if "price_neto" not in p or p["price_neto"] is None or p["price_neto"] == 0.0:
            p["price_neto"] = round(price / (1 + iva_rate / 100.0), 2) if price > 0 else 0.0
        if "iva_amount" not in p or p["iva_amount"] is None:
            p["iva_amount"] = round(price - p["price_neto"], 2)

    query = """
        INSERT INTO products (
            uid, provider, id, sku, name, brand, slug, type, price, price_neto, iva_rate, iva_amount,
            regular_price, sale_price,
            price_range_min, price_range_max, permalink, image_url,
            images_json, categories_text, categories_json, attributes_json,
            variations_json, short_description, description, is_in_stock, updated_at
        ) VALUES (
            :uid, :provider, :id, :sku, :name, :brand, :slug, :type, :price, :price_neto, :iva_rate, :iva_amount,
            :regular_price, :sale_price,
            :price_range_min, :price_range_max, :permalink, :image_url,
            :images_json, :categories_text, :categories_json, :attributes_json,
            :variations_json, :short_description, :description, :is_in_stock, CURRENT_TIMESTAMP
        )
        ON CONFLICT(uid) DO UPDATE SET
            sku = excluded.sku,
            name = excluded.name,
            brand = excluded.brand,
            slug = excluded.slug,
            type = excluded.type,
            price = excluded.price,
            price_neto = excluded.price_neto,
            iva_rate = excluded.iva_rate,
            iva_amount = excluded.iva_amount,
            regular_price = excluded.regular_price,
            sale_price = excluded.sale_price,
            price_range_min = excluded.price_range_min,
            price_range_max = excluded.price_range_max,
            permalink = excluded.permalink,
            image_url = excluded.image_url,
            images_json = excluded.images_json,
            categories_text = excluded.categories_text,
            categories_json = excluded.categories_json,
            attributes_json = excluded.attributes_json,
            variations_json = excluded.variations_json,
            short_description = excluded.short_description,
            description = excluded.description,
            is_in_stock = excluded.is_in_stock,
            updated_at = CURRENT_TIMESTAMP
    """
    with conn:
        conn.executemany(query, products_data)
    return len(products_data)

def search_products(query: str = "", provider: str = "", category: str = "", limit: int = 40, offset: int = 0, db_path: str = DB_PATH) -> Dict[str, Any]:
    """Búsqueda multi-proveedor ultra rápida usando Trigram FTS5 con fallback inteligente a LIKE."""
    conn = get_connection(db_path)
    cleaned_q = query.strip()
    
    exact_sku_prods = []
    if cleaned_q:
        # Búsqueda por SKU exacto prioritario
        sku_sql = "SELECT * FROM products WHERE sku = ?"
        sku_params = [cleaned_q]
        if provider:
            sku_sql += " AND provider = ?"
            sku_params.append(provider)
        sku_rows = conn.execute(sku_sql, sku_params).fetchall()
        for r in sku_rows:
            d = dict(r)
            d["images"] = json.loads(d.get("images_json") or "[]")
            d["categories"] = json.loads(d.get("categories_json") or "[]")
            d["attributes"] = json.loads(d.get("attributes_json") or "[]")
            d["variations"] = json.loads(d.get("variations_json") or "[]")
            p_price = float(d.get("price") or 0.0)
            p_iva_rate = float(d.get("iva_rate") or 21.0)
            d["iva_rate"] = p_iva_rate
            if not d.get("price_neto") and p_price > 0:
                d["price_neto"] = round(p_price / (1 + p_iva_rate / 100.0), 2)
            if not d.get("iva_amount") and p_price > 0:
                d["iva_amount"] = round(p_price - d["price_neto"], 2)
            exact_sku_prods.append(d)

        # Separar palabras
        tokens = [re.sub(r'["\'*]', '', t) for t in cleaned_q.split()]
        tokens = [t for t in tokens if t]
        can_use_fts = all(len(t) >= 3 for t in tokens)

        if can_use_fts and tokens:
            # FTS5 Trigram
            fts_match_query = " AND ".join([f'"{t}"' for t in tokens])
            sql = """
                SELECT p.*
                FROM products p
                JOIN products_fts fts ON p.rowid = fts.rowid
                WHERE products_fts MATCH ?
            """
            params = [fts_match_query]
            if provider:
                sql += " AND p.provider = ?"
                params.append(provider)
            if category:
                sql += " AND p.categories_text LIKE ?"
                params.append(f"%{category}%")
            
            count_sql = f"SELECT COUNT(*) FROM ({sql})"
            total = conn.execute(count_sql, params).fetchone()[0]
            
            sql += " ORDER BY p.is_in_stock DESC, p.price ASC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            rows = conn.execute(sql, params).fetchall()
        else:
            # Fallback a LIKE para tokens cortos
            sql = "SELECT p.* FROM products p WHERE 1=1"
            params = []
            for t in tokens:
                sql += " AND (p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ? OR p.categories_text LIKE ?)"
                params.extend([f"%{t}%", f"%{t}%", f"%{t}%", f"%{t}%"])
            if provider:
                sql += " AND p.provider = ?"
                params.append(provider)
            if category:
                sql += " AND p.categories_text LIKE ?"
                params.append(f"%{category}%")
            
            count_sql = f"SELECT COUNT(*) FROM ({sql})"
            total = conn.execute(count_sql, params).fetchone()[0]

            sql += " ORDER BY p.is_in_stock DESC, p.price ASC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            rows = conn.execute(sql, params).fetchall()
    else:
        sql = "SELECT * FROM products WHERE 1=1"
        params = []
        if provider:
            sql += " AND provider = ?"
            params.append(provider)
        if category:
            sql += " AND categories_text LIKE ?"
            params.append(f"%{category}%")
        
        count_sql = f"SELECT COUNT(*) FROM ({sql})"
        total = conn.execute(count_sql, params).fetchone()[0]
        
        sql += " ORDER BY is_in_stock DESC, price ASC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = conn.execute(sql, params).fetchall()

    results = []
    seen_uids = set()
    if cleaned_q and offset == 0 and exact_sku_prods:
        for p in exact_sku_prods:
            results.append(p)
            seen_uids.add(p["uid"])

    for r in rows:
        if r["uid"] in seen_uids:
            continue
        d = dict(r)
        d["images"] = json.loads(d.get("images_json") or "[]")
        d["categories"] = json.loads(d.get("categories_json") or "[]")
        d["attributes"] = json.loads(d.get("attributes_json") or "[]")
        d["variations"] = json.loads(d.get("variations_json") or "[]")
        p_price = float(d.get("price") or 0.0)
        p_iva_rate = float(d.get("iva_rate") or 21.0)
        d["iva_rate"] = p_iva_rate
        if not d.get("price_neto") and p_price > 0:
            d["price_neto"] = round(p_price / (1 + p_iva_rate / 100.0), 2)
        if not d.get("iva_amount") and p_price > 0:
            d["iva_amount"] = round(p_price - d["price_neto"], 2)
        results.append(d)
        seen_uids.add(r["uid"])

    total_count = max(total, len(results))
    return {"total": total_count, "products": results[:limit]}

def get_product_by_uid(uid: str, db_path: str = DB_PATH) -> Optional[Dict[str, Any]]:
    conn = get_connection(db_path)
    row = conn.execute("SELECT * FROM products WHERE uid = ?", (uid,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["images"] = json.loads(d.get("images_json") or "[]")
    d["categories"] = json.loads(d.get("categories_json") or "[]")
    d["attributes"] = json.loads(d.get("attributes_json") or "[]")
    d["variations"] = json.loads(d.get("variations_json") or "[]")
    return d

def get_providers_summary(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    sql = "SELECT provider, COUNT(*) as count FROM products GROUP BY provider ORDER BY count DESC"
    rows = conn.execute(sql).fetchall()
    return [dict(r) for r in rows]

def get_all_categories(provider: str = "", db_path: str = DB_PATH) -> List[str]:
    conn = get_connection(db_path)
    sql = "SELECT categories_text FROM products WHERE categories_text != ''"
    params = []
    if provider:
        sql += " AND provider = ?"
        params.append(provider)
    rows = conn.execute(sql, params).fetchall()
    cats = set()
    for r in rows:
        for c in r["categories_text"].split(" | "):
            c_clean = c.strip()
            if c_clean:
                cats.add(c_clean)
    return sorted(list(cats))

# ----------------- Funciones de Carritos -----------------

def list_carts(db_path: str = DB_PATH) -> List[Dict[str, Any]]:
    conn = get_connection(db_path)
    sql = """
        SELECT c.*, 
               COUNT(i.id) as item_count, 
               COALESCE(SUM(i.price * i.quantity), 0) as total_amount
        FROM carts c
        LEFT JOIN cart_items i ON c.id = i.cart_id
        GROUP BY c.id
        ORDER BY c.updated_at DESC
    """
    rows = conn.execute(sql).fetchall()
    return [dict(r) for r in rows]

def create_cart(name: str, db_path: str = DB_PATH) -> Dict[str, Any]:
    conn = get_connection(db_path)
    with conn:
        cur = conn.execute("INSERT INTO carts (name) VALUES (?)", (name.strip(),))
        cart_id = cur.lastrowid
    return {"id": cart_id, "name": name, "item_count": 0, "total_amount": 0.0}

def delete_cart(cart_id: int, db_path: str = DB_PATH) -> bool:
    conn = get_connection(db_path)
    with conn:
        count = conn.execute("SELECT COUNT(*) FROM carts").fetchone()[0]
        if count <= 1:
            return False
        conn.execute("DELETE FROM carts WHERE id = ?", (cart_id,))
    return True

def rename_cart(cart_id: int, new_name: str, db_path: str = DB_PATH) -> bool:
    conn = get_connection(db_path)
    with conn:
        conn.execute("UPDATE carts SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", (new_name.strip(), cart_id))
    return True

def get_cart_details(cart_id: int, db_path: str = DB_PATH) -> Optional[Dict[str, Any]]:
    conn = get_connection(db_path)
    cart = conn.execute("SELECT * FROM carts WHERE id = ?", (cart_id,)).fetchone()
    if not cart:
        return None
    cart_dict = dict(cart)
    items = conn.execute("""
        SELECT * FROM cart_items WHERE cart_id = ? ORDER BY id DESC
    """, (cart_id,)).fetchall()
    cart_dict["items"] = [dict(i) for i in items]
    cart_dict["total_amount"] = sum(i["price"] * i["quantity"] for i in cart_dict["items"])
    return cart_dict

def add_or_update_cart_item(cart_id: int, item_data: Dict[str, Any], db_path: str = DB_PATH) -> Dict[str, Any]:
    conn = get_connection(db_path)
    product_uid = item_data.get("product_uid") or f"{item_data.get('provider', 'paternal').lower()}_{item_data['product_id']}"
    variation_id = item_data.get("variation_id")
    provider = item_data.get("provider", "Paternal SRL")
    quantity = int(item_data.get("quantity", 1))

    with conn:
        existing = conn.execute("""
            SELECT id, quantity FROM cart_items 
            WHERE cart_id = ? AND product_uid = ? AND (variation_id = ? OR (variation_id IS NULL AND ? IS NULL))
        """, (cart_id, product_uid, variation_id, variation_id)).fetchone()

        if existing:
            new_qty = existing["quantity"] + quantity
            if new_qty <= 0:
                conn.execute("DELETE FROM cart_items WHERE id = ?", (existing["id"],))
            else:
                conn.execute("UPDATE cart_items SET quantity = ? WHERE id = ?", (new_qty, existing["id"]))
        else:
            if quantity > 0:
                conn.execute("""
                    INSERT INTO cart_items (
                        cart_id, provider, product_uid, product_id, variation_id, name, variant_label, 
                        sku, price, quantity, image_url, permalink
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    cart_id,
                    provider,
                    product_uid,
                    item_data["product_id"],
                    variation_id,
                    item_data["name"],
                    item_data.get("variant_label", ""),
                    item_data.get("sku", ""),
                    float(item_data["price"]),
                    quantity,
                    item_data.get("image_url", ""),
                    item_data.get("permalink", "")
                ))
        conn.execute("UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (cart_id,))

    return get_cart_details(cart_id, db_path)

def remove_cart_item(item_id: int, db_path: str = DB_PATH) -> bool:
    conn = get_connection(db_path)
    with conn:
        row = conn.execute("SELECT cart_id FROM cart_items WHERE id = ?", (item_id,)).fetchone()
        if not row:
            return False
        cart_id = row["cart_id"]
        conn.execute("DELETE FROM cart_items WHERE id = ?", (item_id,))
        conn.execute("UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (cart_id,))
    return True

def clear_cart(cart_id: int, db_path: str = DB_PATH) -> bool:
    conn = get_connection(db_path)
    with conn:
        conn.execute("DELETE FROM cart_items WHERE cart_id = ?", (cart_id,))
        conn.execute("UPDATE carts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?", (cart_id,))
    return True

if __name__ == "__main__":
    init_db()
    rebuild_fts_index()
    print("Base de datos multi-proveedor inicializada y sincronizada.")
    print("Resumen de proveedores:", get_providers_summary())
