# Kasa – RGB to-do

## 1. Environment
- [x] Docker in WSL, `kaleido-cli` via pipx
- [x] Merchant node (`default`, localhost:3001) on Mutinynet, unlocked
- [x] Client node (`client`, localhost:3002) on Mutinynet, unlocked
- [x] BTC from faucet.mutinynet.com on both; colored UTXOs (merchant 30, client 10)
- [x] Test USDT from the KaleidoSwap RGB faucet on both
  (asset `rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0`, precision 6)
- [x] First real transfer client → merchant (10 USDT, tx `11feed5e…a394`)
- [ ] Top up merchant vanilla BTC (only ~8k sats left for fees)
- [ ] Overpayment test: fixed-amount invoice (10 USDT), try to pay 30
- [ ] Report the `kaleido asset send` bug to KaleidoSwap (passes the full invoice as
  `recipient_id`, ignores the invoice's transport endpoints)
- [ ] Share a working send script with the team (`scripts/send-usdt.py`), since the CLI patch is local only

## 2. Dependencies
- [ ] `kaleido-sdk@0.1.23` (pinned), `qrcode`, `@types/qrcode`
- [ ] `better-sqlite3`

## 3. `src/main/rgb/` – RGB layer
- [ ] `config.ts` – node URL, USDT asset id, proxy, precision (6)
- [ ] `types.ts` – `RgbBackend` interface
- [ ] `mock.ts` – fake backend for development without a node
- [ ] `kaleido.ts` – real backend (createInvoice, listIncoming, send via decode → sendRgb)
- [ ] `index.ts` – pick mock or real from `RGB_MOCK`
- [ ] Handle a merchant that has never received the asset (`asset_id: null`, empty transfer list)
- [ ] Treat both `{type:"Any"}` and `{type:"Fungible", value:0}` as any-amount invoices
- [ ] Short invoice expiry (~1 h) so unpaid invoices free their UTXOs
- [ ] Show "Node syncing…" when the API returns `ChangingState`

## 4. `src/main/db/` – SQLite (better-sqlite3)
- [ ] Database at `app.getPath('userData')/kasa.db`
- [ ] `invoices` table (id, client, amount_raw, rgb_invoice, recipient_id, expires_at, state, created_at)
- [ ] `payments` table (node_idx PK, invoice_id, recipient_id, amount_raw, status, txid,
  block_time, receive_utxo, updated_at)
- [ ] Watcher writes every transfer into `payments`, keyed by `node_idx` (no double-processing)
- [ ] On settle: fetch block time from `https://mutinynet.com/api/tx/<txid>` → `block_time`
  (legal receipt date; `updated_at` is only when the node noticed)
- [ ] Later: EUR rate at receipt + tax columns (ledger)

## 5. `src/main/core/` – Kasa core
- [ ] `types.ts` – Invoice, InvoiceState, Proposal
- [ ] `reconcile.ts` – Issued / Pending / Paid / Underpaid / Overpaid / Expired / Flagged
- [ ] Unit tests for `reconcile.ts`
- [ ] `kasa.ts` – create invoice, poll, reconcile, refund proposals, approve → send
- [ ] Convert USDT ↔ raw units (× 10^6) in core, never in the UI

## 6. IPC + UI
- [ ] IPC handlers in `src/main/index.ts`
- [ ] Preload API + types in `src/preload/index.d.ts`
- [ ] UI: node status bar, new invoice form, invoice view with QR + live state, approval card
- [ ] CSV export of payments (from SQLite, not from the node)

## 7. Demo scenarios
- [ ] Paid: issue → client pays → Pending → Paid
- [ ] Overpaid: pay more → Overpaid → refund proposal → paste client invoice → approve → refund settles
- [ ] Expired: short expiry → Expired

## Demo day
- [ ] Unlock both nodes 15–20 min before presenting; check `kaleido node info`
- [ ] Don't restart laptop or Docker between the last test and the pitch
