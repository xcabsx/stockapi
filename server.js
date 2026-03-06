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

function getXmlTagValue(block, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[(.*?)\\]\\]>|([^<]*))<\/${tag}>`
  );
  const match = block.match(re);
  return match ? String(match[1] || match[2] || "").trim() : "";
}

function extractCombinationsFromXml(xml) {
  const blocks = [...xml.matchAll(/<combination>[\s\S]*?<\/combination>/g)].map(
    (m) => m[0]
  );

  return blocks
    .map((block) => {
      const id = Number(getXmlTagValue(block, "id") || 0);
      const idProduct = Number(getXmlTagValue(block, "id_product") || 0);
      const reference = getXmlTagValue(block, "reference") || null;
      const priceImpactRaw = getXmlTagValue(block, "price");
      const priceImpact = priceImpactRaw ? Number(priceImpactRaw) : 0;

      return {
        id,
        id_product: idProduct,
        reference,
        price_impact: Number.isFinite(priceImpact) ? priceImpact : 0,
      };
    })
    .filter((c) => c.id);
}

function extractStockEntriesFromXml(xml) {
  const blocks = [...xml.matchAll(/<stock_available>[\s\S]*?<\/stock_available>/g)].map(
    (m) => m[0]
  );

  return blocks
    .map((block) => {
      const idProductAttribute = Number(
        getXmlTagValue(block, "id_product_attribute") || 0
      );
      const quantityRaw = getXmlTagValue(block, "quantity");
      const quantity = quantityRaw ? Number(quantityRaw) : 0;
      const idProduct = Number(getXmlTagValue(block, "id_product") || 0);

      return {
        id_product: idProduct,
        id_product_attribute: idProductAttribute,
        quantity: Number.isFinite(quantity) ? quantity : 0,
      };
    })
    .filter((entry) => entry.id_product || entry.id_product_attribute);
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
    if (!PRESTASHOP_WS_KEY) {
      return res.status(500).json({
        ok: false,
        error: "PRESTASHOP_WS_KEY not configured",
      });
    }

    const query = String(req.query.query || "").trim().toLowerCase();
    const tokens = query.split(/\s+/).filter(Boolean);

    if (!query) {
      return res.status(400).json({
        ok: false,
        error: "query required",
      });
    }

    const PAGE_SIZE = 100;
    const MAX_PAGES = 10;
    const matches = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const offset = page * PAGE_SIZE;
      const productsXml = await psGet(
        `/api/products?display=[id,name]&limit=${offset},${PAGE_SIZE}`
      );

      const productMatches = [
        ...productsXml.matchAll(
          /<product>[\s\S]*?<id><!\[CDATA\[(\d+)\]\]><\/id>[\s\S]*?<name><language[^>]*>(?:<!\[CDATA\[(.*?)\]\]>|([^<]*))<\/language><\/name>[\s\S]*?<\/product>/g
        ),
      ].map((m) => ({
        id: Number(m[1]),
        name: String(m[2] || m[3] || "").trim(),
      }));

      const pageMatches = productMatches.filter((p) => {
        const name = p.name.toLowerCase();
        if (!tokens.length) return false;
        return tokens.every((token) => name.includes(token));
      });

      matches.push(...pageMatches);

      if (productMatches.length < PAGE_SIZE) {
        break;
      }
    }

    if (!matches.length) {
      return res.json({
        ok: true,
        found: false,
        query,
        matches: [],
      });
    }

    const exactMatch = matches.find((p) => {
      const name = p.name.trim().toLowerCase();
      return name === query;
    });
    const product = exactMatch || matches[0];

    const combinationsXml = await psGet(
      `/api/combinations?filter[id_product]=[${product.id}]&display=[id,id_product,reference,price]&limit=200`
    );

    const combinations = extractCombinationsFromXml(combinationsXml);

    const stockXml = await psGet(
      `/api/stock_availables?filter[id_product]=[${product.id}]&display=[id,id_product,id_product_attribute,quantity]&limit=200`
    );

    const stockEntries = extractStockEntriesFromXml(stockXml);
    const stockByAttribute = new Map(
      stockEntries.map((entry) => [entry.id_product_attribute, entry.quantity])
    );

    const totalQty = stockEntries.length
      ? stockEntries.reduce((sum, entry) => sum + entry.quantity, 0)
      : 0;

    const combinationsWithStock = combinations.map((combo) => {
      const quantity = stockByAttribute.get(combo.id) ?? 0;
      return {
        ...combo,
        quantity,
        available: quantity > 0,
      };
    });

    return res.json({
      ok: true,
      found: true,
      query,
      product,
      totalQty,
      available: totalQty > 0,
      hasCombinations: combinationsWithStock.length > 0,
      combinations: combinationsWithStock,
      matches,
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