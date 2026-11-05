# Tarifas y Catálogo Multi-Proveedor
### Paternal SRL, Jalux, Electrocity, Electro Tucumán & Adma Distribuidora

Sistema local y en la nube para scraping, almacenamiento en base de datos ultra rápida (SQLite / Turso con FTS5 Trigram), comparación de precios entre 5 proveedores, autenticación **Better Auth** con cifrado **Zero-Knowledge**, aislamiento de carritos por usuario, scroll infinito y exportación CSV compatible con Excel en Argentina.

---

## 📊 Estado Actual del Catálogo

| Proveedor | Productos | Plataforma | Tipo de Extracción | Insignia |
|---|---|---|---|---|
| **Paternal SRL** | 5.033 | WooCommerce | API REST Store pública JSON | 🔵 Azul |
| **Jalux** | 4.579 | TornadoStore | Concurrente HTML grid (14 hilos) | 🔴 Rojo |
| **Electrocity** | 2.979 | Tiendanube | Inyección de estado JSON en HTML (Node stream) | 🟣 Púrpura |
| **Electro Tucumán** | 2.453 | Symfony / Kodea | Bloque JSON embebido en HTML (`window.data.products`) | 🟠 Ámbar |
| **Adma Distribuidora** | 1.206 | Tiendanube | Inyección de estado JSON en HTML (Node stream) | 🟢 Esmeralda |
| **Total Global** | **16.250** | — | **100% programático (0 tokens consumidos)** | — |

---

## 🚀 Inicio Rápido (TypeScript Server)

### 1. Iniciar la Aplicación
```bash
npm start
```
- Desde tu Mac: **`http://localhost:8000`**
- Desde tu celular (misma Wi-Fi): **`http://192.168.1.57:8000`**

### 2. Ejecutar Pruebas Automatizadas
```bash
npx tsx --test tests/system.test.ts
```
Verifica en menos de 1 segundo los 5 proveedores, búsqueda FTS5, registro con hash seguro, aislamiento de presupuestos y formato de exportación CSV.

---

## 🔐 Seguridad y Autenticación de Usuarios (Better Auth)
- **Zero-Knowledge**: Las contraseñas nunca se guardan en texto plano. Se procesan con hashing criptográfico con sal aleatoria (hash de 161 caracteres en SQLite). Ni el administrador ni nadie con acceso a la base de datos puede ver las contraseñas originales.
- **Aislamiento de Presupuestos**: Cada usuario logueado accede exclusivamente a sus propios carritos y presupuestos.
- **Soporte Invitado**: Los usuarios no autenticados pueden consultar el catálogo, buscar y utilizar presupuestos locales sin necesidad obligatoria de registrarse.

---

## 🔄 Actualización de Precios (Scrapers)
```bash
# Actualizar todos los proveedores
python3 scraper.py --provider all

# Actualizar un proveedor específico
python3 scraper.py --provider adma
python3 scraper.py --provider electrocity
python3 scraper.py --provider paternal
python3 scraper.py --provider tucuman
python3 scraper.py --provider jalux
```

---

## 📁 Arquitectura del Proyecto
- `src/server.ts`: Servidor HTTP en TypeScript con Hono (compatible con Node.js, Cloudflare Workers y Vercel).
- `src/auth.ts`: Configuración de Better Auth con `@libsql/client` y `@libsql/kysely-libsql`.
- `src/db.ts`: Capa de datos con consultas preparadas, búsqueda FTS5 Trigram y gestión de carritos por usuario.
- `web/index.html`: Aplicación web reactiva con Alpine.js, Tailwind CSS y modal de autenticación.
- `tests/system.test.ts`: Suite de pruebas unitarias y de integración end-to-end.
- `paternal.db`: Base de datos SQLite / LibSQL con 16.250 productos, índices FTS5 y tablas de usuarios/sesiones.
- `scraper.py`: Orquestador multihilo para actualizar los 5 catálogos.
