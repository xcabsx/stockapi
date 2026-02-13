import express from "express";

const app = express();

const PRESTASHOP_URL = process.env.PRESTASHOP_URL; // ej https://tienda.bg3d.com.ar
const WS_KEY = process.env.PRESTASHOP_WS_KEY;      // tu key
const PORT = Number(process.env.PORT || 3005);

if (!PRESTASHOP_URL || !WS_KEY) {
  console.error("Missing PRESTASHOP_URL or PRESTASHOP_WS_KEY");
}

function basicAuthHeader(key) {
  // PrestaShop Webservice usa Basic Auth: username = KEY, password vacío
  const token = Buffer.from(`${key}:`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function psGet(path) {
  const url = `${PRESTASHOP_URL.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    headers: { Authorization: basicAuthHeader(WS_KEY) }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PrestaShop ${res.status}: ${text.slice(0, 300)}`);
  }
  return text;
}

function parseQtyFromXml(xml) {
  // busca <quantity>123</quantity>
  const m = xml.match(/<quantity>(-?\d+)<\/quantity>/);
  return m ? Number(m[1]) : null;
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/stock", async (req, res) => {
  try {
    const q = String(req.query.query || "").trim();
    if (!q) return res.status(400).json({ error: "query required" });

    // 1) Buscar producto por nombre (simple y práctico para la prueba)
    // output_format=JSON a veces funciona según config; si no, cae a XML.
    // Vamos a pedir XML y parsear ID.
    const productsXml = await psGet(
      `/api/products?filter[name]=%25${encodeURIComponent(q)}%25&display=[id,name]&limit=5`
    );

    const ids = [...productsXml.matchAll(/<id><!\[CDATA\[(\d+)\]\]><\/id>|<id>(\d+)<\/id>/g)]
      .map(m => m[1] || m[2])
      .filter(Boolean);

    if (!ids.length) {
      return res.json({ found: false, query: q, matches: [] });
    }

    // 2) Tomar el primer match y consultar stock_availables
    // En PrestaShop, el stock suele estar en stock_availables filtrando por id_product
    const idProduct = ids[0];
    const stockXml = await psGet(
      `/api/stock_availables?filter[id_product]=[${idProduct}]&display=[id,quantity,id_product_attribute]&limit=50`
    );

    // Si hay combinaciones, devuelve varias filas (id_product_attribute != 0).
    // Sumamos quantities.
    const qtyMatches = [...stockXml.matchAll(/<quantity>(-?\d+)<\/quantity>/g)].map(m => Number(m[1]));
    const total = qtyMatches.length ? qtyMatches.reduce((a,b)=>a+b,0) : null;

    return res.json({
      found: true,
      query: q,
      idProduct: Number(idProduct),
      totalQty: total ?? 0
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => {
  console.log(`stock-api listening on ${PORT}`);
});
