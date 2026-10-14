export const SCHEMA_V1 = `
CREATE TABLE invoices (
  id            TEXT PRIMARY KEY,
  client        TEXT NOT NULL,
  amount_raw    INTEGER NOT NULL,          -- what we asked for
  received_raw  INTEGER NOT NULL DEFAULT 0,
  rgb_invoice   TEXT NOT NULL,
  recipient_id  TEXT NOT NULL UNIQUE,      -- links to payments
  expires_at    INTEGER NOT NULL,
  state         TEXT NOT NULL,             -- Issued | Pending | Paid | Underpaid | Overpaid | Expired | Flagged
  created_at    INTEGER NOT NULL
);

CREATE TABLE payments (
  node_idx      INTEGER PRIMARY KEY,       -- transfer idx on the node: never processed twice
  invoice_id    TEXT REFERENCES invoices(id),
  recipient_id  TEXT NOT NULL,
  requested_raw INTEGER,                   -- null = any amount
  received_raw  INTEGER NOT NULL,
  status        TEXT NOT NULL,             -- waiting | confirming | settled | failed
  txid          TEXT,
  block_time    INTEGER,                   -- legal receipt date, from the explorer
  receive_utxo  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX payments_invoice ON payments(invoice_id);
`

export const SCHEMA_V2 = `
CREATE TABLE proposals (
  id             TEXT PRIMARY KEY,
  invoice_id     TEXT NOT NULL REFERENCES invoices(id),
  kind           TEXT NOT NULL,            -- refund (later: reissue, remind, hold)
  amount_raw     INTEGER NOT NULL,
  reason         TEXT NOT NULL,
  status         TEXT NOT NULL,            -- open | executing | executed | failed | dismissed
  refund_invoice TEXT,
  txid           TEXT,
  error          TEXT,
  created_at     INTEGER NOT NULL
);
CREATE UNIQUE INDEX one_proposal_per_kind ON proposals(invoice_id, kind);
`

