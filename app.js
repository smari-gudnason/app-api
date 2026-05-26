require("dotenv").config();
const { Pool } = require("pg");

// ---------- ENV ----------
const DATABASE_URL = process.env.DATABASE_URL;
const DK_ENDPOINT = process.env.DKPLUS_ENDPOINT || process.env.DK_URL;
const DK_TOKEN = process.env.DKPLUS_TOKEN || process.env.DK_TOKEN;

if (!DATABASE_URL || !DK_ENDPOINT || !DK_TOKEN) {
  console.log("❌ Vantar DATABASE_URL eða DKPLUS_ENDPOINT/DKPLUS_TOKEN í .env");
  process.exit(1);
}

// ---------- DB ----------
const pool = new Pool({ connectionString: DATABASE_URL });

// ---------- Helpers ----------
const norm = (v) => (v ?? "").toString().trim();

function toNumberOrNull(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}
function toInt(v, fallback = 0) {
  const n = toNumberOrNull(v);
  return n === null ? fallback : Math.trunc(n);
}
function asBool(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === "string") return v.trim().toLowerCase() === "true";
  return false;
}
function isInactive(item) {
  return asBool(item?.Inactive ?? item?.inactive);
}
function showInWebshop(item) {
  // Þið hafið skilgreint að sýna/ekki sýna í netverslun ráði birtingu 
  return asBool(item?.ShowItemInWebShop ?? item?.showItemInWebShop ?? item?.showiteminwebshop);
}

function getWarehouseQty(item, code) {
  const list = item?.Warehouses ?? item?.warehouses;
  if (!Array.isArray(list)) return 0;
  const target = code.toLowerCase();
  const row = list.find(w => norm(w?.Warehouse ?? w?.warehouse).toLowerCase() === target);
  return toInt(row?.QuantityInStock ?? row?.quantityInStock, 0);
}

// DK skilar stundum Publication; stundum top-level. Við styðjum bæði.
function getPub(item) {
  return item?.Publication || item?.publication || null;
}
function pickAuthor(item) {
  const pub = getPub(item);
  return norm(pub?.Author ?? pub?.author ?? item?.Author ?? item?.author);
}
function pickISBN(item) {
  const pub = getPub(item);
  return norm(pub?.ISBN ?? pub?.isbn ?? item?.ISBN ?? item?.isbn);
}
function pickPublisher(item) {
  const pub = getPub(item);
  return norm(pub?.Publisher ?? pub?.publisher ?? item?.Publisher ?? item?.publisher);
}
function pickAlias(item) {
  return norm(item?.AliasItemCode ?? item?.aliasitemcode);
}
function pickDescription(item) {
  return norm(item?.Description ?? item?.description);
}
function pickDescription2(item) {
  return norm(item?.Description2 ?? item?.description2);
}

// ---------- HTTP ----------
async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${DK_TOKEN}`,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }

  if (!res.ok) {
    throw new Error(`DK error ${res.status}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
  }
  return json;
}

async function fetchAllProducts() {
  const json = await fetchJson(DK_ENDPOINT);
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.items)) return json.items;
  throw new Error("Óvænt response format frá DK (ekki listi).");
}

// ---------- Batch helpers ----------
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------- Ensure schema (idempotent) ----------
async function ensureSchema(client) {
  // columns on size_variant (safe add)
  await client.query(`
    ALTER TABLE size_variant
      ADD COLUMN IF NOT EXISTS discount_percent NUMERIC,
      ADD COLUMN IF NOT EXISTS stock_bg1 INTEGER,
      ADD COLUMN IF NOT EXISTS stock_bg5 INTEGER,
      ADD COLUMN IF NOT EXISTS stock_bg6 INTEGER,
      ADD COLUMN IF NOT EXISTS stock_selected INTEGER,
      ADD COLUMN IF NOT EXISTS stock_total_all INTEGER;
  `);

  // barcode table (SKU-level)
  await client.query(`
    CREATE TABLE IF NOT EXISTS sku_barcode (
      barcode TEXT PRIMARY KEY,
      sku TEXT NOT NULL,
      is_extra BOOLEAN DEFAULT FALSE,
      modified_at TIMESTAMPTZ NULL
    );
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ix_sku_barcode_sku ON sku_barcode(sku);`);

  // helpful unique indexes
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_style_parent_sku ON style_product(parent_sku);`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_size_variant_sku ON size_variant(sku);`);

  // dedupe + unique for color_variant
  await client.query(`
    WITH d AS (
      SELECT style_product_id, color, MIN(id) AS keep_id, ARRAY_AGG(id) AS all_ids
      FROM color_variant
      GROUP BY style_product_id, color
      HAVING COUNT(*) > 1
    ),
    moved AS (
      UPDATE size_variant sv
      SET color_variant_id = d.keep_id
      FROM d
      WHERE sv.color_variant_id = ANY(d.all_ids)
        AND sv.color_variant_id <> d.keep_id
      RETURNING sv.id
    )
    DELETE FROM color_variant cv
    USING d
    WHERE cv.id = ANY(d.all_ids)
      AND cv.id <> d.keep_id;
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_color_variant_style_color
    ON color_variant(style_product_id, color);
  `);
}

