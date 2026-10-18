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
the tax are all manual. MonteKasa is a desktop app with its own **self-custodial wallet**. It issues an
**RGB invoice for USDT on Bitcoin**, emails it to the client, watches for the payment and **reconciles it
automatically** (paid / underpaid / overpaid / expired). Local agents help the merchant:

- **Fraud Check** – every payment goes through recorded checks (asset, network, amount, duplicates, chain
  confirmations); a local **QVAC** model explains the findings and proposes actions such as a refund.
- **Commercialista** – tax profile (Italian regimes) and payments organised per taxpayer and tax year.

Design rule: **agents propose, the merchant approves, code executes.** No agent moves money. Everything runs
on the merchant's laptop; keys never leave it; only settlement touches the network.

---

## Stack

| Layer | Technology |
|---|---|
| Desktop app | Electron 44 + TypeScript (electron-vite), UI in HTML/CSS/TS |
| Wallet | Tether **WDK** – `@tetherto/wdk` + `@utexo/wdk-wallet-rgb` (rgb-lib), in a local Node 22 service (`wallet-service/`) |
| Network | **Mutinynet** (Bitcoin test network, ~30 s blocks); RGB transport via the KaleidoSwap proxy |
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
- **WDK wallet inside the app** – no Docker, no node. Create / back up / restore / unlock, change password and
  view recovery words, all from the UI. Encrypted seed; the wallet only sends our asset, at most 500 USDT per
  send, and only what the merchant approved.
- **Own test USDT** issued on Mutinynet with WDK; real transfers between team laptops (macOS and Linux).
- **Payment security layer**: review → approval → execute, with recorded checks and chain verification.
- **QVAC assistant** that explains payment checks from recorded evidence.
- **Commercialista** interface: tax profile, tax years, activity organised per taxpayer.
- **Email payment requests** with a "Pay with MonteKasa" link (`docs/pay.html` on GitHub Pages).
- Redesigned wallet-first UI, transaction PDFs and CSV export.

---

## Run it on a new computer

Works on **macOS** (Apple Silicon or Intel) and **Linux**. On **Windows**, use **WSL (Ubuntu)** – the wallet's
RGB library has no native Windows build. Everything below is typed in a terminal (macOS: *Terminal*;
Windows: the *Ubuntu* app).

Everything is **test money with no value**.

### Step 1 – Install the tools (once)

**macOS:**
```bash
xcode-select --install          # Apple's command-line tools (skip if already installed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

**Linux / WSL (Ubuntu):**
```bash
sudo apt update && sudo apt install -y git curl build-essential python3
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

Then **close the terminal and open a new one**, and install Node.js 22 (the wallet needs exactly this version;
using it for everything is simplest):
```bash
nvm install 22
nvm alias default 22
node -v                          # should print v22.x.x
```

### Step 2 – Download and install MonteKasa (once)
Use a folder path **without spaces**.
```bash
git clone https://github.com/Kalepox/MonteKasa.git
cd MonteKasa
npm install                                   # the app (takes a few minutes; warnings are normal)
cd wallet-service && npm install && cd ..     # the wallet service
```
Don't run `npm audit fix --force`.

### Step 3 – Start the app
From the `MonteKasa` folder:
```bash
npm run dev
```
The window opens after a few seconds. **Keep the terminal open** while you use the app – closing it closes the
app. To stop: close the window (or press `Ctrl+C` in the terminal).

### Step 4 – Create your wallet (in the app, no terminal)
Open **Wallet** in the sidebar. The card at the top walks you through it:
1. **Create a new wallet** → choose a password (8+ characters).
2. **Write down the 12 recovery words** on paper, in order, and tick the box. They are the only way to recover
   the wallet on another computer.
