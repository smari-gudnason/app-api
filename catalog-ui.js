require("dotenv").config();

const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PORT = Number(process.env.UI_PORT || 4000);

// ---------- helpers ----------
const norm = (v) => (v ?? "").toString().trim();

function fmtISK(v) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  if (Number.isNaN(n)) return "-";
  return n.toLocaleString("is-IS");
}

// ---------- API: brands ----------
app.get("/api/brands", async (_req, res) => {
  const q = await pool.query(`
    SELECT DISTINCT brand
    FROM style_product
    WHERE active = true AND brand IS NOT NULL AND brand <> ''
    ORDER BY brand
  `);
  res.json(q.rows.map(r => r.brand));
});

// ---------- API: search (paged groups) ----------
// One card per (parent_sku + color). Uses server-side paging for lazyload.
app.get("/api/search", async (req, res) => {
  const q = norm(req.query.q);
  const brand = norm(req.query.brand);
  const onlyInStock = String(req.query.onlyInStock || "").toLowerCase() === "true";
  const page = Math.max(1, Number(req.query.page || 1));
  const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize || 30)));
  const offset = (page - 1) * pageSize;

  const params = [];
  let where = `sv.active = true`;

  if (brand) {
    params.push(brand);
    where += ` AND sp.brand = $${params.length}`;
  }

  if (q) {
    params.push(`%${q}%`);
    const p = params.length;
    where += `
      AND (
        sp.name ILIKE $${p}
        OR sp.style_code ILIKE $${p}
        OR sp.parent_sku ILIKE $${p}
        OR cv.color ILIKE $${p}
        OR sp.brand ILIKE $${p}
        OR EXISTS (
          SELECT 1 FROM size_variant sv2
          WHERE sv2.active = true
            AND sv2.color_variant_id = cv.id
            AND (sv2.sku ILIKE $${p} OR sv2.size ILIKE $${p})
        )
      )
    `;
  }

  if (onlyInStock) {
    where += ` AND sv.stock_selected > 0`;
  }

  const countQ = await pool.query(
    `
    SELECT COUNT(*)::int AS total
    FROM (
      SELECT sp.parent_sku, cv.color
      FROM size_variant sv
      JOIN color_variant cv ON cv.id = sv.color_variant_id
      JOIN style_product sp ON sp.id = cv.style_product_id
      WHERE ${where}
      GROUP BY sp.parent_sku, cv.color
    ) g
    `,
    params
  );

  const total = countQ.rows[0]?.total || 0;

  const groupsQ = await pool.query(
    `
    SELECT
      sp.parent_sku AS parent_sku,
      sp.style_code AS style_code,
      sp.brand      AS brand,
      sp.name       AS description,
      cv.color      AS color,
      SUM(COALESCE(sv.stock_bg1,0))::int AS bg1_sum,
      SUM(COALESCE(sv.stock_selected,0))::int AS stock_sum,
      MIN(sv.price) AS price_min,
      MAX(sv.price) AS price_max
    FROM size_variant sv
    JOIN color_variant cv ON cv.id = sv.color_variant_id
    JOIN style_product sp ON sp.id = cv.style_product_id
    WHERE ${where}
    GROUP BY sp.parent_sku, sp.style_code, sp.brand, sp.name, cv.color
    ORDER BY
  NULLIF(sp.brand, '') NULLS LAST,
  LOWER(sp.name),
  sp.style_code,
  cv.color

    LIMIT ${pageSize} OFFSET ${offset}
    `,
    params
  );

  // load sizes preview for groups on this page
  const groupKeys = groupsQ.rows.map(r => ({ parent_sku: r.parent_sku, color: r.color }));
  const sizesByKey = new Map();

  if (groupKeys.length) {
    const keyParams = [];
    const ors = groupKeys.map(g => {
      keyParams.push(g.parent_sku);
      keyParams.push(g.color);
      const a = keyParams.length - 1;
      const b = keyParams.length;
      return `(sp.parent_sku = $${a} AND cv.color = $${b})`;
    }).join(" OR ");

    const sizesQ = await pool.query(
      `
      SELECT
        sp.parent_sku AS parent_sku,
        cv.color      AS color,
        sv.size       AS size,
        sv.sku        AS sku,
        sv.price      AS price,
        sv.stock_bg1  AS bg1,
        sv.stock_selected AS stock
      FROM size_variant sv
      JOIN color_variant cv ON cv.id = sv.color_variant_id
      JOIN style_product sp ON sp.id = cv.style_product_id
      WHERE sv.active = true AND (${ors})
      ORDER BY sp.parent_sku, cv.color, sv.size, sv.sku
      `,
      keyParams
    );

    for (const r of sizesQ.rows) {
      const key = `${r.parent_sku}|||${r.color}`;
      if (!sizesByKey.has(key)) sizesByKey.set(key, []);
      sizesByKey.get(key).push({
        size: norm(r.size),
        sku: norm(r.sku),
        price: r.price,
        bg1: r.bg1 ?? 0,
        stock: r.stock ?? 0
      });
    }
  }

  const items = groupsQ.rows.map(g => {
    const key = `${g.parent_sku}|||${g.color}`;
    const sizes = sizesByKey.get(key) || [];
    const hasColor = norm(g.color) !== "";
    const hasRealSizes = sizes.some(s => s.size !== "");

    let type = "simple";
    if (hasColor && hasRealSizes) type = "color_size";
    else if (hasColor && !hasRealSizes) type = "color_only";
    else if (!hasColor && hasRealSizes) type = "size_only";

    return {
      parent_sku: g.parent_sku,
      style_code: g.style_code,
      brand: norm(g.brand),
      description: norm(g.description),
      color: norm(g.color),
      bg1_sum: g.bg1_sum ?? 0,
      stock_sum: g.stock_sum ?? 0,
      price_min: g.price_min,
      price_max: g.price_max,
      type,
      sizes_preview: hasRealSizes ? sizes.slice(0, 10) : []
    };
  });

  res.json({ ok: true, total, page, pageSize, items });
});