// ---------- Upserts ----------
async function upsertStylesBatch(client, rows) {
  if (!rows.length) return new Map();

  const parentSkuArr = rows.map(r => r.parentSku);
  const styleCodeArr = rows.map(r => r.styleCode);
  const brandArr     = rows.map(r => r.brand);
  const nameArr      = rows.map(r => r.name);

  const q = `
    WITH s AS (
      SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[])
      AS t(parent_sku, style_code, brand, name)
    ),
    up AS (
      INSERT INTO style_product (parent_sku, style_code, brand, name, active, updated_at)
      SELECT parent_sku, style_code, brand, name, true, NOW()
      FROM s
      ON CONFLICT (parent_sku)
      DO UPDATE SET
        style_code = EXCLUDED.style_code,
        brand = EXCLUDED.brand,
        name = EXCLUDED.name,
        active = true,
        updated_at = NOW()
      RETURNING id, parent_sku
    )
    SELECT id, parent_sku FROM up;
  `;

  const res = await client.query(q, [parentSkuArr, styleCodeArr, brandArr, nameArr]);
  const map = new Map();
  for (const r of res.rows) map.set(r.parent_sku, r.id);
  return map;
}

async function upsertColorsBatch(client, rows) {
  if (!rows.length) return new Map();

  const styleIdArr = rows.map(r => r.styleId);
  const colorArr   = rows.map(r => r.color);

  const q = `
    WITH c AS (
      SELECT * FROM UNNEST($1::int[], $2::text[])
      AS t(style_product_id, color)
    ),
    up AS (
      INSERT INTO color_variant (style_product_id, color)
      SELECT style_product_id, color FROM c
      ON CONFLICT (style_product_id, color)
      DO UPDATE SET color = EXCLUDED.color
      RETURNING id, style_product_id, color
    )
    SELECT id, style_product_id, color FROM up;
  `;

  const res = await client.query(q, [styleIdArr, colorArr]);
  const map = new Map();
  for (const r of res.rows) map.set(`${r.style_product_id}|${r.color}`, r.id);
  return map;
}

async function upsertSizeVariantsBatch(client, rows) {
  if (!rows.length) return;

  const colorIdArr = rows.map(r => r.colorId);
  const sizeArr    = rows.map(r => r.size);
  const skuArr     = rows.map(r => r.sku);

  const priceArr   = rows.map(r => r.price);
  const discArr    = rows.map(r => r.discountPercent);

  const bg1Arr     = rows.map(r => r.stockBg1);
  const bg5Arr     = rows.map(r => r.stockBg5);
  const bg6Arr     = rows.map(r => r.stockBg6);
  const selArr     = rows.map(r => r.stockSelected);
  const totArr     = rows.map(r => r.stockTotalAll);

  const q = `
    WITH v AS (
      SELECT * FROM UNNEST(
        $1::int[], $2::text[], $3::text[],
        $4::numeric[], $5::numeric[],
        $6::int[], $7::int[], $8::int[], $9::int[], $10::int[]
      )
      AS t(color_variant_id, size, sku,
           price, discount_percent,
           stock_bg1, stock_bg5, stock_bg6, stock_selected, stock_total_all)
    )
    INSERT INTO size_variant
      (color_variant_id, size, sku,
       price, discount_percent,
       stock_bg1, stock_bg5, stock_bg6, stock_selected, stock_total_all,
       active)
    SELECT
      color_variant_id, size, sku,
      price, discount_percent,
      stock_bg1, stock_bg5, stock_bg6, stock_selected, stock_total_all,
      true
    FROM v
    ON CONFLICT (sku)
    DO UPDATE SET
      color_variant_id = EXCLUDED.color_variant_id,
      size = EXCLUDED.size,
      price = EXCLUDED.price,
      discount_percent = EXCLUDED.discount_percent,
      stock_bg1 = EXCLUDED.stock_bg1,
      stock_bg5 = EXCLUDED.stock_bg5,
      stock_bg6 = EXCLUDED.stock_bg6,
      stock_selected = EXCLUDED.stock_selected,
      stock_total_all = EXCLUDED.stock_total_all,
      active = true;
  `;

  await client.query(q, [
    colorIdArr, sizeArr, skuArr,
    priceArr, discArr,
    bg1Arr, bg5Arr, bg6Arr, selArr, totArr
  ]);
}

