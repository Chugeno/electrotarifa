#!/usr/bin/env python3
"""
Cruza automáticamente productos equivalentes entre los 5 proveedores y los guarda en product_links.
Respeta siempre los vínculos manuales (source='manual') y las desvinculaciones manuales (source='unlinked').
"""
import sqlite3
import re
import html
from collections import defaultdict

GENERIC_BRANDS = {"", "VARIOS", "GENERICO", "GENÉRICO", "IMPORTADO", "NORMALIZADO", "SIN MARCA"}
NUMERIC_CODE_BRANDS = {"CAMBRE", "JELUZ", "KALOP", "CONEXTUBE", "ROKER", "ZOLODA"}
MEASURE_RE = re.compile(
    r"^\d+([.,]\d+)?(MM2?|CM|MTS?|M|W|KW|V|KV|VCA|VCC|A|MA|KA|K|HZ|KHZ|MHZ|L|ML|GR|KG|P|POLOS|CH|CANALES|BOCAS|MOD|MODULOS|UN|U|X\d+.*|/\d+.*)$"
)
STOP_CODES = {
    "2020", "2021", "2022", "2023", "2024", "2025", "2026",
    "1000", "2000", "3000", "4000", "5000", "6000", "6500", "2700",
    "220V", "380V", "IP20", "IP40", "IP44", "IP54", "IP55", "IP65", "IP66", "IP67", "IP68",
    "IRAM", "ROHS", "WIFI", "SMART", "GU10", "MR16",
}


def is_valid_mfg_code(s: str, brand: str) -> bool:
    if len(s) < 4 or len(s) > 22:
        return False
    if MEASURE_RE.match(s):
        return False
    if re.match(r"^01[A-Z0-9]{3}\d{5}$", s):
        return False
    if s in STOP_CODES:
        return False
    has_letter = bool(re.search(r"[A-Z]", s))
    has_digit = bool(re.search(r"\d", s))
    if has_letter and has_digit:
        return True
    if s.isdigit() and brand in NUMERIC_CODE_BRANDS and 4 <= len(s) <= 8:
        return True
    return False


def run_auto_link(db_path: str = "paternal.db") -> int:
    conn = sqlite3.connect(db_path)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS product_links (
            uid TEXT PRIMARY KEY,
            group_key TEXT NOT NULL,
            source TEXT DEFAULT 'auto',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_product_links_group ON product_links(group_key)")

    # Conservar decisiones manuales del administrador ('manual' y 'unlinked')
    protected = {
        r[0]: (r[1], r[2])
        for r in conn.execute("SELECT uid, group_key, source FROM product_links WHERE source IN ('manual', 'unlinked')").fetchall()
    }
    conn.execute("DELETE FROM product_links WHERE source = 'auto'")

    rows = conn.execute(
        "SELECT uid, provider, sku, brand, name, price, short_description, description FROM products"
    ).fetchall()

    valid_codes_by_brand = defaultdict(set)
    for uid, prov, sku, brand, name, price, sdesc, desc in rows:
        if brand in GENERIC_BRANDS:
            continue
        if prov in ("Jalux", "Adma Distribuidora", "Electro Tucumán", "Elec. Gallardo") and sku:
            s = sku.strip().upper()
            if is_valid_mfg_code(s, brand):
                valid_codes_by_brand[brand].add(s)
        clean_desc = re.sub(r"<[^>]+>", " ", html.unescape((sdesc or "") + " " + (desc or "")))[:220]
        for m in re.finditer(r"\b(?:El|La|modelo|código|codigo)\s+([A-Z0-9][A-Z0-9/-]{3,20})\b", clean_desc):
            cand = m.group(1).upper().strip("-/.")
            if is_valid_mfg_code(cand, brand):
                valid_codes_by_brand[brand].add(cand)

    matches = defaultdict(list)
    for uid, prov, sku, brand, name, price, sdesc, desc in rows:
        if uid in protected:
            continue
        if brand not in valid_codes_by_brand:
            continue
        codes = valid_codes_by_brand[brand]
        sku_up = (sku or "").strip().upper()
        found_code = None
        if prov in ("Jalux", "Adma Distribuidora", "Electro Tucumán", "Elec. Gallardo") and sku_up in codes:
            found_code = sku_up
        if not found_code:
            clean_desc = re.sub(r"<[^>]+>", " ", html.unescape((sdesc or "") + " " + (desc or "")))
            tokens = set(re.findall(r"[A-Z0-9][A-Z0-9/.-]{2,}[A-Z0-9]", f"{name} {clean_desc}".upper()))
            common = tokens & codes
            if len(common) == 1:
                found_code = next(iter(common))
        if found_code:
            matches[f"{brand}::{found_code}"].append((prov, uid))

    # Regla especial para Teclas Smart Macroled Roma (Electrocity agrupa las variantes en 1 producto y Adma/Paternal por canal)
    for color, code in [("BLANCO", "MACROLED::ROMA-S-1CH-B"), ("NEGRO", "MACROLED::ROMA-S-1CH-N")]:
        city_row = conn.execute(
            "SELECT uid FROM products WHERE provider='Electrocity' AND brand='MACROLED' AND name LIKE ? AND name LIKE '%Roma%'",
            (f"%{color[:4]}%",),
        ).fetchone()
        if city_row and city_row[0] not in protected:
            if not any(u == city_row[0] for _, u in matches[code]):
                matches[code].append(("Electrocity", city_row[0]))

    to_insert = []
    for group_key, items in matches.items():
        provs = [p for p, _ in items]
        if len(set(provs)) >= 2 and len(provs) == len(set(provs)):
            for _, uid in items:
                to_insert.append((uid, group_key, "auto"))

    conn.executemany(
        "INSERT OR REPLACE INTO product_links (uid, group_key, source, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)",
        to_insert,
    )
    conn.commit()
    conn.close()
    print(f"[auto_link] {len(to_insert)} productos vinculados en {len({x[1] for x in to_insert})} grupos multi-proveedor.")
    return len(to_insert)


if __name__ == "__main__":
    run_auto_link()
