#!/usr/bin/env python3
"""
Scraper de Catálogo para Electrocity (electrocity.com.ar)
Plataforma: Tiendanube (Nuvemshop).
Descarga de manera 100% programática y estructurada mediante el bloque JS
incrustado en cada página de catálogo (30 páginas de 100 productos c/u).
"""

import sys
import time
import json
import argparse
import subprocess
import requests
from typing import List, Dict, Any, Optional
from concurrent.futures import ThreadPoolExecutor, as_completed

from database import init_db, upsert_products_batch

BASE_URL = "https://electrocity.com.ar"
PRODUCTS_URL = f"{BASE_URL}/productos/"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9,en;q=0.8",
    "Sec-Ch-Ua": '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"macOS"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1"
}

NODE_EVAL_SCRIPT = '''
let code = "";
process.stdin.on("data", c => code += c);
process.stdin.on("end", () => {
    try {
        const arr = eval(code);
        console.log(JSON.stringify(arr));
    } catch(e) {
        console.log("[]");
    }
});
'''

def extract_products_js(html: str) -> List[Dict[str, Any]]:
    """Extrae y parsea el array de productos de Tiendanube usando node."""
    idx = html.find('products: [')
    if idx == -1:
        return []
    start = idx + len('products: ')
    bracket_count = 0
    end = -1
    for i in range(start, len(html)):
        if html[i] == '[':
            bracket_count += 1
        elif html[i] == ']':
            bracket_count -= 1
            if bracket_count == 0:
                end = i + 1
                break
    if end == -1:
        return []

    js_array = html[start:end]
    p = subprocess.run(['node', '-e', NODE_EVAL_SCRIPT], input=js_array, text=True, capture_output=True)
    if p.returncode == 0 and p.stdout.strip():
        try:
            return json.loads(p.stdout)
        except json.JSONDecodeError:
            return []
    return []

def parse_electrocity_product(p: Dict[str, Any]) -> Dict[str, Any]:
    prod_id = p["id"]
    name_obj = p.get("name") or {}
    name = name_obj.get("es", "") if isinstance(name_obj, dict) else str(name_obj)
    brand = (p.get("brand") or "").strip()

    # Variantes y precios
    variants = p.get("variants") or []
    prices = [float(v.get("price") or 0.0) for v in variants if float(v.get("price") or 0.0) > 0]
    min_p = min(prices) if prices else 0.0
    max_p = max(prices) if prices else 0.0
    
    first_var = variants[0] if variants else {}
    price = min_p if min_p > 0 else float(first_var.get("price") or 0.0)
    sku = (first_var.get("sku") or "").strip()

    # Imágenes
    raw_imgs = p.get("images") or []
    image_urls = []
    for img in raw_imgs:
        src = img.get("src", "")
        if src.startswith("//"):
            src = "https:" + src
        if src:
            image_urls.append(src)
    image_url = image_urls[0] if image_urls else ""
    images_list = [{"src": u} for u in image_urls]

    # Categorías
    cats = p.get("categories") or []
    cat_names = [c.get("name", "").strip() for c in cats if isinstance(c, dict) and c.get("name")]
    categories_text = " | ".join(cat_names)

    # Permalink
    canonical = p.get("canonical_url")
    if not canonical:
        handle_obj = p.get("handle") or {}
        handle = handle_obj.get("es", "") if isinstance(handle_obj, dict) else ""
        canonical = f"{BASE_URL}/productos/{handle}/" if handle else ""

    # Stock
    has_stock = any(int(v.get("stock") or 0) > 0 for v in variants) if variants else True

    # Descripciones
    desc_obj = p.get("description") or {}
    desc = desc_obj.get("es", "") if isinstance(desc_obj, dict) else ""
    seo_obj = p.get("seo_description") or {}
    short_desc = seo_obj.get("es", "") if isinstance(seo_obj, dict) else ""

    return {
        "uid": f"city_{prod_id}",
        "provider": "Electrocity",
        "id": prod_id,
        "sku": sku,
        "name": name,
        "brand": brand,
        "slug": p.get("handle", {}).get("es", "") if isinstance(p.get("handle"), dict) else "",
        "type": "variable" if len(variants) > 1 else "simple",
        "price": price,
        "regular_price": max_p if max_p > 0 else price,
        "sale_price": min_p if min_p < max_p else 0.0,
        "price_range_min": min_p,
        "price_range_max": max_p,
        "permalink": canonical,
        "image_url": image_url,
        "images_json": json.dumps(images_list, ensure_ascii=False),
        "categories_text": categories_text,
        "categories_json": json.dumps(cats, ensure_ascii=False),
        "attributes_json": json.dumps([], ensure_ascii=False),
        "variations_json": json.dumps(variants, ensure_ascii=False),
        "short_description": short_desc,
        "description": desc,
        "is_in_stock": 1 if has_stock else 0
    }

