#!/usr/bin/env python3
"""
Scraper Multi-Proveedor (Paternal SRL y Electro Tucumán)
Permite actualizar individualmente o de forma global los precios y catálogos.
Uso:
    python3 scraper.py --provider all
    python3 scraper.py --provider paternal
    python3 scraper.py --provider tucuman
"""

import sys
import html
import argparse
import time
import requests
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from database import init_db, upsert_products_batch, get_providers_summary
from brand_normalizer import extract_brand_from_product, canon_brand
from scraper_tucuman import run_scraper_tucuman
from scraper_electrocity import run_scraper_electrocity
from scraper_jalux import scrape_jalux
from scraper_adma import run_scraper_adma
from scraper_gallardo import run_scraper_gallardo

PATERNAL_API_URL = "https://paternalsrl.com.ar/wp-json/wc/store/v1/products"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

def parse_price(val: Any, minor_unit: int = 0) -> float:
    if val is None or val == "":
        return 0.0
    try:
        raw = float(val)
        if minor_unit > 0:
            return raw / (10 ** minor_unit)
        return raw
    except (ValueError, TypeError):
        return 0.0

def process_paternal_item(item: Dict[str, Any]) -> Dict[str, Any]:
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

    attributes = item.get("attributes") or []
    variations = item.get("variations") or []
    prod_id = item["id"]

    return {
        "uid": f"paternal_{prod_id}",
        "provider": "Paternal SRL",
        "id": prod_id,
        "sku": (item.get("sku") or "").strip(),
        "name": html.unescape(item.get("name") or "").strip(),
        "brand": extract_brand_from_product(
            item.get("name") or "",
            categories_text,
            item.get("short_description") or "",
            item.get("description") or "",
            "",
        ),
        "slug": item.get("slug") or "",
        "type": item.get("type") or "simple",
        "price": price,
        "regular_price": reg_price if reg_price > 0 else price,
        "sale_price": sale_price,
        "price_range_min": p_min,
        "price_range_max": p_max,
        "permalink": item.get("permalink") or "",
        "image_url": image_url,
        "images_json": json.dumps(images, ensure_ascii=False) if "json" in sys.modules else str(images),
        "categories_text": categories_text,
        "categories_json": json.dumps(categories, ensure_ascii=False) if "json" in sys.modules else "[]",
        "attributes_json": json.dumps(attributes, ensure_ascii=False) if "json" in sys.modules else "[]",
        "variations_json": json.dumps(variations, ensure_ascii=False) if "json" in sys.modules else "[]",
        "short_description": item.get("short_description") or "",
        "description": item.get("description") or "",
        "is_in_stock": 1 if item.get("is_in_stock") else 0
    }

import json

def fetch_paternal_page(session: requests.Session, page: int, per_page: int = 100, retries: int = 3) -> Optional[List[Dict[str, Any]]]:
    url = f"{PATERNAL_API_URL}?per_page={per_page}&page={page}"
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, timeout=20)
            if r.status_code == 200:
                data = r.json()
                return [process_paternal_item(item) for item in data]
            elif r.status_code == 400:
                return []
            else:
                time.sleep(attempt * 1.5)
        except Exception:
            time.sleep(attempt * 1.5)
    return None

def run_scraper_paternal(workers: int = 6, max_pages: Optional[int] = None) -> int:
    init_db()
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    print("[*] Conectando con API de Paternal SRL...")
    head_resp = session.get(f"{PATERNAL_API_URL}?per_page=100&page=1", timeout=15)
    if head_resp.status_code != 200:
        print(f"[ERROR] No se pudo conectar. Status: {head_resp.status_code}")
        return 0

    total_items = int(head_resp.headers.get("X-WP-Total", 0))
    total_pages = int(head_resp.headers.get("X-WP-TotalPages", 0))

    if max_pages and max_pages < total_pages:
        total_pages = max_pages

    print(f"[+] Total detectados en Paternal SRL: {total_items} ({total_pages} páginas)")
    total_saved = 0

    page_1_data = [process_paternal_item(item) for item in head_resp.json()]
    upsert_products_batch(page_1_data)
    total_saved += len(page_1_data)

    remaining_pages = list(range(2, total_pages + 1))
    if remaining_pages:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_page = {executor.submit(fetch_paternal_page, session, page): page for page in remaining_pages}
            for future in as_completed(future_to_page):
                data = future.result()
                if data:
                    upsert_products_batch(data)
                    total_saved += len(data)

    print(f"[✓] Paternal SRL actualizado: {total_saved} productos.")
    return total_saved

def main():
    parser = argparse.ArgumentParser(description="Actualizador Multi-Proveedor")
    parser.add_argument("--provider", type=str, default="all", choices=["all", "paternal", "tucuman", "electrocity", "jalux", "adma", "gallardo"], help="Proveedor a actualizar (default: all)")
    parser.add_argument("--workers", type=int, default=6, help="Hilos concurrentes (default: 6)")
    parser.add_argument("--pages", type=int, default=None, help="Límite de páginas para pruebas")
    args = parser.parse_args()

    start_all = time.time()
    if args.provider in ("all", "paternal"):
        run_scraper_paternal(workers=args.workers, max_pages=args.pages)
    if args.provider in ("all", "tucuman"):
        run_scraper_tucuman(workers=args.workers, max_pages=args.pages)
    if args.provider in ("all", "electrocity"):
        run_scraper_electrocity(workers=min(args.workers, 4), max_pages=args.pages)
    if args.provider in ("all", "jalux"):
        scrape_jalux()
    if args.provider in ("all", "adma"):
        run_scraper_adma(workers=min(args.workers, 4), max_pages=args.pages)
    if args.provider in ("all", "gallardo"):
        run_scraper_gallardo(workers=args.workers, max_pages=args.pages)

    print(f"\n[✓] Sincronización finalizada en {time.time() - start_all:.2f}s.")
    print("Estado actual de la base de datos:")
    for p in get_providers_summary():
        print(f"  • {p['provider']}: {p['count']:,} productos")

if __name__ == "__main__":
    main()
