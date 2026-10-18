# MonteKasa

**Self-custodial invoicing for Italian freelancers and small agencies, paid in USDT on Bitcoin via RGB —
with a local AI assistant that explains payment checks and a Commercialista area for the tax side.**

Built for the **Agentic Dollars on Bitcoin** hackathon (Turin, 17–18 October 2026).

---

## Team

**Team name:** CryptoKnights

| Name | GitHub | Role |
|---|---|---|
| Alp Kale | [@Kalepox](https://github.com/Kalepox) | Payments, RGB layer, wallet (WDK) |
| Tuna Güvendir | [@tunaguvendir](https://github.com/tunaguvendir) | UI / product |
| Yusuf Deniz Çelik | [@YudeWeb](https://github.com/Yudeweb) | AI runtime (QVAC) + tax |

---

## The idea

Italian freelancers increasingly get paid in USDT, but invoicing, checking the payment and working out
the tax are all manual. MonteKasa is a desktop app with its own **self-custodial wallet** that issues an
**RGB invoice for USDT on Bitcoin**, emails it to the client, watches for the payment and **reconciles it
automatically** (paid / underpaid / overpaid / expired). Local agents help the merchant:

- **Fraud Controller** – every payment goes through recorded checks (asset, network, amount, duplicates,
  chain confirmations); a local **QVAC** model explains the findings and proposes actions such as a refund.
- **Commercialista** – tax profile (Italian regimes), payments organised per taxpayer and tax year, with the
  tax details recorded per payment.

Design rule: **agents propose, the merchant approves, code executes.** No agent moves money. Everything runs
on the merchant's laptop; keys never leave it; only settlement touches the network.

---

## Stack

| Layer | Technology |
|---|---|
| Desktop app | Electron 44 + TypeScript (electron-vite), UI in plain HTML/CSS/TS |
| Wallet | Tether **WDK** – `@tetherto/wdk` + `@utexo/wdk-wallet-rgb` (rgb-lib), in a local Node 22 service (`wallet-service/`) |
| Network | **Mutinynet** (Bitcoin signet, ~30 s blocks), RGB transport via the KaleidoSwap proxy |
| Test asset | Our own test USDT, issued with WDK: `rgb:PZYLqe~F-l1W~luC-1zH3CCI-TChEioP-jbNuXjJ-zVo6J7k` |
| Local AI | **QVAC SDK** (`@qvac/sdk`), Qwen3.5 2B running on the laptop |
| Storage | SQLite via `better-sqlite3`, with schema migrations |
| Tests | Vitest |
| Fallback backend | KaleidoSwap **RGB Lightning Node** (Docker) via `kaleido-sdk` 0.1.23 |

---

## What was built when

**Before the event** (8–16 October, see the git log):
- Project proposal (`RGB-Docs/`) and a static UI prototype (`src/UI/index.html`), with FatturaPA / F24 / CSV export.
- Electron + TypeScript skeleton, SQLite storage, and a basic RGB payment layer on a KaleidoSwap test node
  (`src/main/rgb`, with a mock for development).
- Rule-based invoice reconciliation and a simple refund proposal (`src/main/core`).
- `scripts/rgb.py`, a terminal helper for test transfers on the KaleidoSwap node.

**During the event** (17–18 October):
- **WDK wallet inside the app** – no Docker, no node: create / back up / restore / unlock on the Wallet page,
  encrypted seed, wallet-side policies (only our asset, per-send cap, only merchant-approved sends).
- **Own test USDT** issued on Mutinynet with WDK; real transfers between team laptops (macOS and Linux).
- **Payment security layer**: review → approval → execute, with recorded checks and chain verification.
- **QVAC assistant** that explains payment checks from recorded evidence.
- **Commercialista** interface: tax profile, tax years, activity organised per taxpayer.
- **Email payment requests** with a "Pay with MonteKasa" link (`docs/pay.html` on GitHub Pages).
- Redesigned wallet-first UI.

**Not built:** invoice extraction from PDFs is still simulated; EUR price feed and final tax figures are partial.

---

## Run the app

### 1. Install Node.js and nvm
The app runs on any current Node LTS; the wallet service needs **Node 22** (its native RGB library doesn't
build on newer versions). Easiest with [nvm](https://github.com/nvm-sh/nvm) (macOS / Linux / WSL):
```bash
nvm install 22
nvm install --lts
```

### 2. Install
Clone into a path **without spaces**, then:
```bash
npm install                            # the app
cd wallet-service && nvm exec 22 npm install && cd ..   # the wallet service, with Node 22
```
Warnings about deprecated packages are normal – don't run `npm audit fix --force`.

### 3. Start
```bash
RGB_BACKEND=wdk WALLET_NODE=$(nvm which 22) npm run dev
```
Keep the terminal open while the app runs. Open **Wallet** in the sidebar:
1. **Create a new wallet** (password 8+ characters) and write down the 12 recovery words – or **restore** one.
2. **Add test BTC** (pays network fees): copy the address → https://faucet.mutinynet.com.
3. **Prepare wallet** once the BTC has arrived – this creates the small outputs RGB tokens ride on.
4. **Receive**: create an invoice and send it to whoever pays you test USDT (copy, QR or **Email**).

After every app start, unlock the wallet on the Wallet page with your password.

### 4. Optional: fake wallet (no setup)
```bash
RGB_MOCK=1 npm run dev
```
The status pill says **"Mock node"**. To simulate a client paying 30 USDT, in **F12 → Console**:
```js
const s = await kasa.snapshot(); await kasa.mockPay(s.invoices[0].recipientId, 30)
```

Run tests: `npm test`.

---

## Wallet details

- **Where the data lives** (`<app data>`: macOS `~/Library/Application Support/agentic-euros/`,
  Linux `~/.config/agentic-euros/`):
  - `wdk-wallet/seed.enc` – the mnemonic, encrypted with your password
  - `wdk-wallet/rgb/` – RGB wallet state. **Never delete it:** RGB assets can't be restored from the mnemonic alone.
  - `kasa-wdk.db` – the app's database (invoices, payments, checks); the assistant and Commercialista read from here.
- **How it works:** the app starts `wallet-service/server.mjs` under Node 22. It holds one WDK wallet behind a
  local API that only the app can call (new token every run), syncs in the background, and exits when the app
  exits. Only one service may use a wallet at a time.
- **Rules:** test money only. One USDT asset (the ID above) – another "USDT" with a different ID is a different
  asset. Invoices contain `~`, `/` and `&`: wrap them in **single quotes** in a terminal.

| Setting | Default | Meaning |
|---|---|---|
| `RGB_BACKEND` | `kaleido` | Use `wdk` for the in-app wallet (`RGB_MOCK=1` = fake wallet) |
| `WALLET_NODE` | `node` | Path to the Node 22 binary (`$(nvm which 22)`) |
| `RGB_ASSET_ID` | test USDT above | The only asset the wallet receives and sends |
| `WALLET_MAX_SEND_RAW` | `500000000` | Per-send cap in raw units (500 USDT) |
| `RGB_CONFIRMATIONS` | `1` | Blocks before an incoming payment counts as final |

### Troubleshooting

| Problem | Fix |
|---|---|
| `Wallet service exited … Node 22` | `nvm which 22` must print a path; reinstall `wallet-service/` with `nvm exec 22 npm install` |
| `Wallet service did not start within 30 s` | `wallet-service/` dependencies missing (step 2) |
| `Another app is already using this wallet` | Close the other MonteKasa window. Still there? `ps -eo pid,cmd \| grep "[s]erver.mjs"` → `kill <pid>` (never `kill -9`) |
| Balance shows **Loading…** | The wallet is syncing – wait a few seconds |
| Pill says **Node locked** | Unlock on the Wallet page |
| Invoice creation fails | No free outputs: **Prepare wallet** again (needs test BTC) |
| `Wrong password` | The password used at create / restore on this laptop |
| App crashes about `better-sqlite3` | `npx electron-builder install-app-deps`; repo path without spaces |

---

## Fallback: KaleidoSwap node

The first version used a KaleidoSwap RGB Lightning Node in Docker (`kaleido-cli`, `scripts/rgb.py`) with
KaleidoSwap's test USDT `rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0`. It still works:
start the node (`kaleido node up default` → `kaleido node unlock`), then `RGB_BACKEND=kaleido npm run dev`
(another port: `RLN_NODE_URL=http://localhost:<port>`). It uses its own database, `kasa.db`.
Never run `kaleido node clean` or `docker compose down -v` – RGB assets can't be restored from the mnemonic.

---

## For developers

- **UI:** `src/UI/index.html` plus modules in `src/UI/src/` – `kasa.ts` (backend bridge), `wallet-gate.ts`
  (wallet panel), `security.ts` / `agent.ts` (checks and assistant), `tax-*.ts` (Commercialista).
- **Main process:** `src/main/core` (reconciliation, refunds), `src/main/rgb` (backends: `wdk`, `kaleido`, `mock`),
  `src/main/security` (checks, approvals), `src/main/ai` (QVAC assistant), `src/main/db` (SQLite).
- **Agents read data through `src/main/db`** (`listInvoices`, `listPayments`, `paymentsForInvoice`,
  `listProposals`) – read-only. Amounts are raw units (`toUsdt()` in `core/units.ts`; 1 USDT = 1,000,000).

### Payment checks and assistant explanations

The default configuration uses the verified Mutinynet profile: wallet indexer
`https://esplora.signet.kaleidoswap.com`, reference `https://mutinynet.com/api`, and checkpoint height `100000`
with hash `00000166f046342c6b499798686eb13cd2b4c6e5fd4189157922dca54705eb71`. These are test-network settings;
other networks need their own trusted indexer and checkpoint. Invalid configuration is shown in the status
tooltip and blocks payment review.

The assistant shows payment details separately from expandable technical evidence. Payment conclusions come
from recorded checks, not model-generated safety verdicts; a settled transfer does not establish recipient
identity or absence of fraud. Open-amount invoices accept positive amounts; fixed invoices require an exact
match. Every submission requires review and confirmation, and unknown outcomes or duplicate recipients stay
blocked against blind retries.
