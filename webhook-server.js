require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");

const app = express();
app.use(express.json()); // þarf til að lesa webhook body

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// sama helper og þú ert með
function getWarehouseQty(item, code) {
  const list = item?.Warehouses;
  if (!Array.isArray(list)) return 0;

  const codeLower = code.toLowerCase();
  const row = list.find(w => (w?.Warehouse || "").toLowerCase() === codeLower);

  return row?.QuantityInStock ?? 0;
}

// ⭐️ WEBHOOK ENDPOINT
app.post("/dk-webhook", async (req, res) => {
  try {
    const item = req.body;

    const sku = item.ItemCode;

    const price = item.UnitPrice1WithTax;
    const discount = item.Discount;

    const bg1 = getWarehouseQty(item, "bg1");
    const bg5 = getWarehouseQty(item, "bg5");
    const bg6 = getWarehouseQty(item, "bg6");

    const selected = bg1 + bg5 + bg6;

    await pool.query(`
      UPDATE size_variant
      SET price = $1,
          discount_percent = $2,
          stock_bg1 = $3,
          stock_bg5 = $4,
          stock_bg6 = $5,
          stock_selected = $6
      WHERE sku = $7
    `, [price, discount, bg1, bg5, bg6, selected, sku]);

    console.log("✅ Webhook updated:", sku);

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.sendStatus(500);
  }
});

// start server
app.listen(3000, () => {
  console.log("🚀 Webhook server running on http://localhost:3000");
});