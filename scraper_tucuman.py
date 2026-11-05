#!/usr/bin/env python3
"""
Scraper de Catálogo para Electro Tucumán (electrotucuman.com.ar)
Descarga todo el catálogo de productos (precios, fotos, stock, marcas)
de manera 100% programática y sin gastar tokens.
"""

import sys
import time
import json
import re
import argparse
import requests
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from database import init_db, upsert_products_batch

BASE_URL = "https://electrotucuman.com.ar"
PRODUCTS_URL = f"{BASE_URL}/productos"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"

def parse_tucuman_product(p: Dict[str, Any]) -> Dict[str, Any]:
    prod_id = p["id"]
    raw_imgs = p.get("urls", {}).get("images") or []
    image_urls = [f"{BASE_URL}{img}" if img.startswith("/") else img for img in raw_imgs]
    image_url = image_urls[0] if image_urls else ""
    images_list = [{"src": u} for u in image_urls]

    cat_list = p.get("categoryNamePath") or []
    categories_text = " | ".join(cat_list)
    categories_json = json.dumps([{"name": c} for c in cat_list], ensure_ascii=False)

    brand_name = (p.get("brand") or {}).get("name", "").strip() if p.get("brand") else ""
    sku = (p.get("sku") or p.get("externalId") or "").strip()
    name = (p.get("name") or "").strip()

    price = float(p.get("sellingPrice") or p.get("price") or p.get("minSellingPrice") or 0.0)
    reg_price = float(p.get("price") or price)
    sale_price = float(p.get("discountedPrice") or 0.0)

    p_min = float(p.get("minSellingPrice") or price)
    p_max = float(p.get("maxSellingPrice") or price)

    detail_url = p.get("urls", {}).get("detail", "")
    permalink = f"{BASE_URL}{detail_url}" if detail_url else ""

    stock_val = p.get("stock", 0) or p.get("totalNetStock", 0)
    is_in_stock = 1 if (stock_val > 0 or p.get("availability") == "in stock") else 0

    return {
        "uid": f"tucuman_{prod_id}",
        "provider": "Electro Tucumán",
        "id": prod_id,
        "sku": sku,
        "name": name,
        "brand": brand_name,
        "slug": p.get("slug") or "",
        "type": p.get("dtoType") or "simple",
        "price": price,
        "regular_price": reg_price if reg_price > 0 else price,
        "sale_price": sale_price,
        "price_range_min": p_min,
        "price_range_max": p_max,
        "permalink": permalink,
        "image_url": image_url,
        "images_json": json.dumps(images_list, ensure_ascii=False),
        "categories_text": categories_text,
        "categories_json": categories_json,
        "attributes_json": json.dumps([], ensure_ascii=False),
        "variations_json": json.dumps([], ensure_ascii=False),
        "short_description": p.get("metaDescription") or "",
        "description": p.get("description") or "",
        "is_in_stock": is_in_stock
    }

def fetch_tucuman_page(session: requests.Session, page: int, retries: int = 3) -> Optional[List[Dict[str, Any]]]:
    url = f"{PRODUCTS_URL}?page={page}"
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, timeout=20)
            if r.status_code == 200:
                m = re.search(r'window\.data\.products\s*=\s*Object\.assign\(window\.data\.products,\s*(\{.*?\})\);', r.text, re.DOTALL)
                if m:
                    prods = json.loads(m.group(1))
                    return [parse_tucuman_product(p) for p in prods.values()]
                return []
            else:
                time.sleep(attempt * 1.5)
        except Exception as e:
            if attempt == retries:
                print(f"[!] Error persistente en pág {page} de Electro Tucumán: {e}")
                return None
            time.sleep(attempt * 1.5)
    return None

def run_scraper_tucuman(workers: int = 6, max_pages: Optional[int] = None) -> int:
    init_db()

    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    print("[*] Conectando con Electro Tucumán...")
    r = session.get(f"{PRODUCTS_URL}?page=1", timeout=15)
    if r.status_code != 200:
        print(f"[ERROR] No se pudo conectar a Electro Tucumán. Status: {r.status_code}")
        return 0

    # Extraer total de páginas y resultados
    total_pages = 69
    total_m = re.search(r'(\d+)\s*resultados', r.text, re.IGNORECASE)
    total_items = int(total_m.group(1)) if total_m else 2453

    # Buscar última página en el select
    pages_found = re.findall(r'/productos\?page=(\d+)', r.text)
    if pages_found:
        total_pages = max(int(p) for p in pages_found)

    if max_pages and max_pages < total_pages:
        total_pages = max_pages

    print(f"[+] Total de productos estimados: {total_items}")
    print(f"[+] Páginas a descargar: {total_pages} (con {workers} hilos concurrentes)")

    start_time = time.time()
    total_saved = 0

    # Procesar página 1
    m1 = re.search(r'window\.data\.products\s*=\s*Object\.assign\(window\.data\.products,\s*(\{.*?\})\);', r.text, re.DOTALL)
    if m1:
        p1_data = [parse_tucuman_product(p) for p in json.loads(m1.group(1)).values()]
        upsert_products_batch(p1_data)
        total_saved += len(p1_data)
        print(f" -> Pág 1/{total_pages} guardada ({len(p1_data)} productos)")

    remaining_pages = list(range(2, total_pages + 1))

    if remaining_pages:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_page = {
                executor.submit(fetch_tucuman_page, session, page): page 
                for page in remaining_pages
            }

            for future in as_completed(future_to_page):
                page = future_to_page[future]
                data = future.result()
                if data:
                    upsert_products_batch(data)
                    total_saved += len(data)
                    percent = (total_saved / total_items) * 100 if total_items else 0
                    print(f" -> Pág {page:2d}/{total_pages} guardada (+{len(data)} prods) | Total: {total_saved}/{total_items} ({percent:.1f}%)")
                else:
                    print(f" [!] Advertencia: Pág {page} no devolvió datos.")

    elapsed = time.time() - start_time
    print(f"\n[✓] Extracción de Electro Tucumán finalizada en {elapsed:.2f} segundos.")
    print(f"[✓] Se guardaron exitosamente {total_saved} productos de Electro Tucumán.")
    return total_saved

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scraper de Electro Tucumán")
    parser.add_argument("--workers", type=int, default=6, help="Hilos concurrentes (default: 6)")
    parser.add_argument("--pages", type=int, default=None, help="Límite de páginas a descargar")
    args = parser.parse_args()

    run_scraper_tucuman(workers=args.workers, max_pages=args.pages)