3. **Add test BTC** (it pays the network fees): click **Copy address**, open **Open faucet**
   (https://faucet.mutinynet.com), paste the address and request sats. Wait until the card says *sats received*.
4. Click **Prepare wallet**. This creates the small Bitcoin outputs that RGB tokens ride on (~1 minute).

Already have recovery words? Choose **I already have recovery words** instead of *Create*.

**Every time you start the app:** enter your password in the **Wallet** card to unlock.

### Step 5 – Get test USDT and try a payment
- **Receive:** **Wallet → Receive** → leave the amount empty (any amount) → **Copy Address** and send the
  `rgb:…` invoice to someone who has test USDT (ask the team – we hold the test USDT). It arrives in your
  balance within seconds of being sent. (A brand-new wallet's first invoice is always any-amount; the app does this by itself.)
- **Send:** **Wallet → Send** → paste the other person's `rgb:` invoice → amount → review → approve.
- **Email a payment request:** in **Receive**, enter the client's email and click **Email Request** – your mail
  app opens a draft with a "Pay with MonteKasa" link.

### Step 6 – Wallet security (in the app)
**Security** in the sidebar handles everything about the wallet password – no terminal needed:
- **Lock now** – locks the wallet until you unlock it again with the password.
- **Show recovery words** – asks for the password, hides them again after 60 seconds.
- **Change password** – the recovery words stay the same.
- **Activity** – unlocks, failed password attempts, password changes. After **5 wrong passwords in a row**,
  password checks pause for 30 seconds.

**Fraud Check** (sidebar) shows the payment checks and findings.

---

## Good to know

- **Don't close the app in the middle of a send or right after unlocking** – give it a few seconds. The wallet
  writes to disk while it syncs.
- **One MonteKasa window per computer.** Two copies on the same wallet are refused.
- **Your data** (macOS: `~/Library/Application Support/agentic-euros/`, Linux: `~/.config/agentic-euros/`):
  - `wdk-wallet/seed.enc` – your recovery words, encrypted with your password
  - `wdk-wallet/rgb/` – RGB wallet state. **Never delete it:** test USDT can't be restored from the words alone.
  - `kasa-wdk.db` – invoices, payments and checks (the assistant and Commercialista read from here)
- **Invoices in a terminal** contain `~`, `/` and `&`: wrap them in **single quotes**.
- **Only our test USDT** (`rgb:PZYLqe…`) is accepted. Another "USDT" with a different ID is a different asset.
- **The AI assistant** (*Ask AI*) downloads its model the first time you switch it on.

### Try it without a wallet
A fake wallet, no setup beyond Step 2:
```bash
RGB_MOCK=1 npm run dev
```
The status pill says **"Mock node"**. Create an invoice with **New Invoice**, then simulate the client paying 30
with **F12 → Console**:
```js
const s = await kasa.snapshot(); await kasa.mockPay(s.invoices[0].recipientId, 30)
```

### Troubleshooting

| What you see | Fix |
|---|---|
| Wallet card: **"The wallet service is not installed yet"** | `cd wallet-service && npm install && cd ..` (with Node 22), then **Try again** |
| Wallet card: **"needs Node.js 22"** | `nvm install 22`, then `cd wallet-service && rm -rf node_modules && nvm exec 22 npm install && cd ..`, restart the app |
| **"Another app is already using this wallet"** | Close the other MonteKasa window. Still there? `ps -eo pid,cmd \| grep "[s]erver.mjs"` → `kill <pid>` (never `kill -9`) |
| Balance shows **Loading…** | The wallet is syncing – wait a few seconds |
| **Prepare wallet** fails | The test BTC hasn't confirmed yet – wait a minute and click again |
| Receive / invoice creation fails | No free outputs: unlock, then **Prepare wallet** again (needs test BTC) |
| **Wrong password** | Use the password chosen on this computer; forgotten? Restore from the 12 words with a new password |
| **"Too many wrong passwords"** | Wait 30 seconds |
| **Failed to initialize rgb-lib wallet … bincode error** | The app was closed mid-sync. Close the app, then: `cd ~/.config/agentic-euros/wdk-wallet/rgb/*/ && mv bdk_db_watch_only bdk_db_watch_only.broken` (macOS: `~/Library/Application Support/agentic-euros/…`), start again |
| App crashes about `better-sqlite3` | `npx electron-builder install-app-deps`; folder path without spaces |
| `nvm: command not found` | Close and reopen the terminal after installing nvm |
| `xcrun: error: invalid active developer path` (macOS) | `xcode-select --install` |

### Settings (optional)

| Variable | Default | Meaning |
|---|---|---|
| `RGB_BACKEND` | `wdk` | `wdk` (in-app wallet), `kaleido` (Docker node, below) or `mock` (`RGB_MOCK=1`) |
| `WALLET_NODE` | found automatically | Path to the Node 22 binary for the wallet service (nvm and Homebrew `node@22` are found on their own) |
| `RGB_ASSET_ID` | test USDT above | The only asset the wallet receives and sends |
| `WALLET_MAX_SEND_RAW` | `500000000` | Per-send cap in raw units (500 USDT) |
| `RGB_CONFIRMATIONS` | `1` | Blocks before an incoming payment counts as final |
| `PAY_PAGE` | GitHub Pages `pay.html` | The page the "Pay with MonteKasa" email link opens |

Run the tests: `npm test`.

---

## Fallback: KaleidoSwap node

The first version used a KaleidoSwap RGB Lightning Node in Docker, with KaleidoSwap's test USDT
`rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0`. It still works, with its own database (`kasa.db`):
```bash
# once: Docker Desktop, then
pipx install kaleido-cli
kaleido setup && kaleido node init       # write down the mnemonic
# every time:
kaleido node up default
kaleido node unlock                      # S (signet) → T (transaction sync) → Enter → Enter
RGB_BACKEND=kaleido npm run dev          # another port: add RLN_NODE_URL=http://localhost:<port>
```
Test BTC: `kaleido wallet address` → https://faucet.mutinynet.com. Outputs:
`kaleido wallet create-utxos --num 20 --size 3000`. Transfers: `python3 scripts/rgb.py invoice` /
`python3 scripts/rgb.py send --amount 5 '<invoice>'` (not `kaleido asset send` – kaleido-cli 0.1.2 bug).
Never run `kaleido node clean` or `docker compose down -v` – RGB assets can't be restored from the mnemonic.

---

## For developers

- **UI:** `src/UI/index.html` plus modules in `src/UI/src/` – `kasa.ts` (backend bridge), `wallet-gate.ts`
  (Wallet card), `wallet-security.ts` (Security page), `security.ts` / `agent.ts` (Fraud Check and assistant),
  `tax-*.ts` (Commercialista).
- **Main process:** `src/main/core` (reconciliation, refunds), `src/main/rgb` (backends `wdk`, `kaleido`, `mock`),
  `src/main/security` (checks, approvals), `src/main/ai` (QVAC assistant), `src/main/db` (SQLite).
- **Wallet service:** `wallet-service/server.mjs` – one WDK wallet behind a token-protected local API, started
  and stopped by the app.
- **Agents read data through `src/main/db`** (`listInvoices`, `listPayments`, `paymentsForInvoice`,
  `listProposals`) – read-only. Amounts are raw units (`toUsdt()` in `core/units.ts`; 1 USDT = 1,000,000).
- **Total Tax card:** call `window.setTaxTotal(amount, 'EUR')` (or dispatch a `kasa:tax-total` event) from the tax code.

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
