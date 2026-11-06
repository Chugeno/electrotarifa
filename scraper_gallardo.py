#!/usr/bin/env python3
"""
Scraper para Elec. Gallardo (https://egallardo.com.ar/tienda/)
Utiliza la API pública de WooCommerce Store v1 (/wp-json/wc/store/v1/products).
"""
import html
import json
import time
import requests
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from database import init_db, upsert_products_batch
from brand_normalizer import extract_brand_from_product, canon_brand

GALLARDO_API_URL = "https://egallardo.com.ar/wp-json/wc/store/v1/products"
PROVIDER_NAME = "Elec. Gallardo"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"


def parse_price(val: Any, minor_unit: int = 0) -> float:
    if val is None or val == "":
        return 0.0
    try:
        raw = float(val)
        if minor_unit > 0:
            return round(raw / (10 ** minor_unit), 2)
        return round(raw, 2)
    except (ValueError, TypeError):
        return 0.0


def process_gallardo_item(item: Dict[str, Any]) -> Dict[str, Any]:
    prices = item.get("prices") or {}
    minor_unit = int(prices.get("currency_minor_unit") or 0)

    price = parse_price(prices.get("price"), minor_unit)
    reg_price = parse_price(prices.get("regular_price"), minor_unit)
    sale_price = parse_price(prices.get("sale_price"), minor_unit)

    price_range = prices.get("price_range")
    p_min = parse_price(price_range.get("min_amount"), minor_unit) if price_range else None
    p_max = parse_price(price_range.get("max_amount"), minor_unit) if price_range else None

    images = item.get("images") or []
    image_url = images[0].get("src", "") if images else ""

    categories = item.get("categories") or []
    cat_names = [html.unescape(c.get("name", "")).strip() for c in categories if c.get("name")]
    categories_text = " | ".join(cat_names)

    brands_arr = item.get("brands") or []
    raw_brand = ""
    if brands_arr and isinstance(brands_arr, list):
        raw_brand = html.unescape(brands_arr[0].get("name") or "").strip()

    name = html.unescape(item.get("name") or "").strip()
    short_desc = item.get("short_description") or ""
    desc = item.get("description") or ""

    brand = extract_brand_from_product(name, categories_text, short_desc, desc, raw_brand)
    if not brand and raw_brand:
        brand = canon_brand(raw_brand)

    attributes = item.get("attributes") or []
    variations = item.get("variations") or []
    prod_id = item["id"]

    iva_rate = 21.0
    price_neto = round(price / (1 + iva_rate / 100), 2) if price > 0 else 0.0
    iva_amount = round(price - price_neto, 2) if price > 0 else 0.0

    return {
        "uid": f"gallardo_{prod_id}",
        "provider": PROVIDER_NAME,
        "id": prod_id,
        "sku": (item.get("sku") or "").strip(),
        "name": name,
        "brand": brand,
        "slug": item.get("slug") or "",
        "type": item.get("type") or "simple",
        "price": price,
        "price_neto": price_neto,
        "iva_rate": iva_rate,
        "iva_amount": iva_amount,
        "regular_price": reg_price if reg_price > 0 else price,
        "sale_price": sale_price,
        "price_range_min": p_min,
        "price_range_max": p_max,
        "permalink": item.get("permalink") or "",
        "image_url": image_url,
        "images_json": json.dumps(images, ensure_ascii=False),
        "categories_text": categories_text,
        "categories_json": json.dumps(categories, ensure_ascii=False),
        "attributes_json": json.dumps(attributes, ensure_ascii=False),
        "variations_json": json.dumps(variations, ensure_ascii=False),
        "short_description": short_desc,
        "description": desc,
        "is_in_stock": 1 if item.get("is_in_stock") else 0,
    }


def fetch_gallardo_page(session: requests.Session, page: int, per_page: int = 100, retries: int = 3) -> Optional[List[Dict[str, Any]]]:
    url = f"{GALLARDO_API_URL}?per_page={per_page}&page={page}"
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, timeout=25)
            if r.status_code == 200:
                data = r.json()
                return [process_gallardo_item(item) for item in data]
            elif r.status_code == 400:
                return []
            else:
                time.sleep(attempt * 1.5)
        except Exception:
            time.sleep(attempt * 1.5)
    return None


def run_scraper_gallardo(workers: int = 6, max_pages: Optional[int] = None) -> int:
    init_db()
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    print(f"[*] Conectando con API de {PROVIDER_NAME}...")
    head_resp = session.get(f"{GALLARDO_API_URL}?per_page=100&page=1", timeout=20)
    if head_resp.status_code != 200:
        print(f"[ERROR] No se pudo conectar con {PROVIDER_NAME}. Status: {head_resp.status_code}")
        return 0

    total_items = int(head_resp.headers.get("X-WP-Total", 0))
    total_pages = int(head_resp.headers.get("X-WP-TotalPages", 0))

    if max_pages and max_pages < total_pages:
        total_pages = max_pages

    print(f"[+] Total detectados en {PROVIDER_NAME}: {total_items} ({total_pages} páginas)")
    total_saved = 0

    page_1_data = [process_gallardo_item(item) for item in head_resp.json()]
    upsert_products_batch(page_1_data)
    total_saved += len(page_1_data)

    remaining_pages = list(range(2, total_pages + 1))
    if remaining_pages:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_page = {executor.submit(fetch_gallardo_page, session, page): page for page in remaining_pages}
            for future in as_completed(future_to_page):
                data = future.result()
                if data:
                    upsert_products_batch(data)
                    total_saved += len(data)

    print(f"[✓] {PROVIDER_NAME} actualizado: {total_saved} productos.")
    return total_saved


if __name__ == "__main__":
    run_scraper_gallardo()