// ---------- API: barcode lookup (A: DB-only) ----------
app.get("/api/barcode/:code", async (req, res) => {
  const barcode = norm(req.params.code);
  if (!barcode) return res.json({ found: false });

  const q = await pool.query(
    `
    SELECT
      sb.sku AS sku,
      sp.parent_sku AS parent_sku,
      cv.color AS color,
      sv.size AS size
    FROM sku_barcode sb
    JOIN size_variant sv ON sv.sku = sb.sku AND sv.active = true
    JOIN color_variant cv ON cv.id = sv.color_variant_id
    JOIN style_product sp ON sp.id = cv.style_product_id
    WHERE sb.barcode = $1
    LIMIT 1
    `,
    [barcode]
  );

  if (!q.rows.length) return res.json({ found: false });

  res.json({
    found: true,
    barcode,
    sku: norm(q.rows[0].sku),
    parent_sku: norm(q.rows[0].parent_sku),
    color: norm(q.rows[0].color),
    size: norm(q.rows[0].size)
  });
});

// ---------- API: parent view ----------
app.get("/api/style/:parentSku", async (req, res) => {
  const parentSku = norm(req.params.parentSku);
  if (!parentSku) return res.status(400).json({ ok: false, message: "parentSku vantar" });

  const rowsQ = await pool.query(
    `
    SELECT
      sp.parent_sku AS parent_sku,
      sp.style_code AS style_code,
      sp.brand      AS brand,
      sp.name       AS description,
      cv.color      AS color,
      sv.size       AS size,
      sv.sku        AS sku,
      sv.price      AS price,
      sv.discount_percent AS discount_percent,
      sv.stock_bg1  AS bg1,
      sv.stock_bg5  AS bg5,
      sv.stock_bg6  AS bg6,
      sv.stock_selected AS stock
    FROM size_variant sv
    JOIN color_variant cv ON cv.id = sv.color_variant_id
    JOIN style_product sp ON sp.id = cv.style_product_id
    WHERE sv.active = true AND sp.parent_sku = $1
    ORDER BY cv.color, sv.size, sv.sku
    `,
    [parentSku]
  );

  if (!rowsQ.rows.length) return res.json({ ok: false, message: "fann ekki parent" });

  const byColor = new Map();
  for (const r of rowsQ.rows) {
    const color = norm(r.color);
    if (!byColor.has(color)) byColor.set(color, []);
    byColor.get(color).push({
      size: norm(r.size),
      sku: norm(r.sku),
      price: r.price,
      discount_percent: r.discount_percent,
      bg1: r.bg1 ?? 0,
      bg5: r.bg5 ?? 0,
      bg6: r.bg6 ?? 0,
      stock: r.stock ?? 0
    });
  }

  const header = rowsQ.rows[0];
  const colors = Array.from(byColor.entries()).map(([color, list]) => {
    const hasRealSizes = list.some(s => s.size !== "");
    const type =
      (color !== "" && hasRealSizes) ? "color_size" :
      (color !== "" && !hasRealSizes) ? "color_only" :
      (color === "" && hasRealSizes) ? "size_only" :
      "simple";
    return { color, type, items: list };
  });

  res.json({
    ok: true,
    parent_sku: norm(header.parent_sku),
    style_code: norm(header.style_code),
    brand: norm(header.brand),
    description: norm(header.description),
    colors
  });
});

