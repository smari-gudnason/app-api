-- Parent (Style)
CREATE TABLE IF NOT EXISTS style_product (
  id SERIAL PRIMARY KEY,
  parent_sku TEXT UNIQUE NOT NULL,
  style_code TEXT NOT NULL,
  brand TEXT,
  name TEXT,
  active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Litur
CREATE TABLE IF NOT EXISTS color_variant (
  id SERIAL PRIMARY KEY,
  style_product_id INTEGER REFERENCES style_product(id) ON DELETE CASCADE,
  color TEXT
);

-- Stærðir (SKU)
CREATE TABLE IF NOT EXISTS size_variant (
  id SERIAL PRIMARY KEY,
  color_variant_id INTEGER REFERENCES color_variant(id) ON DELETE CASCADE,
  size TEXT,
  sku TEXT UNIQUE,
  price NUMERIC,
  stock INTEGER,
  active BOOLEAN DEFAULT TRUE
);

-- Webhook queue
CREATE TABLE IF NOT EXISTS webhook_queue (
  id SERIAL PRIMARY KEY,
  payload JSONB,
  processed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
``