import { test, describe, before } from "node:test";
import assert from "node:assert";
import { client } from "../src/auth.js";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:8000";

describe("⚡ Suite de Pruebas: Sistema Multi-Proveedor con TypeScript & Better Auth", () => {

  test("1. Estado del Catálogo y los 5 Proveedores", async () => {
    const res = await fetch(`${BASE_URL}/api/providers`);
    assert.strictEqual(res.status, 200, "API providers debe responder 200");
    const providers = await res.json();
    assert.strictEqual(providers.length, 5, "Deben existir exactamente 5 proveedores");

    const names = providers.map((p: any) => p.provider);
    assert.ok(names.includes("Paternal SRL"), "Paternal SRL debe estar presente");
    assert.ok(names.includes("Jalux"), "Jalux debe estar presente");
    assert.ok(names.includes("Electrocity"), "Electrocity debe estar presente");
    assert.ok(names.includes("Electro Tucumán"), "Electro Tucumán debe estar presente");
    assert.ok(names.includes("Adma Distribuidora"), "Adma Distribuidora debe estar presente");

    const totalCount = providers.reduce((acc: number, p: any) => acc + p.count, 0);
    assert.strictEqual(totalCount, 16250, "El total global debe ser 16.250 productos");
    console.log(`  ✓ Verificado: 5 proveedores con un total de ${totalCount.toLocaleString('es-AR')} productos.`);
  });

  test("2. Búsqueda FTS5 Trigram y Doble Precio (Final e IVA)", async () => {
    const res = await fetch(`${BASE_URL}/api/search?q=termica+16&limit=5`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.total > 0, "Debe encontrar coincidencias");
    assert.ok(data.products.length > 0);

    const first = data.products[0];
    assert.ok(first.price > 0, "Debe tener precio final");
    assert.ok(first.price_neto > 0, "Debe tener precio neto calculado");
    assert.ok(first.iva_rate >= 10.5, "Debe tener alícuota de IVA");
    assert.ok(first.iva_amount > 0, "Debe tener monto de IVA");

    console.log(`  ✓ Búsqueda exitosa: ${data.total} resultados. Ejemplo: "${first.name}" ($ ${first.price} | Neto: $ ${first.price_neto})`);
  });

  test("3. Filtro por Proveedor (Adma y Jalux)", async () => {
    const resAdma = await fetch(`${BASE_URL}/api/search?q=jeluz&provider=Adma+Distribuidora`);
    const dataAdma = await resAdma.json();
    assert.ok(dataAdma.products.every((p: any) => p.provider === "Adma Distribuidora"), "Todos los resultados deben ser de Adma");

    const resJalux = await fetch(`${BASE_URL}/api/search?q=siemens&provider=Jalux`);
    const dataJalux = await resJalux.json();
    assert.ok(dataJalux.products.every((p: any) => p.provider === "Jalux"), "Todos los resultados deben ser de Jalux");

    console.log(`  ✓ Filtro por proveedor verificado: Adma (${dataAdma.total}) y Jalux (${dataJalux.total})`);
  });

  test("4. Autenticación Segura (Zero-Knowledge) con Better Auth", async () => {
    const testEmail = `usuario_prueba_${Date.now()}@test.com`;
    const testPassword = "MiPasswordSeguro2026!";

    // Registro
    const regRes = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
      body: JSON.stringify({
        name: "Usuario Tester",
        email: testEmail,
        password: testPassword,
      }),
    });
    assert.strictEqual(regRes.status, 200, "Registro debe responder 200 OK");
    const regData = await regRes.json();
    assert.ok(regData.user.id, "Debe devolver id de usuario");

    // Verificar en SQLite que la contraseña NO está en texto plano
    const accountRes = await client.execute({
      sql: "SELECT password FROM account WHERE userId = ?",
      args: [regData.user.id],
    });
    const hash = String(accountRes.rows[0]?.password || "");

    assert.notStrictEqual(hash, testPassword, "La contraseña jamás debe estar en texto plano");
    assert.ok(hash.length > 50, "Debe ser un hash criptográfico largo con sal");
    assert.ok(!hash.includes(testPassword), "El hash no debe contener la contraseña");
    console.log(`  ✓ Cifrado Zero-Knowledge verificado: Hash de ${hash.length} caracteres.`);

    // Login fallido con password erróneo
    const failRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
      body: JSON.stringify({ email: testEmail, password: "password_falsa" }),
    });
    assert.strictEqual(failRes.status, 401, "Password incorrecto debe rebotar con 401");

    // Login exitoso
    const loginRes = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
      body: JSON.stringify({ email: testEmail, password: testPassword }),
    });
    assert.strictEqual(loginRes.status, 200, "Password correcto debe ingresar con 200 OK");
    const cookieHeader = loginRes.headers.get("set-cookie");
    assert.ok(cookieHeader && cookieHeader.includes("better-auth.session_token"), "Debe setear cookie de sesión");
    console.log("  ✓ Flujo de autenticación completo (registro, hash seguro, login inválido y válido).");
  });

  test("5. Aislamiento Estricto de Carritos por Usuario", async () => {
    // Usuario 1
    const email1 = `user1_${Date.now()}@test.com`;
    const reg1 = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
      body: JSON.stringify({ name: "User 1", email: email1, password: "password123!" }),
    });
    const cookie1 = reg1.headers.get("set-cookie")?.split(";")[0] || "";

    // Usuario 2
    const email2 = `user2_${Date.now()}@test.com`;
    const reg2 = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Origin": BASE_URL },
      body: JSON.stringify({ name: "User 2", email: email2, password: "password123!" }),
    });
    const cookie2 = reg2.headers.get("set-cookie")?.split(";")[0] || "";

    // User 1 crea Carrito Alfa
    const c1Res = await fetch(`${BASE_URL}/api/carts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie1 },
      body: JSON.stringify({ name: "Carrito Exclusivo de User 1" }),
    });
    const cart1 = await c1Res.json();

    // User 2 crea Carrito Beta
    const c2Res = await fetch(`${BASE_URL}/api/carts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Cookie": cookie2 },
      body: JSON.stringify({ name: "Carrito Exclusivo de User 2" }),
    });
    const cart2 = await c2Res.json();

    // User 1 lista sus carritos
    const list1Res = await fetch(`${BASE_URL}/api/carts`, { headers: { "Cookie": cookie1 } });
    const list1 = await list1Res.json();
    const ids1 = list1.map((c: any) => c.id);
    assert.ok(ids1.includes(cart1.id), "User 1 debe ver su carrito");
    assert.ok(!ids1.includes(cart2.id), "User 1 NO debe ver el carrito de User 2");

    // User 2 lista sus carritos
    const list2Res = await fetch(`${BASE_URL}/api/carts`, { headers: { "Cookie": cookie2 } });
    const list2 = await list2Res.json();
    const ids2 = list2.map((c: any) => c.id);
    assert.ok(ids2.includes(cart2.id), "User 2 debe ver su carrito");
    assert.ok(!ids2.includes(cart1.id), "User 2 NO debe ver el carrito de User 1");

    // Usuario no autenticado (invitado)
    const listGuestRes = await fetch(`${BASE_URL}/api/carts`);
    const listGuest = await listGuestRes.json();
    const idsGuest = listGuest.map((c: any) => c.id);
    assert.ok(!idsGuest.includes(cart1.id), "Invitado NO debe ver el carrito de User 1");
    assert.ok(!idsGuest.includes(cart2.id), "Invitado NO debe ver el carrito de User 2");

    console.log("  ✓ Aislamiento de presupuestos verificado: cada usuario solo ve sus propios presupuestos.");
  });

  test("6. Integridad Absoluta del Carrito 'Vero'", async () => {
    const res = await fetch(`${BASE_URL}/api/carts/4`);
    assert.strictEqual(res.status, 200, "Carrito Vero (ID 4) debe existir");
    const veroCart = await res.json();
    assert.strictEqual(veroCart.name, "Vero", "El nombre debe ser Vero");
    assert.strictEqual(veroCart.items.length, 19, "Debe tener 19 artículos intactos");
    assert.strictEqual(veroCart.total_amount, 1260415, "El total debe ser exactamente $ 1.260.415,00");
    console.log(`  ✓ Carrito 'Vero' verificado: 19 ítems, total $ ${veroCart.total_amount.toLocaleString('es-AR')}.`);
  });

  test("7. Exportación a CSV con Formato Regional Argentino", async () => {
    const res = await fetch(`${BASE_URL}/api/carts/4/export`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();

    assert.ok(text.includes("Proveedor;SKU;Producto;Variante;Precio Unitario;Cantidad;Subtotal;Link"), "Debe tener cabeceras separadas por ';'");
    assert.ok(text.includes("259517,00"), "Los decimales deben usar coma ','");
    assert.ok(!text.includes("259517.00"), "No debe usar punto decimal en los números");
    console.log("  ✓ Exportación CSV verificada con separador ';' y decimales con coma ','.");
  });

  test("8. Servidor Web Frontend (HTML)", async () => {
    const res = await fetch(`${BASE_URL}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes("paternalApp"), "Debe servir la SPA con Alpine.js");
    assert.ok(html.includes("authModalOpen"), "Debe contener el modal de autenticación");
    assert.ok(html.includes("currentUser"), "Debe soportar el estado de usuario");
    console.log("  ✓ Frontend HTML servido correctamente.");
  });

});