def fetch_electrocity_page(session: requests.Session, page: int, retries: int = 3) -> Optional[List[Dict[str, Any]]]:
    url = f"{PRODUCTS_URL}?page={page}&limit=100"
    for attempt in range(1, retries + 1):
        try:
            r = session.get(url, timeout=25)
            if r.status_code == 200:
                raw_items = extract_products_js(r.text)
                return [parse_electrocity_product(item) for item in raw_items]
            else:
                time.sleep(attempt * 2.0)
        except Exception as e:
            if attempt == retries:
                print(f"[!] Error persistente en pág {page} de Electrocity: {e}")
                return None
            time.sleep(attempt * 2.0)
    return None

def run_scraper_electrocity(workers: int = 4, max_pages: Optional[int] = None) -> int:
    init_db()
    session = requests.Session()
    session.headers.update(HEADERS)

    print("[*] Conectando con Electrocity (Tiendanube)...")
    r = session.get(f"{PRODUCTS_URL}?page=1&limit=100", timeout=20)
    if r.status_code != 200:
        print(f"[ERROR] No se pudo conectar a Electrocity. Status: {r.status_code}")
        return 0

    total_pages = 30
    if max_pages and max_pages < total_pages:
        total_pages = max_pages

    print(f"[+] Total estimado: ~2.978 productos ({total_pages} páginas de hasta 100 items c/u)")
    print(f"[+] Descargando con {workers} hilos concurrentes...")

    start_time = time.time()
    total_saved = 0

    # Procesar página 1
    p1_items = [parse_electrocity_product(p) for p in extract_products_js(r.text)]
    if p1_items:
        upsert_products_batch(p1_items)
        total_saved += len(p1_items)
        print(f" -> Pág 1/{total_pages} guardada ({len(p1_items)} productos)")

    remaining_pages = list(range(2, total_pages + 1))
    if remaining_pages:
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_page = {
                executor.submit(fetch_electrocity_page, session, page): page 
                for page in remaining_pages
            }

            for future in as_completed(future_to_page):
                page = future_to_page[future]
                data = future.result()
                if data:
                    upsert_products_batch(data)
                    total_saved += len(data)
                    print(f" -> Pág {page:2d}/{total_pages} guardada (+{len(data)} prods) | Total guardado: {total_saved}")
                else:
                    print(f" [!] Pág {page} finalizada (sin más productos o vacía).")

    elapsed = time.time() - start_time
    print(f"\n[✓] Extracción de Electrocity finalizada en {elapsed:.2f} segundos.")
    print(f"[✓] Se guardaron exitosamente {total_saved} productos de Electrocity.")
    return total_saved

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scraper de Electrocity")
    parser.add_argument("--workers", type=int, default=4, help="Hilos concurrentes (default: 4)")
    parser.add_argument("--pages", type=int, default=None, help="Límite de páginas a descargar")
    args = parser.parse_args()

    run_scraper_electrocity(workers=args.workers, max_pages=args.pages)