async function upsertBarcodesBatch(client, rows) {
  if (!rows.length) return;

  const barcodeArr = rows.map(r => r.barcode);
  const skuArr     = rows.map(r => r.sku);
  const extraArr   = rows.map(r => r.isExtra);
  const modArr     = rows.map(r => r.modifiedAt);

  const q = `
    WITH b AS (
      SELECT * FROM UNNEST($1::text[], $2::text[], $3::bool[], $4::timestamptz[])
      AS t(barcode, sku, is_extra, modified_at)
    )
    INSERT INTO sku_barcode (barcode, sku, is_extra, modified_at)
    SELECT barcode, sku, is_extra, modified_at FROM b
    ON CONFLICT (barcode)
    DO UPDATE SET
      sku = EXCLUDED.sku,
      is_extra = EXCLUDED.is_extra,
      modified_at = EXCLUDED.modified_at;
  `;
  await client.query(q, [barcodeArr, skuArr, extraArr, modArr]);
}

async function cleanupOrphans(client) {
  await client.query(`
    UPDATE style_product sp
    SET active = false, updated_at = NOW()
    WHERE NOT EXISTS (
      SELECT 1
      FROM color_variant cv
      JOIN size_variant sv ON sv.color_variant_id = cv.id
      WHERE cv.style_product_id = sp.id AND sv.active = true
    );
  `);

  await client.query(`
    DELETE FROM color_variant cv
    WHERE NOT EXISTS (SELECT 1 FROM size_variant sv WHERE sv.color_variant_id = cv.id);
  `);
}

