"""
Scraper concurrente de alto rendimiento para Jalux Materiales Eléctricos (https://www.jalux.com.ar/).
Plataforma: TornadoStore (NetOne / PHP).
100% programático, 0 tokens de IA, ultra rápido (~20-30s para todo el catálogo).
Guarda precio final con IVA como precio principal y preserva precio neto e IVA discriminado.
"""

import time
import re
import json
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import List, Dict, Any
from database import init_db, upsert_products_batch, rebuild_fts_index

BASE_URL = "https://www.jalux.com.ar"

TOP_CATEGORIES = [
    {"slug": "mas-productos--prod--7", "name": "Más productos"},
    {"slug": "cables--prod--10", "name": "Cables"},
    {"slug": "canalizaciones--prod--11", "name": "Canalizaciones"},
    {"slug": "cajas-y-gabinetes--prod--1", "name": "Cajas y gabinetes"},
    {"slug": "llaves-termicas-y-disyuntores--prod--2", "name": "Llaves térmicas y disyuntores"},
    {"slug": "llaves-de-luz--prod--38", "name": "Llaves de luz"},
    {"slug": "lamparas--prod--3", "name": "Lámparas"},
    {"slug": "cintas--prod--4", "name": "Cintas"},
    {"slug": "fichas-y-tomas--prod--5", "name": "Fichas y tomas"},
    {"slug": "zapatillas-y-alargues--prod--9", "name": "Zapatillas y alargues"},
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9",
    "Connection": "keep-alive"
}

def create_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(HEADERS)
    return session

def get_category_page_count(session: requests.Session, cat_info: Dict[str, str]) -> int:
    """Obtiene la cantidad total de páginas para una categoría desde su página 1."""
    url = f"{BASE_URL}/{cat_info['slug']}--view--grilla-0"
    try:
        r = session.get(url, timeout=12)
        if r.status_code == 200:
            m = re.search(r'de\s*(&nbsp;)*\s*(\d+)', r.text)
            if m:
                return int(m.group(2))
    except Exception as e:
        print(f"  [!] Error detectando páginas para {cat_info['slug']}: {e}")
    return 1

def parse_html_page(html: str, category_name: str) -> List[Dict[str, Any]]:
    """Extrae todos los productos de un documento HTML de grilla."""
    prods = html.split('<div class="product">')[1:]
    items = []
    
    for p in prods:
        id_m = re.search(r'--det--([a-zA-Z0-9_\-]+)', p)
        if not id_m:
            continue
        raw_id = id_m.group(1).strip()
        
        # Nombre
        name_m = re.search(r'alt="([^"]+)"', p)
        if not name_m:
            name_m = re.search(r'<a[^>]*class="titprod"[^>]*>([^<]+)</a>', p)
        name = name_m.group(1).strip() if name_m else ''
        if not name:
            continue
            
        # Marca
        brand_m = re.search(r'class="marca_span">([^<]+)<', p)
        brand = brand_m.group(1).strip() if brand_m else ''
        
        # SKU / Código
        sku_m = re.search(r'class="dcorta">([^<]+)<', p)
        art_cod_m = re.search(r'class="[^"]*art_cod_precios[^"]*">([^<]+)<', p)
        sku = ''
        if sku_m and sku_m.group(1).strip() and sku_m.group(1).strip() != '/X MT':
            sku = sku_m.group(1).strip()
        elif art_cod_m:
            sku = art_cod_m.group(1).strip()
        if not sku:
            sku = raw_id
            
        # Precio Neto
        price_m = re.search(r'class="price">\s*<span>\$?\s*([0-9\.,]+)</span>', p)
        price_neto = 0.0
        if price_m:
            val_str = price_m.group(1).replace('.', '').replace(',', '.')
            try:
                price_neto = float(val_str)
            except ValueError:
                pass
                
        # IVA
        iva_m = re.search(r'class="ivaprecio">.*?IVA:\s*</b>\s*([0-9\.,]+)%\s*\|\s*\$?\s*([0-9\.,]+)', p, re.DOTALL)
        iva_rate = 21.0
        iva_amount = 0.0
        if iva_m:
            try:
                iva_rate = float(iva_m.group(1).replace(',', '.'))
            except ValueError:
                pass
            try:
                iva_amount = float(iva_m.group(2).replace('.', '').replace(',', '.'))
            except ValueError:
                pass
        else:
            iva_amount = round(price_neto * (iva_rate / 100.0), 2)
            
        # Precio final para comparación 1 a 1
        price_final = round(price_neto + iva_amount, 2)
        
        # Stock
        is_in_stock = 1 if 'semaf_verde' in p else 0
        
        # Imagen
        img_m = re.search(r'src="(https?://[^"]+|thumb/[^"]+)"', p)
        img_url = ''
        if img_m:
            img_url = img_m.group(1)
            if img_url.startswith('thumb/'):
                img_url = f"{BASE_URL}/{img_url}"
                
        # Link
        link_m = re.search(r'href="([^"]*--det--[^"]*)"', p)
        permalink = ''
        if link_m:
            permalink = link_m.group(1)
            if not permalink.startswith('http'):
                permalink = f"{BASE_URL}/{permalink.lstrip('/')}"
                
        item = {
            "uid": f"jalux_{raw_id}",
            "provider": "Jalux",
            "id": hash(raw_id) % 1000000000,
            "sku": sku,
            "name": name,
            "brand": brand,
            "slug": raw_id.lower(),
            "type": "simple",
            "price": price_final,
            "price_neto": price_neto,
            "iva_rate": iva_rate,
            "iva_amount": iva_amount,
            "regular_price": price_final,
            "sale_price": price_final,
            "price_range_min": price_final,
            "price_range_max": price_final,
            "permalink": permalink,
            "image_url": img_url,
            "images_json": json.dumps([img_url]) if img_url else "[]",
            "categories_text": category_name,
            "categories_json": json.dumps([{"id": 0, "name": category_name, "slug": ""}]),
            "attributes_json": "[]",
            "variations_json": "[]",
            "short_description": f"SKU: {sku} | Marca: {brand}",
            "description": f"<p>{name}</p>",
            "is_in_stock": is_in_stock,
            "_raw_id": raw_id
        }
        items.append(item)
        
    return items

