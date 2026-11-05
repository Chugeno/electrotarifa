#!/usr/bin/env python3
"""
Servidor Web Local y API Multi-Proveedor (Paternal SRL y Electro Tucumán).
Usa únicamente la biblioteca estándar de Python (http.server + sqlite3).
"""

import os
import sys
import json
import urllib.parse
from http.server import HTTPServer, BaseHTTPRequestHandler
import database

PORT = 8000
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

class RequestHandler(BaseHTTPRequestHandler):
    def _send_json(self, data: any, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, file_path: str, content_type: str = "text/html; charset=utf-8"):
        if not os.path.exists(file_path):
            self.send_error(404, "File not found")
            return
        with open(file_path, "rb") as f:
            content = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # Static UI
        if path == "/" or path == "/index.html":
            index_path = os.path.join(WEB_DIR, "index.html")
            return self._send_file(index_path, "text/html; charset=utf-8")

        # API: Search
        if path == "/api/search":
            q = query.get("q", [""])[0]
            provider = query.get("provider", [""])[0]
            category = query.get("category", [""])[0]
            limit = int(query.get("limit", [40])[0])
            page = int(query.get("page", [1])[0])
            offset = (page - 1) * limit
            res = database.search_products(query=q, provider=provider, category=category, limit=limit, offset=offset)
            res["page"] = page
            res["limit"] = limit
            return self._send_json(res)

        # API: Providers summary
        if path == "/api/providers":
            summary = database.get_providers_summary()
            return self._send_json(summary)

        # API: Categories
        if path == "/api/categories":
            provider = query.get("provider", [""])[0]
            cats = database.get_all_categories(provider=provider)
            return self._send_json(cats)

        # API: Product Detail /api/product/{uid}
        if path.startswith("/api/product/"):
            uid = path.split("/")[-1]
            product = database.get_product_by_uid(uid)
            if product:
                return self._send_json(product)
            return self._send_json({"error": "Producto no encontrado"}, status=404)

        # API: Carts list
        if path == "/api/carts":
            carts = database.list_carts()
            return self._send_json(carts)

        # API: Specific Cart details /api/carts/{id}
        if path.startswith("/api/carts/"):
            parts = path.strip("/").split("/")
            if len(parts) == 3:
                try:
                    cart_id = int(parts[2])
                    cart = database.get_cart_details(cart_id)
                    if cart:
                        return self._send_json(cart)
                    return self._send_json({"error": "Carrito no encontrado"}, status=404)
                except ValueError:
                    return self._send_json({"error": "ID inválido"}, status=400)

            # Export cart CSV /api/carts/{id}/export
            if len(parts) == 4 and parts[3] == "export":
                try:
                    cart_id = int(parts[2])
                    cart = database.get_cart_details(cart_id)
                    if not cart:
                        return self._send_json({"error": "Carrito no encontrado"}, status=404)
                    
                    # Separador ';' estándar en español para permitir coma ',' en decimales
                    csv_lines = ["Proveedor;SKU;Producto;Variante;Precio Unitario;Cantidad;Subtotal;Link"]
                    for item in cart.get("items", []):
                        subtotal = item["price"] * item["quantity"]
                        prov = item.get("provider", "Paternal SRL").replace('"', '""')
                        name = item["name"].replace('"', '""')
                        var_label = (item.get("variant_label") or "").replace('"', '""')
                        price_str = f"{item['price']:.2f}".replace(".", ",")
                        subtotal_str = f"{subtotal:.2f}".replace(".", ",")
                        csv_lines.append(f'"{prov}";"{item["sku"]}";"{name}";"{var_label}";{price_str};{item["quantity"]};{subtotal_str};"{item.get("permalink","")}"')
                    
                    csv_content = "\r\n".join(csv_lines).encode("utf-8-sig")
                    self.send_response(200)
                    self.send_header("Content-Type", "text/csv; charset=utf-8")
                    self.send_header("Content-Disposition", f'attachment; filename="presupuesto_{cart_id}.csv"')
                    self.send_header("Content-Length", str(len(csv_content)))
                    self.end_headers()
                    self.wfile.write(csv_content)
                    return
                except Exception as e:
                    return self._send_json({"error": str(e)}, status=500)

        self.send_error(404, "Endpoint not found")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {}

        # Crear carrito /api/carts
        if path == "/api/carts":
            name = payload.get("name", "").strip() or "Nuevo Presupuesto"
            cart = database.create_cart(name)
            return self._send_json(cart, status=201)

        # Agregar ítem al carrito /api/carts/{id}/items
        if path.startswith("/api/carts/") and path.endswith("/items"):
            parts = path.strip("/").split("/")
            try:
                cart_id = int(parts[2])
                updated_cart = database.add_or_update_cart_item(cart_id, payload)
                return self._send_json(updated_cart)
            except Exception as e:
                return self._send_json({"error": str(e)}, status=400)

        # Vaciar carrito /api/carts/{id}/clear
        if path.startswith("/api/carts/") and path.endswith("/clear"):
            parts = path.strip("/").split("/")
            try:
                cart_id = int(parts[2])
                database.clear_cart(cart_id)
                cart = database.get_cart_details(cart_id)
                return self._send_json(cart)
            except Exception as e:
                return self._send_json({"error": str(e)}, status=400)

        self.send_error(404, "Endpoint not found")

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
        try:
            payload = json.loads(body)
        except json.JSONDecodeError:
            payload = {}

        # Renombrar carrito /api/carts/{id}
        if path.startswith("/api/carts/"):
            parts = path.strip("/").split("/")
            try:
                cart_id = int(parts[2])
                new_name = payload.get("name", "").strip()
                if new_name:
                    database.rename_cart(cart_id, new_name)
                    return self._send_json({"success": True, "name": new_name})
                return self._send_json({"error": "Nombre requerido"}, status=400)
            except Exception as e:
                return self._send_json({"error": str(e)}, status=400)

        self.send_error(404, "Endpoint not found")

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        parts = path.strip("/").split("/")

        # Eliminar ítem /api/carts/items/{item_id}
        if len(parts) == 4 and parts[0] == "api" and parts[1] == "carts" and parts[2] == "items":
            try:
                item_id = int(parts[3])
                ok = database.remove_cart_item(item_id)
                return self._send_json({"success": ok})
            except Exception as e:
                return self._send_json({"error": str(e)}, status=400)

        # Eliminar carrito /api/carts/{id}
        if len(parts) == 3 and parts[0] == "api" and parts[1] == "carts":
            try:
                cart_id = int(parts[2])
                ok = database.delete_cart(cart_id)
                if ok:
                    return self._send_json({"success": True})
                return self._send_json({"error": "No se puede eliminar el único carrito existente"}, status=400)
            except Exception as e:
                return self._send_json({"error": str(e)}, status=400)

        self.send_error(404, "Endpoint not found")

    def log_message(self, format, *args):
        if "GET /api/" in (args[0] if args else ""):
            return
        super().log_message(format, *args)

def run_server(port: int = PORT):
    database.init_db()
    server_address = ("", port)
    httpd = HTTPServer(server_address, RequestHandler)
    print(f"\n=======================================================")
    print(f"🚀 Servidor Multi-Proveedor iniciado con éxito!")
    print(f"👉 Abre en tu navegador: http://localhost:{port}")
    print(f"=======================================================\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Servidor local multi-proveedor")
    parser.add_argument("--port", type=int, default=PORT, help=f"Puerto HTTP (default: {PORT})")
    args = parser.parse_args()
    run_server(port=args.port)