// ---------- API: SKU detail ----------
app.get("/api/sku/:sku", async (req, res) => {
  const sku = norm(req.params.sku);
  if (!sku) return res.status(400).json({ ok: false, message: "sku vantar" });

  const q = await pool.query(
    `
    SELECT
      sv.sku,
      sv.size,
      sv.price,
      sv.discount_percent,
      sv.stock_bg1 AS bg1,
      sv.stock_bg5 AS bg5,
      sv.stock_bg6 AS bg6,
      sv.stock_selected AS stock,
      cv.color AS color,
      sp.parent_sku AS parent_sku,
      sp.style_code AS style_code,
      sp.brand AS brand,
      sp.name AS description
    FROM size_variant sv
    JOIN color_variant cv ON cv.id = sv.color_variant_id
    JOIN style_product sp ON sp.id = cv.style_product_id
    WHERE sv.active = true AND sv.sku = $1
    LIMIT 1
    `,
    [sku]
  );

  if (!q.rows.length) return res.json({ ok: false, message: "SKU fannst ekki" });

  const bq = await pool.query(
    `SELECT barcode FROM sku_barcode WHERE sku = $1 ORDER BY barcode`,
    [sku]
  );

  res.json({ ok: true, ...q.rows[0], barcodes: bq.rows.map(r => norm(r.barcode)) });
});