def fetch_page_worker(task: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Trabajador concurrente para descargar y parsear una página."""
    url = task["url"]
    cat_name = task["cat_name"]
    session = task["session"]
    for attempt in range(3):
        try:
            r = session.get(url, timeout=12)
            if r.status_code == 200:
                return parse_html_page(r.text, cat_name)
        except Exception:
            time.sleep(0.5)
    return []

def scrape_jalux() -> int:
    """Descarga todo el catálogo de Jalux Materiales Eléctricos e inserta en paternal.db."""
    start_time = time.time()
    print("🚀 Iniciando extracción de Jalux Materiales Eléctricos (https://www.jalux.com.ar/)...")
    init_db()
    
    session = create_session()
    
    # Paso 1: Detectar conteo exacto de páginas por categoría
    print("📋 Detectando páginas por categoría...")
    tasks = []
    with ThreadPoolExecutor(max_workers=5) as ex:
        futures = {ex.submit(get_category_page_count, session, cat): cat for cat in TOP_CATEGORIES}
        for fut in as_completed(futures):
            cat = futures[fut]
            pages = fut.result()
            print(f"  • {cat['name']:30}: {pages} páginas")
            for page_idx in range(pages):
                offset = page_idx * 60
                url = f"{BASE_URL}/{cat['slug']}--view--grilla-{offset}"
                tasks.append({
                    "url": url,
                    "cat_name": cat["name"],
                    "session": session
                })
                
    total_tasks = len(tasks)
    print(f"\n⚡ Total de páginas a descargar: {total_tasks}. Iniciando descarga concurrente con 14 hilos...")
    
    all_products: Dict[str, Dict[str, Any]] = {}
    completed_pages = 0
    
    with ThreadPoolExecutor(max_workers=14) as ex:
        futures = [ex.submit(fetch_page_worker, t) for t in tasks]
        for fut in as_completed(futures):
            res = fut.result()
            completed_pages += 1
            for p in res:
                uid = p["uid"]
                if uid not in all_products:
                    all_products[uid] = p
                else:
                    # Si ya existe, combinamos categorías si es distinta
                    exist = all_products[uid]
                    if p["categories_text"] and p["categories_text"] not in exist["categories_text"]:
                        exist["categories_text"] += f" | {p['categories_text']}"
                        
            if completed_pages % 25 == 0 or completed_pages == total_tasks:
                print(f"  Progreso: {completed_pages}/{total_tasks} páginas procesadas ({len(all_products)} productos únicos)...")
                
    unique_list = list(all_products.values())
    total_unique = len(unique_list)
    print(f"\n📦 Extracción finalizada: {total_unique} productos únicos extraídos.")
    print("💾 Guardando en base de datos SQLite y reconstruyendo índice FTS5 Trigram...")
    
    # Guardar en lotes de 1000
    batch_size = 1000
    for i in range(0, total_unique, batch_size):
        batch = unique_list[i:i + batch_size]
        upsert_products_batch(batch)
        print(f"  Guardados {min(i + batch_size, total_unique)}/{total_unique}...")
        
    rebuild_fts_index()
    elapsed = time.time() - start_time
    print(f"✅ ¡Catálogo de Jalux sincronizado con éxito! Total: {total_unique} productos en {elapsed:.2f}s.")
    return total_unique

if __name__ == "__main__":
    scrape_jalux()