// ---------- Main ----------
async function runFullSync() {
  console.log("🚀 Full sync starting...");
  const items = await fetchAllProducts();
  console.log("Items:", items.length);

  // In-memory build
  const styleMap = new Map();      // parentSku -> { parentSku, styleCode, brand, name }
  const colorKeySet = new Set();   // parentSku|color
  const variantRows = [];
  const barcodeRows = [];

  for (const item of items) {
    // Filter: virkt + sýna í netverslun 
    if (isInactive(item)) continue;
    if (!showInWebshop(item)) continue;

    const sku = norm(item.ItemCode ?? item.itemcode);
    if (!sku) continue;

    const alias = pickAlias(item);         // aliasitemcode
    const isbn = pickISBN(item);           // litur
    const author = pickAuthor(item);       // vörumerki
    const publisher = pickPublisher(item); // stærð (eða í case #2 notað sem brand í meta)

    const hasAlias = Boolean(alias);
    const hasColor = Boolean(isbn);
    const hasSize  = Boolean(publisher);

    // CASES (samkvæmt Q&A + samantekt) 
    // 1) alias empty => simple, title=Description, no brand/color/size display
    // 2) alias present but ISBN+Author empty => also simple, BUT meta-brand = Publisher
    const isSimple =
      (!hasAlias) ||
      (hasAlias && !hasColor && !author);

    // style_code & parent_sku strategy:
    // - Simple => style_code = sku => one card per SKU (no unintended grouping)
    // - Variation => style_code = alias; parent_sku = author+alias (avoid brand collisions) 
    let styleCode = "";
    let parentSku = "";
    let styleBrand = "";
    let styleName = "";

    if (isSimple) {
      styleCode = sku;
      parentSku = sku; // keep it unique for simple
      // brand only for case #2 (publisher); else empty
      styleBrand = (hasAlias && !hasColor && !author) ? publisher : "";
      styleName = pickDescription(item) || sku; // simple => Description 
    } else {
      styleCode = alias;
      styleBrand = author || ""; // variable => brand = author 
      parentSku = (styleBrand ? `${styleBrand}_${styleCode}` : styleCode); // avoid UNKNOWNs in UI
      // variable => Description2 fallback Description 
      styleName = pickDescription2(item) || pickDescription(item) || styleCode;
    }

    if (!styleMap.has(parentSku)) {
      styleMap.set(parentSku, { parentSku, styleCode, brand: styleBrand, name: styleName });
    }

    // color/size storage:
    // - Simple => keep color="" size="" (UI will treat as simple)
    // - Variation:
    //   * color+size => both filled
    //   * color-only => size=""
    //   * size-only => color=""
    const color = isSimple ? "" : (hasColor ? isbn : "");
    const size  = isSimple ? "" : (hasSize ? publisher : "");

    colorKeySet.add(`${parentSku}|${color}`);

    const bg1 = getWarehouseQty(item, "bg1");
    const bg5 = getWarehouseQty(item, "bg5");
    const bg6 = getWarehouseQty(item, "bg6");
    const selected = bg1 + bg5 + bg6;

    variantRows.push({
      parentSku,
      color,
      size,
      sku,
      price: toNumberOrNull(item.UnitPrice1WithTax) ?? null,
      discountPercent: toNumberOrNull(item.Discount) ?? null,
      bg1, bg5, bg6,
      selected,
      totalAll: toInt(item.TotalQuantityInWarehouse, 0),
    });

    // Barcode sync (SKU-level) 
    if (item.HasBarcodes || item.hasBarcodes) {
  console.log("BARCODE ITEM FOUND:", item.ItemCode, item.Barcodes);
}
    if (asBool(item.HasBarcodes ?? item.hasBarcodes) && Array.isArray(item.Barcodes)) {
      for (const b of item.Barcodes) {
        const barcode = norm(b?.Barcode ?? b?.barcode);
        if (!barcode) continue;
        barcodeRows.push({
          barcode,
          sku,
          isExtra: asBool(b?.IsExtraBarcode ?? b?.isExtraBarcode),
          modifiedAt: b?.Modified ? new Date(b.Modified) : null
        });
      }
    }
  }

  console.log("Styles:", styleMap.size, "Color groups:", colorKeySet.size, "Variants:", variantRows.length, "Barcodes:", barcodeRows.length);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureSchema(client);

    // Mirror reset
    await client.query(`UPDATE size_variant SET active = false;`);
    await client.query(`UPDATE style_product SET active = false, updated_at = NOW();`);

    // Barcode mirror: hreinsa og fylla aftur (A strategy: DB-only truth)
    await client.query(`TRUNCATE TABLE sku_barcode;`);

    // 1) styles
    const styles = Array.from(styleMap.values());
    const styleIdByParentSku = new Map();
    for (const part of chunk(styles, 2000)) {
      const m = await upsertStylesBatch(client, part);
      for (const [k, v] of m.entries()) styleIdByParentSku.set(k, v);
    }

    // 2) colors
    const colorRows = [];
    for (const key of colorKeySet) {
      const [pSku, color] = key.split("|");
      const styleId = styleIdByParentSku.get(pSku);
      if (!styleId) continue;
      colorRows.push({ styleId, color });
    }

    const colorIdByKey = new Map();
    for (const part of chunk(colorRows, 5000)) {
      const m = await upsertColorsBatch(client, part);
      for (const [k, v] of m.entries()) colorIdByKey.set(k, v);
    }

    // 3) variants
    const sizeRows = [];
    for (const v of variantRows) {
      const styleId = styleIdByParentSku.get(v.parentSku);
      if (!styleId) continue;
      const colorId = colorIdByKey.get(`${styleId}|${v.color}`);
      if (!colorId) continue;

      sizeRows.push({
        colorId,
        size: v.size, // empty => variation-without-size OR simple
        sku: v.sku,
        price: v.price,
        discountPercent: v.discountPercent,
        stockBg1: v.bg1,
        stockBg5: v.bg5,
        stockBg6: v.bg6,
        stockSelected: v.selected,
        stockTotalAll: v.totalAll,
      });
    }

    for (const part of chunk(sizeRows, 10000)) {
      await upsertSizeVariantsBatch(client, part);
    }

    // 4) barcodes
    for (const part of chunk(barcodeRows, 20000)) {
      await upsertBarcodesBatch(client, part);
    }

    await cleanupOrphans(client);

    await client.query("COMMIT");
    console.log("✅ Sync complete");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Sync failed:", e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

runFullSync().catch(e => console.error("❌ Fatal:", e.message));

