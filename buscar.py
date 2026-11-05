#!/usr/bin/env python3
"""
CLI de Búsqueda Rápida Multi-Proveedor (Paternal SRL y Electro Tucumán)
Uso:
    python3 buscar.py "cable 4mm"
    python3 buscar.py "termica 16" --provider tucuman
    python3 buscar.py --sku 2368
"""

import sys
import argparse
from database import search_products, get_providers_summary

def format_price(val):
    if not val:
        return "$ 0"
    return f"$ {val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

def main():
    parser = argparse.ArgumentParser(description="Buscador local multi-proveedor")
    parser.add_argument("query", nargs="?", default="", help="Texto de búsqueda (nombre, sku, marca)")
    parser.add_argument("--sku", type=str, default="", help="Buscar por SKU")
    parser.add_argument("--provider", type=str, default="", help="Filtrar por proveedor (ej. 'paternal', 'tucuman')")
    parser.add_argument("--category", type=str, default="", help="Filtrar por categoría")
    parser.add_argument("--limit", type=int, default=15, help="Cantidad máxima de resultados (default: 15)")
    args = parser.parse_args()

    q = args.sku if args.sku else args.query
    if not q and not args.provider:
        parser.print_help()
        print("\nResumen actual de catálogo local:")
        for p in get_providers_summary():
            print(f"  • {p['provider']}: {p['count']:,} productos")
        return

    provider_filter = ""
    if args.provider:
        prov_low = args.provider.lower()
        if "paternal" in prov_low:
            provider_filter = "Paternal SRL"
        elif "tucuman" in prov_low or "electro t" in prov_low:
            provider_filter = "Electro Tucumán"
        elif "city" in prov_low or "electrocity" in prov_low:
            provider_filter = "Electrocity"
        elif "jalux" in prov_low:
            provider_filter = "Jalux"
        elif "adma" in prov_low:
            provider_filter = "Adma Distribuidora"
        else:
            provider_filter = args.provider

    filter_desc = f" [{provider_filter}]" if provider_filter else " [Todos los proveedores]"
    print(f"\n[*] Buscando: '{q}'{filter_desc} ...")
    res = search_products(query=q, provider=provider_filter, category=args.category, limit=args.limit)

    total = res["total"]
    products = res["products"]

    print(f"[+] Total de coincidencias: {total} (mostrando {len(products)})\n")

    if not products:
        print("[-] No se encontraron productos.")
        return

    for idx, p in enumerate(products, 1):
        stock_str = "✓ En Stock" if p["is_in_stock"] else "✗ Sin Stock"
        prov_tag = f"[{p['provider']}]"
        brand_str = f" | Marca: {p['brand']}" if p.get("brand") else ""
        neto_info = f" (Neto: {format_price(p.get('price_neto'))} + IVA {p.get('iva_rate', 21)}%)" if p.get("price_neto") else ""
        print(f"{idx:2d}. {prov_tag} {p['name']}")
        print(f"    SKU: {p['sku'] or 'N/A'}{brand_str} | Stock: {stock_str}")
        print(f"    Precio Final: {format_price(p['price'])}{neto_info} | Cat: {p['categories_text'].split(' | ')[0] if p['categories_text'] else 'N/A'}")
        if p.get("image_url"):
            print(f"    Foto: {p['image_url']}")
        print(f"    Link: {p['permalink']}")
        print("-" * 65)

if __name__ == "__main__":
    main()
