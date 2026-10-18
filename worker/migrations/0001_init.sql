-- Inventory and orders (Cloudflare D1). Applied with: npx wrangler d1 migrations apply DB --remote

-- A piece with a row here is reserved by a checkout or sold; a piece without a row (or with an expired
-- reservation) is available. Every piece exists once, so its file name (DSC01606) is the key.
CREATE TABLE pieces (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,          -- 'reserved' | 'sold'
  hold TEXT NOT NULL,            -- the checkout holding or having bought it (orders.hold)
  until INTEGER                  -- reserved: available again after this moment (unix seconds)
);
CREATE INDEX pieces_hold ON pieces (hold);

-- One row per checkout started. Names, addresses and payment details stay in Stripe, not here.
CREATE TABLE orders (
  hold TEXT PRIMARY KEY,         -- random token, also in the metadata of the Stripe Checkout Session
  session TEXT,                  -- Stripe Checkout Session id (cs_...)
  created INTEGER NOT NULL,      -- unix seconds
  pieces TEXT NOT NULL,          -- JSON array of piece ids
  country TEXT NOT NULL,
  goods INTEGER NOT NULL,        -- cents
  shipping INTEGER NOT NULL,     -- cents
  total INTEGER,                 -- cents, as paid (from Stripe)
  status TEXT NOT NULL           -- open | pending (payment underway) | paid | expired | failed | cancelled
);