// ---------- UI ----------
app.get("/", (_req, res) => {
  // IMPORTANT: keep this HTML clean (no HTML-escaped &lt; or &gt;)
  res.type("html").send(`<!doctype html>
<html lang="is">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Catalog</title>

  <!-- Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">

  <!-- ZXing (UMD) -->
  <script src="https://unpkg.com/@zxing/browser@latest"></script>

  <style>
    :root{
      --bg:#070B14; --bg2:#0B1220;
      --border: rgba(255,255,255,.10);
      --text:#EAF0FF; --muted:#95A4C7;
      --accent:#7C5CFF; --accent2:#00D1B2;
      --danger:#FF5C7A; --warn:#FFD27D;
      --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      --sans: "Inter", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      --shadow: 0 20px 60px rgba(0,0,0,.45);
    }
    *{box-sizing:border-box}
    body{
      margin:0; font-family:var(--sans); color:var(--text);
      background:
        radial-gradient(900px 500px at 15% 10%, rgba(124,92,255,.25), transparent),
        radial-gradient(900px 500px at 85% 20%, rgba(0,209,178,.18), transparent),
        radial-gradient(700px 400px at 50% 90%, rgba(124,92,255,.10), transparent),
        linear-gradient(180deg, var(--bg), var(--bg2));
      min-height:100vh;
    }
    .wrap{max-width:1180px; margin:0 auto; padding:26px;}
    .top{display:flex; gap:12px; align-items:flex-end; justify-content:space-between; flex-wrap:wrap}
    h1{margin:0; font-size:22px; font-weight:900; letter-spacing:.2px}
    .sub{margin-top:6px; color:var(--muted); font-size:13px}
    .controls{display:flex; gap:10px; flex-wrap:wrap; align-items:center}
    .input, .select, .pill{
      border:1px solid var(--border);
      background: rgba(255,255,255,.05);
      color: var(--text);
      padding:10px 12px;
      border-radius:14px;
      outline:none;
      transition: .15s ease;
    }
    .input{min-width:320px}
    .select{min-width:220px}
    .scanBtn{
      display:inline-flex; align-items:center; gap:8px;
      border-radius:14px; padding:10px 12px; cursor:pointer;
      border:1px solid rgba(124,92,255,.45);
      background: linear-gradient(135deg, rgba(124,92,255,.25), rgba(0,209,178,.12));
      font-weight:900;
      user-select:none;
    }
    .grid{display:grid; grid-template-columns:1fr; gap:12px; margin-top:16px}
    .card{
      background: linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.04));
      border: 1px solid var(--border);
      border-radius:20px;
      padding:14px;
      box-shadow: var(--shadow);
    }
    .cardHead{display:flex; justify-content:space-between; gap:12px; align-items:flex-start}
    .title{font-size:16px; font-weight:950; margin:0}
    .meta{color:var(--muted); font-size:12px; margin-top:6px}
    .right{display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end}
    .tag{
      display:inline-flex; align-items:center; gap:6px;
      padding:6px 10px; border-radius:999px; font-size:12px;
      border:1px solid rgba(0,209,178,.25);
      background: rgba(0,209,178,.10);
      color:#BFF3EA;
      white-space:nowrap;
    }
    .tag.warn{border-color:rgba(255,210,125,.35); background:rgba(255,210,125,.10); color:#FFE0A6}
    .tag.danger{border-color:rgba(255,92,122,.35); background:rgba(255,92,122,.12); color:#FFC1CD}
    .mono{font-family:var(--mono)}
    .rows{margin-top:10px; display:flex; flex-direction:column; gap:8px}
    .row{
      display:flex; gap:10px; align-items:center; justify-content:space-between;
      padding:10px 12px; border-radius:14px;
      background: rgba(255,255,255,.04);
      border: 1px solid rgba(255,255,255,.08);
      cursor:pointer;
      transition:.12s ease;
    }
    .row:hover{background: rgba(255,255,255,.07)}
    .rowLeft{display:flex; flex-direction:column; gap:4px}
    .rowMain{display:flex; gap:10px; align-items:baseline; flex-wrap:wrap}
    .sz{font-family:var(--mono); font-weight:800}
    .sku{font-family:var(--mono); color:var(--muted); font-size:12px}
    .price{font-weight:900}
    .stock{
      font-family:var(--mono);
      padding:6px 10px; border-radius:999px;
      border:1px solid rgba(84,240,167,.35);
      background: rgba(84,240,167,.12);
      color:#CFFFE8;
      font-weight:800;
    }
    .stock.zero{border-color:rgba(255,92,122,.35); background:rgba(255,92,122,.12); color:#FFC1CD}
    .stock.low{border-color:rgba(255,210,125,.35); background:rgba(255,210,125,.10); color:#FFE0A6}
    .footer{margin-top:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; color:var(--muted); font-size:12px}
    .spacer{flex:1}

    /* modal */
    .backdrop{position:fixed; inset:0; background:rgba(0,0,0,.55); backdrop-filter: blur(10px); display:none; align-items:center; justify-content:center; padding:18px; z-index:50;}
    .modal{width:min(980px, 100%); max-height: min(86vh, 900px); overflow:auto; background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04)); border:1px solid rgba(255,255,255,.12); border-radius:24px; box-shadow: var(--shadow); padding:16px;}
    .modalTop{display:flex; justify-content:space-between; gap:12px; align-items:flex-start}
    .closeBtn{cursor:pointer; border:1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: var(--text); border-radius:14px; padding:10px 12px; font-weight:900;}
    .chips{display:flex; gap:8px; overflow:auto; margin-top:12px; padding-bottom:4px}
    .chip{cursor:pointer; white-space:nowrap; padding:8px 12px; border-radius:999px; border:1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: var(--text); font-weight:900;}
    .chip.active{border-color: rgba(124,92,255,.55); background: rgba(124,92,255,.16);}

    /* drawer */
    .drawerBackdrop{position:fixed; inset:0; background:rgba(0,0,0,.45); backdrop-filter: blur(10px); display:none; z-index:60;}
    .drawer{position:fixed; top:0; right:-520px; height:100vh; width:min(520px, 92vw); background: linear-gradient(180deg, rgba(11,18,32,.96), rgba(7,11,20,.98)); border-left:1px solid rgba(255,255,255,.12); box-shadow: var(--shadow); padding:16px; transition:right .18s ease; z-index:61; overflow:auto;}
    .drawer.open{right:0}
    .drawerClose{cursor:pointer; padding:10px 12px; border-radius:14px; border:1px solid rgba(255,255,255,.14); background:rgba(255,255,255,.06); color:var(--text); font-weight:900}
    .kvBox{border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.04); border-radius:16px; padding:12px; margin-top:10px;}
    .kvLabel{color:var(--muted); font-size:12px}
    .kvValue{margin-top:6px; font-weight:900}
    .grid3{display:grid; grid-template-columns: repeat(3, 1fr); gap:10px; margin-top:10px}
    .mini{border:1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.04); border-radius:16px; padding:12px;}
    .mini .k{color:var(--muted); font-size:12px}
    .mini .v{margin-top:6px; font-family:var(--mono); font-weight:900}
    .barcodeList{margin-top:10px; display:flex; flex-wrap:wrap; gap:8px}
    .barcodePill{font-family:var(--mono); padding:6px 10px; border-radius:999px; border:1px solid rgba(124,92,255,.35); background: rgba(124,92,255,.12); color:#E2DBFF; font-weight:800;}

    /* scan */
    .scanBackdrop{position:fixed; inset:0; background:rgba(0,0,0,.60); backdrop-filter: blur(10px); display:none; align-items:center; justify-content:center; padding:18px; z-index:80;}
    .scanModal{width:min(760px, 100%); background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.04)); border:1px solid rgba(255,255,255,.12); border-radius:24px; box-shadow: var(--shadow); padding:16px;}
    video{width:100%; border-radius:16px; border:1px solid rgba(255,255,255,.10); background:#000}

    @media (max-width: 700px){ .input{min-width:100%} .select{min-width:100%} .controls{width:100%} }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <div>
        <h1>Catalog</h1>
        <div class="sub">BG1 í yfirliti. Smelltu á línu til að opna SKU detail með BG1/BG5/BG6. Skannaðu barcode í leitinni.</div>
      </div>
      <div class="controls">
        <input id="q" class="input" placeholder="Leita (heiti, style, litur, sku…)" />
        <select id="brand" class="select"><option value="">Öll vörumerki</option></select>
        <label class="pill" style="display:inline-flex; gap:8px; align-items:center"><input id="onlyInStock" type="checkbox" /> Bara með lager</label>
        <button id="scanBtn" class="scanBtn">📷 Skanna</button>
      </div>
    </div>

    <div class="footer"><span id="count">—</span><span class="spacer"></span><span id="status"></span></div>

    <div id="grid" class="grid"></div>
    <div id="sentinel" style="height:1px"></div>
  </div>

  <!-- Parent modal -->
  <div id="backdrop" class="backdrop">
    <div class="modal">
      <div class="modalTop">
        <div>
          <h2 id="modalTitle" style="margin:0; font-size:18px; font-weight:950"></h2>
          <div id="modalMeta" class="meta"></div>
        </div>
        <button id="closeModal" class="closeBtn">Loka</button>
      </div>
      <div id="colorChips" class="chips"></div>
      <div id="modalRows" style="margin-top:12px"></div>
    </div>
  </div>

  <!-- Drawer -->
  <div id="drawerBackdrop" class="drawerBackdrop"></div>
  <div id="drawer" class="drawer">
    <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start">
      <div>
        <h3 id="drawerTitle" style="margin:0; font-size:16px; font-weight:950"></h3>
        <div id="drawerSub" class="meta"></div>
      </div>
      <button id="drawerClose" class="drawerClose">Loka</button>
    </div>

    <div class="kvBox"><div class="kvLabel">SKU</div><div id="drawerSku" class="kvValue mono"></div></div>
    <div class="kvBox"><div class="kvLabel">Verð</div><div id="drawerPrice" class="kvValue"></div></div>

    <div class="grid3">
      <div class="mini"><div class="k">BG1</div><div id="drawerBG1" class="v"></div></div>
      <div class="mini"><div class="k">BG5</div><div id="drawerBG5" class="v"></div></div>
      <div class="mini"><div class="k">BG6</div><div id="drawerBG6" class="v"></div></div>
    </div>

    <div class="kvBox"><div class="kvLabel">Barcodes</div><div id="drawerBarcodes" class="barcodeList"></div></div>
  </div>

  <!-- Scan modal -->
  <div id="scanBackdrop" class="scanBackdrop">
    <div class="scanModal">
      <div class="modalTop">
        <div>
          <h2 style="margin:0; font-size:18px; font-weight:950">Skanna strikamerki</h2>
          <div class="meta">Leyfðu aðgang að myndavél. Haltu strikamerki í miðju.</div>
        </div>
        <button id="closeScan" class="closeBtn">Loka</button>
      </div>
      <video id="scanVideo" playsinline></video>
      <div id="scanStatus" class="meta" style="margin-top:10px"></div>
    </div>
  </div>

<script>
(function(){
  const qEl = document.getElementById('q');
  const brandEl = document.getElementById('brand');
  const onlyInStockEl = document.getElementById('onlyInStock');
  const gridEl = document.getElementById('grid');
  const countEl = document.getElementById('count');
  const statusEl = document.getElementById('status');
  const sentinel = document.getElementById('sentinel');

  const backdrop = document.getElementById('backdrop');
  const modalTitle = document.getElementById('modalTitle');
  const modalMeta = document.getElementById('modalMeta');
  const colorChips = document.getElementById('colorChips');
  const modalRows = document.getElementById('modalRows');

  const drawerBackdrop = document.getElementById('drawerBackdrop');
  const drawer = document.getElementById('drawer');

  const scanBackdrop = document.getElementById('scanBackdrop');
  const scanVideo = document.getElementById('scanVideo');
  const scanStatus = document.getElementById('scanStatus');

  document.getElementById('closeModal').addEventListener('click', closeParent);
  document.getElementById('drawerClose').addEventListener('click', closeDrawer);
  drawerBackdrop.addEventListener('click', closeDrawer);
  document.getElementById('scanBtn').addEventListener('click', openScan);
  document.getElementById('closeScan').addEventListener('click', closeScan);

  let page = 1;
  const pageSize = 30;
  let total = 0;
  let loading = false;
  let done = false;

  let currentParent = null;
  let currentColor = null;
  let highlightSku = null;

  let codeReader = null;
  let scanControls = null;

  function fmtISK(v){
    if (v === null || v === undefined) return '-';
    const n = Number(v);
    if (Number.isNaN(n)) return '-';
    return n.toLocaleString('is-IS');
  }

  function stockClass(n){
    if (!n) return 'zero';
    if (n <= 3) return 'low';
    return '';
  }

  function makeEl(tag, cls, text){
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  async function loadBrands(){
    const brands = await fetch('/api/brands').then(r=>r.json());
    brands.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      brandEl.appendChild(opt);
    });
  }

  function resetList(){
    page = 1;
    total = 0;
    done = false;
    gridEl.innerHTML = '';
  }

  async function loadPage(){
    if (loading || done) return;
    loading = true;
    statusEl.textContent = 'Hleð…';

    const q = qEl.value.trim();
    const brand = brandEl.value.trim();
    const onlyInStock = onlyInStockEl.checked;

    const url = '/api/search?q=' + encodeURIComponent(q)
      + '&brand=' + encodeURIComponent(brand)
      + '&onlyInStock=' + encodeURIComponent(onlyInStock)
      + '&page=' + page + '&pageSize=' + pageSize;

    const data = await fetch(url).then(r=>r.json()).catch(()=>({ok:false}));
    if (!data.ok){
      statusEl.textContent = 'Villa í /api/search';
      loading = false;
      return;
    }

    total = data.total || 0;
    countEl.textContent = total + ' línur';

    const items = data.items || [];
    if (!items.length){
      done = true;
      statusEl.textContent = '—';
      loading = false;
      return;
    }

    items.forEach(item => gridEl.appendChild(renderCard(item)));
    page++;

    if ((page - 1) * pageSize >= total) done = true;
    statusEl.textContent = '—';
    loading = false;
  }

  const io = new IntersectionObserver((entries)=>{
    entries.forEach(e => { if (e.isIntersecting) loadPage(); });
  }, { rootMargin: '800px' });
  io.observe(sentinel);

  let t;
  function refresh(){
    clearTimeout(t);
    t = setTimeout(async ()=>{
      resetList();
      await loadPage();
    }, 250);
  }
  qEl.addEventListener('input', refresh);
  brandEl.addEventListener('change', refresh);
  onlyInStockEl.addEventListener('change', refresh);

  function typeTag(type){
    if (type === 'simple') return 'SIMPLE';
    if (type === 'color_size') return 'LIT + STÆRÐ';
    if (type === 'color_only') return 'LIT (án stærða)';
    if (type === 'size_only') return 'STÆRÐ (án litar)';
    return 'VÖRUTEGUND';
  }

  function titleForCard(item){
    return item.description + (item.color ? (' ' + item.color) : '');
  }

  function renderCard(item){
    const card = makeEl('div','card');

    const head = makeEl('div','cardHead');
    const left = makeEl('div');
    const title = makeEl('div','title', titleForCard(item));
    const meta = makeEl('div','meta', [item.brand, (item.style_code && item.type !== 'simple') ? ('Style: ' + item.style_code) : ''].filter(Boolean).join(' • '));
    left.appendChild(title);
    left.appendChild(meta);

    const right = makeEl('div','right');
    const bg1 = item.bg1_sum || 0;
    const tag = makeEl('span','tag mono' + (bg1===0 ? ' danger' : (bg1<=3 ? ' warn' : '')), 'BG1 ' + bg1);
    right.appendChild(tag);
    right.appendChild(makeEl('span','tag', typeTag(item.type)));

    head.appendChild(left);
    head.appendChild(right);

    const rows = makeEl('div','rows');

    if (item.type === 'simple' || item.type === 'color_only'){
      const row = makeEl('div','row');
      row.addEventListener('click', ()=> openParent(item.parent_sku, item.color || ''));
      const rowLeft = makeEl('div','rowLeft');
      const rowMain = makeEl('div','rowMain');
      const price = (item.price_min !== null && item.price_min !== undefined) ? item.price_min : item.price_max;
      rowMain.appendChild(makeEl('span','price', fmtISK(price) + ' kr'));
      const st = makeEl('span','stock ' + stockClass(bg1), 'BG1 ' + bg1);
      rowMain.appendChild(st);
      rowLeft.appendChild(rowMain);
      rowLeft.appendChild(makeEl('div','sku mono','Opna vöru'));
      row.appendChild(rowLeft);
      rows.appendChild(row);
    } else {
      (item.sizes_preview || []).forEach(s => {
        const row = makeEl('div','row');
        row.addEventListener('click', async ()=>{
          await openParent(item.parent_sku, item.color || '');
          await strictHighlightBySku(s.sku);
        });
        const rowLeft = makeEl('div','rowLeft');
        const rowMain = makeEl('div','rowMain');
        rowMain.appendChild(makeEl('span','sz', s.size));
        rowMain.appendChild(makeEl('span','price', fmtISK(s.price) + ' kr'));
        const st = makeEl('span','stock ' + stockClass(s.bg1 || 0), 'BG1 ' + (s.bg1 || 0));
        rowMain.appendChild(st);
        rowLeft.appendChild(rowMain);
        rowLeft.appendChild(makeEl('div','sku', s.sku));
        row.appendChild(rowLeft);
        rows.appendChild(row);
      });

      if (!(item.sizes_preview || []).some(s => s.size)){
        // fallback (shouldn't happen)
        const row = makeEl('div','row');
        row.addEventListener('click', ()=> openParent(item.parent_sku, item.color || ''));
        row.appendChild(makeEl('div','rowLeft','Opna vöru'));
        rows.appendChild(row);
      }
    }

    card.appendChild(head);
    card.appendChild(rows);
    return card;
  }

  function openBackdrop(){
    backdrop.style.display = 'flex';
    document.body.style.overflow = 'hidden';
  }

  function closeParent(){
    backdrop.style.display = 'none';
    currentParent = null;
    currentColor = null;
    highlightSku = null;
    document.body.style.overflow = 'auto';
  }

  async function openParent(parentSku, preselectColor){
    const data = await fetch('/api/style/' + encodeURIComponent(parentSku)).then(r=>r.json());
    if (!data.ok){
      alert('Fann ekki parent');
      return;
    }

    currentParent = data;
    modalTitle.textContent = data.description || data.style_code || data.parent_sku;
    modalMeta.textContent = [data.brand, data.style_code ? ('Style: ' + data.style_code) : ''].filter(Boolean).join(' • ');

    const colors = (data.colors || []).slice();
    colors.sort((a,b)=> (a.color === '' ? 1 : 0) - (b.color === '' ? 1 : 0) || (a.color||'').localeCompare(b.color||''));

    currentColor = (preselectColor !== null && preselectColor !== undefined) ? preselectColor : (colors[0] ? colors[0].color : '');

    colorChips.innerHTML = '';
    colors.forEach(c => {
      const label = c.color || '—';
      const btn = makeEl('button','chip' + ((c.color === currentColor) ? ' active' : ''), label);
      btn.addEventListener('click', ()=>{
        currentColor = c.color;
        [...colorChips.querySelectorAll('.chip')].forEach(x=>x.classList.remove('active'));
        btn.classList.add('active');
        renderModalRows();
      });
      colorChips.appendChild(btn);
    });

    renderModalRows();
    openBackdrop();
  }

  function cssSafe(s){
    return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function renderModalRows(){
    const colors = currentParent.colors || [];
    const c = colors.find(x => x.color === currentColor) || colors[0];
    const list = (c && c.items) ? c.items : [];

    const hasSizes = list.some(x => (x.size || '') !== '');

    modalRows.innerHTML = '';

    const rows = makeEl('div','rows');

    if (!hasSizes){
      const first = list[0] || {};
      const row = makeEl('div','row');
      row.id = 'sku-' + cssSafe(first.sku || '');
      row.addEventListener('click', ()=> openDrawerForSku(first.sku));

      const rowLeft = makeEl('div','rowLeft');
      const rowMain = makeEl('div','rowMain');
      rowMain.appendChild(makeEl('span','price', fmtISK(first.price) + ' kr'));
      rowMain.appendChild(makeEl('span','stock ' + stockClass(first.bg1 || 0), 'BG1 ' + (first.bg1 || 0)));
      rowLeft.appendChild(rowMain);
      rowLeft.appendChild(makeEl('div','sku mono', first.sku || ''));
      row.appendChild(rowLeft);
      rows.appendChild(row);

      modalRows.appendChild(rows);

      if (highlightSku && first.sku === highlightSku){
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        openDrawerForSku(first.sku);
      }
      return;
    }

    list.forEach(x => {
      const row = makeEl('div','row');
      row.id = 'sku-' + cssSafe(x.sku);
      row.addEventListener('click', ()=> openDrawerForSku(x.sku));

      const rowLeft = makeEl('div','rowLeft');
      const rowMain = makeEl('div','rowMain');
      rowMain.appendChild(makeEl('span','sz', x.size));
      rowMain.appendChild(makeEl('span','price', fmtISK(x.price) + ' kr'));
      rowMain.appendChild(makeEl('span','stock ' + stockClass(x.bg1 || 0), 'BG1 ' + (x.bg1 || 0)));
      if (highlightSku && x.sku === highlightSku){
        rowMain.appendChild(makeEl('span','tag','VALIÐ'));
      }
      rowLeft.appendChild(rowMain);
      rowLeft.appendChild(makeEl('div','sku', x.sku));
      row.appendChild(rowLeft);
      rows.appendChild(row);
    });

    modalRows.appendChild(rows);

    if (highlightSku){
      const el = document.getElementById('sku-' + cssSafe(highlightSku));
      if (el){
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        openDrawerForSku(highlightSku);
      }
    }
  }

  async function strictHighlightBySku(sku){
    highlightSku = sku;
    const colors = currentParent.colors || [];
    let foundColor = currentColor;

    for (const c of colors){
      if ((c.items || []).some(x => x.sku === sku)){
        foundColor = c.color;
        break;
      }
    }

    currentColor = foundColor;

    // update chip UI
    [...colorChips.querySelectorAll('.chip')].forEach(btn => {
      const label = btn.textContent;
      const isEmpty = (foundColor === '' && label === '—');
      const isSame = (label === foundColor);
      btn.classList.toggle('active', isEmpty || isSame);
    });

    renderModalRows();
  }

  function openDrawer(){
    drawerBackdrop.style.display = 'block';
    drawer.classList.add('open');
  }

  function closeDrawer(){
    drawerBackdrop.style.display = 'none';
    drawer.classList.remove('open');
  }

  async function openDrawerForSku(sku){
    if (!sku) return;
    const data = await fetch('/api/sku/' + encodeURIComponent(sku)).then(r=>r.json());
    if (!data.ok) return;

    document.getElementById('drawerTitle').textContent = (data.description || data.style_code || data.parent_sku) + (data.color ? (' ' + data.color) : '');
    document.getElementById('drawerSub').textContent = (data.brand ? (data.brand + ' • ') : '') + (data.style_code ? ('Style: ' + data.style_code) : '');

    document.getElementById('drawerSku').textContent = data.sku || '';
    document.getElementById('drawerPrice').textContent = fmtISK(data.price) + ' kr' + ((data.discount_percent !== null && data.discount_percent !== undefined) ? ('  ( -' + data.discount_percent + '% )') : '');

    document.getElementById('drawerBG1').textContent = String(data.bg1 || 0);
    document.getElementById('drawerBG5').textContent = String(data.bg5 || 0);
    document.getElementById('drawerBG6').textContent = String(data.bg6 || 0);

    const list = document.getElementById('drawerBarcodes');
    list.innerHTML = '';
    (data.barcodes || []).forEach(b => {
      const span = makeEl('span','barcodePill', b);
      list.appendChild(span);
    });

    openDrawer();
  }

  async function openScan(){
    scanBackdrop.style.display = 'flex';
    scanStatus.textContent = 'Ræsi myndavél…';

    try {
      if (!window.ZXingBrowser){
        scanStatus.textContent = 'ZXing ekki hlaðið.';
        return;
      }
      codeReader = new ZXingBrowser.BrowserMultiFormatReader();
      const devices = await ZXingBrowser.BrowserCodeReader.listVideoInputDevices();
      const preferred = devices.find(d => /back|environment/i.test(d.label)) || devices[0];
      const deviceId = preferred ? preferred.deviceId : undefined;

      scanStatus.textContent = 'Skanna…';

      scanControls = await codeReader.decodeFromVideoDevice(deviceId, scanVideo, async (result, err, controls) => {
        if (result){
          const code = result.getText();
          try { controls.stop(); } catch(e) {}
          closeScan();
          await handleBarcode(code);
        }
      });
    } catch (e){
      scanStatus.textContent = 'Ekki tókst að opna myndavél (permissions?)';
    }
  }

  function closeScan(){
    scanBackdrop.style.display = 'none';
    scanStatus.textContent = '';
    try { if (scanControls) scanControls.stop(); } catch(e) {}
    scanControls = null;
    try { if (codeReader) codeReader.reset(); } catch(e) {}
    codeReader = null;
  }

  async function handleBarcode(code){
    const clean = (code || '').trim();
    if (!clean) return;

    statusEl.textContent = 'Leita að barcode…';
    const resp = await fetch('/api/barcode/' + encodeURIComponent(clean)).then(r=>r.json());

    if (!resp.found){
      statusEl.textContent = '❌ Barcode fannst ekki: ' + clean;
      setTimeout(()=> statusEl.textContent = '—', 2500);
      return;
    }

    statusEl.textContent = 'Opna vöru…';
    await openParent(resp.parent_sku, resp.color);
    await strictHighlightBySku(resp.sku);
    statusEl.textContent = '—';
  }

  // Treat Enter as barcode if digits
  qEl.addEventListener('keydown', async (e)=>{
    if (e.key === 'Enter'){
      const value = qEl.value.trim();
      if (/^[0-9]{8,14}$/.test(value)){
        e.preventDefault();
        await handleBarcode(value);
      }
    }
  });

  // init
  (async function init(){
    await loadBrands();
    resetList();
    await loadPage();
  })();
})();
</script>
</body>
</html>`);
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log("🌐 catalog-ui:", `http://localhost:${PORT}`);
});
