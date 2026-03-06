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

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim();
}

function getXmlTagValue(block, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>(?:<!\\[CDATA\\[(.*?)\\]\\]>|([^<]*))<\/${tag}>`
  );
  const match = block.match(re);
  return match ? String(match[1] || match[2] || "").trim() : "";
}

function getXmlLanguageValue(block, tag) {
  const re = new RegExp(
    `<${tag}[^>]*>[\\s\\S]*?<language[^>]*>(?:<!\\[CDATA\\[(.*?)\\]\\]>|([^<]*))<\\/language>[\\s\\S]*?<\\/${tag}>`
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
      const attributeIds = [
        ...block.matchAll(
          /<product_option_value>[\s\S]*?<id[^>]*>(?:<!\[CDATA\[(\d+)\]\]>|(\d+))<\/id>[\s\S]*?<\/product_option_value>/g
        ),
      ].map((m) => Number(m[1] || m[2] || 0));

      return {
        id,
        id_product: idProduct,
        reference,
        price_impact: Number.isFinite(priceImpact) ? priceImpact : 0,
        attribute_ids: [...new Set(attributeIds.filter(Boolean))],
      };
    })
    .filter((c) => c.id);
}

function extractOptionValueNamesFromXml(xml) {
  const blocks = [
    ...xml.matchAll(/<product_option_value>[\s\S]*?<\/product_option_value>/g),
  ].map((m) => m[0]);

  return blocks
    .map((block) => {
      const id = Number(getXmlTagValue(block, "id") || 0);
      const name = getXmlLanguageValue(block, "name");
      const idAttributeGroup = Number(
        getXmlTagValue(block, "id_attribute_group") || 0
      );
      return id
        ? { id, name: name || null, id_attribute_group: idAttributeGroup || 0 }
        : null;
    })
    .filter(Boolean);
}

function extractOptionGroupNamesFromXml(xml) {
  const blocks = [
    ...xml.matchAll(/<product_option>[\s\S]*?<\/product_option>/g),
  ].map((m) => m[0]);

  return blocks
    .map((block) => {
      const id = Number(getXmlTagValue(block, "id") || 0);
      const name = getXmlLanguageValue(block, "name");
      return id ? { id, name: name || null } : null;
    })
    .filter(Boolean);
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
    const variant = String(req.query.variant || "").trim().toLowerCase();
    const variantTokens = variant.split(/\s+/).filter(Boolean);
    const attrsRaw = String(req.query.attrs || "").trim();
    const attrs = attrsRaw
      ? attrsRaw.split(",").map((pair) => pair.split("=").map((s) => s.trim()))
      : [];
    const attrFilters = attrs
      .filter((pair) => pair.length === 2 && pair[0] && pair[1])
      .map(([key, value]) => ({
        key: normalizeText(key),
        value: normalizeText(value),
      }));

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

    const attributeIds = [
      ...new Set(combinations.flatMap((combo) => combo.attribute_ids || [])),
    ];
    const attributeNames = new Map();
    const attributeGroups = new Map();
    const attributeGroupByValueId = new Map();

    if (attributeIds.length) {
      const chunkSize = 50;
      for (let i = 0; i < attributeIds.length; i += chunkSize) {
        const chunk = attributeIds.slice(i, i + chunkSize);
        const valuesXml = await psGet(
          `/api/product_option_values?filter[id]=[${chunk.join("|")}]&display=[id,name]&limit=200`
        );
        const values = extractOptionValueNamesFromXml(valuesXml);
        const groupIds = new Set();

        values.forEach((value) => {
          attributeNames.set(value.id, value.name);
          if (value.id_attribute_group) {
            attributeGroupByValueId.set(value.id, value.id_attribute_group);
            groupIds.add(value.id_attribute_group);
          }
        });

        if (groupIds.size) {
          const groupXml = await psGet(
            `/api/product_options?filter[id]=[${[...groupIds].join("|")}]&display=[id,name]&limit=200`
          );
          const groups = extractOptionGroupNamesFromXml(groupXml);
          groups.forEach((group) => {
            attributeGroups.set(group.id, group.name);
          });
        }
      }
    }

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
      const attributes = (combo.attribute_ids || []).map((id) => {
        const name = attributeNames.get(id) || null;
        const groupId = attributeGroupByValueId.get(id) || null;
        const group = groupId ? attributeGroups.get(groupId) || null : null;
        return {
          id,
          name,
          group,
        };
      });
      return {
        ...combo,
        quantity,
        available: quantity > 0,
        attributes,
      };
    });

    const filteredCombinations = combinationsWithStock.filter((combo) => {
      if (variantTokens.length) {
        const ref = String(combo.reference || "");
        const attrNames = combo.attributes
          .map((attr) => String(attr.name || ""))
          .join(" ");
        const haystack = normalizeText(`${ref} ${attrNames}`);
        if (!variantTokens.every((token) => haystack.includes(normalizeText(token)))) {
          return false;
        }
      }

      if (attrFilters.length) {
        const attrMap = new Map();
        combo.attributes.forEach((attr) => {
          const group = normalizeText(attr.group || "");
          const name = normalizeText(attr.name || "");
          if (group) {
            attrMap.set(group, name);
          }
        });

        const ok = attrFilters.every((filter) =>
          attrMap.get(filter.key)?.includes(filter.value)
        );

        if (!ok) return false;
      }

      return true;
    });

    const hasVariantFilter = variantTokens.length > 0;
    const hasAttrFilter = attrFilters.length > 0;
    const hasFilters = hasVariantFilter || hasAttrFilter;

    const filteredTotalQty = filteredCombinations.length
      ? filteredCombinations.reduce((sum, combo) => sum + combo.quantity, 0)
      : 0;

    const responseCombinations = hasFilters
      ? filteredCombinations
      : combinationsWithStock;
    const responseTotalQty = hasFilters ? filteredTotalQty : totalQty;
    const responseAvailable = responseTotalQty > 0;

    return res.json({
      ok: true,
      found: true,
      query,
      product,
      totalQty: responseTotalQty,
      available: responseAvailable,
      hasCombinations: combinationsWithStock.length > 0,
      combinations: responseCombinations,
      filteredTotalQty: hasFilters ? filteredTotalQty : undefined,
      variant: hasVariantFilter ? variant : undefined,
      attrs: hasAttrFilter ? attrsRaw : undefined,
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