import express from "express";

const app = express();

const PORT = Number(process.env.PORT || 3005);

// PrestaShop interno por red Docker
const PRESTASHOP_URL =
  process.env.PRESTASHOP_URL || "https://tienda.bg3d.com.ar";
  




// API key del Webservice
const PRESTASHOP_WS_KEY = process.env.PRESTASHOP_WS_KEY;

if (!PRESTASHOP_WS_KEY) {
  console.error("Missing PRESTASHOP_WS_KEY");
}

function basicAuthHeader(key) {
  const token = Buffer.from(`${key}:`, "utf8").toString("base64");
  return `Basic ${token}`;
}

async function psGet(path) {
  const base = PRESTASHOP_URL.replace(/\/$/, "");
  const url = `${base}${path}`;

  const response = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(PRESTASHOP_WS_KEY),
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`PrestaShop ${response.status}: ${text.slice(0, 500)}`);
  }

  return text;
}

function extractIdsFromProductsXml(xml) {
  const matches = [
    ...xml.matchAll(/<id><!\[CDATA\[(\d+)\]\]><\/id>/g),
    ...xml.matchAll(/<id>(\d+)<\/id>/g),
  ];

  return matches.map((m) => m[1]).filter(Boolean);
}

function extractQuantitiesFromStockXml(xml) {
  return [...xml.matchAll(/<quantity>(-?\d+)<\/quantity>/g)].map((m) =>
    Number(m[1])
  );
}

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/prestashop-test", async (_req, res) => {
  try {
    const xml = await psGet("/api/products?display=[id,name]&limit=1");
    res.status(200).type("application/xml").send(xml);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/stock", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: "query required",
      });
    }

    // Buscar productos por nombre
    const productsXml = await psGet(
      `/api/products?filter[name]=%25${encodeURIComponent(
        query
      )}%25&display=[id,name]&limit=5`
    );

    const ids = extractIdsFromProductsXml(productsXml);

    if (!ids.length) {
      return res.json({
        ok: true,
        found: false,
        query,
        matches: [],
      });
    }

    // Tomamos el primer producto encontrado
    const idProduct = ids[0];

    // Buscar stock para ese producto
    const stockXml = await psGet(
      `/api/stock_availables?filter[id_product]=[${idProduct}]&display=[id,id_product,id_product_attribute,quantity]&limit=50`
    );

    const quantities = extractQuantitiesFromStockXml(stockXml);
    const totalQty = quantities.length
      ? quantities.reduce((sum, qty) => sum + qty, 0)
      : 0;

    return res.json({
      ok: true,
      found: true,
      query,
      idProduct: Number(idProduct),
      totalQty,
      available: totalQty > 0,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: String(error.message || error),
    });
  }
});

app.listen(PORT, () => {
  console.log(`bg3d backend listening on port ${PORT}`);
});