# MonteKasa

**Self-custodial invoicing for Italian freelancers and small agencies, paid in USDT on Bitcoin via RGB —
with local AI agents that catch payment problems and work out the tax.**

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
the tax are all manual. MonteKasa is a desktop app that issues an **RGB invoice for USDT on Bitcoin**,
watches for the payment, **reconciles it automatically** (paid / underpaid / overpaid / expired) and lets
three **local QVAC agents** help the merchant:

- **Fraud Controller** – flags wrong amounts, duplicates, tampered PDFs and proposes an action (e.g. a refund).
- **Commercialista** – records the EUR value at receipt and the gain/loss when USDT is converted, and keeps a
  running "set aside for tax" figure (Italian rules 2026: 33 % on crypto gains, IVCA, Quadro RW).
- **Wildcard** – a third agent slot, chosen during the event (e.g. collections for unpaid invoices).

Design rule: **agents propose, the merchant approves, code executes.** No agent moves money. Everything runs
on the merchant's laptop; keys never leave it; only settlement touches the network.

---

## Stack

| Layer | Technology |
|---|---|
| Desktop app | Electron 39 + TypeScript (electron-vite), UI in plain HTML/CSS/JS |
| RGB payments | KaleidoSwap **RGB Lightning Node** (Docker) via `kaleido-sdk` 0.1.23, on **Mutinynet** (Bitcoin signet) |
| Wallet | Tether **WDK** – `@utexo/wdk-wallet-rgb` in `wallet-service/` (Node 22), enabled with `RGB_BACKEND=wdk` |
| Local AI | **QVAC SDK** (planned, see below) |
| Storage | SQLite via `better-sqlite3`, with schema migrations |
| Tests | Vitest |
| Test funds | Mutinynet BTC faucet, KaleidoSwap RGB faucet (test USDT `rgb:lX~ToKsO-…E9PA_h0`) |

---

## Prior work (built before the event)

Built **before 17 October 2026** (full history in the git log, from 8 October):

- **Docs & design:** project proposal (`RGB-Docs/`) and a static UI prototype (`src/UI/index.html`) –
  most of its screens still show demo data.
- **Boilerplate:** Electron + TypeScript skeleton, SQLite storage, and a basic RGB payment layer on a
  KaleidoSwap test node (`src/main/rgb`, with a mock for development).
- **Payment logic:** rule-based invoice reconciliation (paid / under / overpaid / expired, unit-tested)
  and a simple refund proposal, wired to the prototype UI (`src/main/core`, `src/UI/src/kasa.ts`).
- **Tooling:** `scripts/rgb.py`, a terminal helper for test transfers.

**What is installed and working right now**
- Project files and DB infastructure has been made to focus on Requiered Stack
- Two RGB nodes on Mutinynet, funded with test BTC and test USDT.
- The app runs on macOS (Apple Silicon), Windows and Linux, against the real node or the mock.

**Not built yet – the hackathon work**
- RGB: Complete RGB Transactions through UI between 2 parties, BTC fuel additon through UI
- QVAC: Invoice extraction from PDFs (currently simulated) and the three agents for financial assistance.
- WDK wallet will be created inside the app (no terminal, no Docker) – only if issuing our own test asset on
  Mutinynet works with `wdk-wallet-rgb`; otherwise the KaleidoSwap node stays the backend.
- EUR price feed, Commercialista tax figures, in-app onboarding / lock screen, the Wildcard agent.

---

## Run the app

### 1. Install Node.js
- **macOS:** LTS installer from https://nodejs.org (or `brew install node`).
- **Windows:** LTS **Windows Installer (.msi)** from https://nodejs.org; tick *"Automatically install the
  necessary tools"*. Then once in PowerShell:
  `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

Check: `node -v` and `npm -v` print a version.

### 2. Install
Clone into a path **without spaces**, then:
```bash
npm install
```
Warnings about deprecated packages or vulnerabilities are normal – don't run `npm audit fix --force`.

### 3. Start with a fake wallet (no setup needed)

| macOS / Linux | Windows (PowerShell) |
|---|---|
| `RGB_MOCK=1 npm run dev` | `$env:RGB_MOCK="1"; npm run dev` |

The status pill says **"Mock node"**. To try the whole flow:
1. **New Invoice** → upload any PDF → enter a client and `10` → **Approve & Issue** → a QR code appears.
2. **F12 → Console**, simulate the client paying 30:
   ```js
   const s = await kasa.snapshot(); await kasa.mockPay(s.invoices[0].recipientId, 30)
   ```
3. The invoice turns **Overpaid** → click it → paste any `rgb:` text → **Approve refund**.

### 4. Start with the in-app wallet (WDK) – main way to run
The wallet runs inside the app (Tether WDK, `@utexo/wdk-wallet-rgb`) – no Docker, no Kaleido node.
It needs **Node 22** for the wallet service (install with [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`).

One time, install the wallet service:
```bash
cd wallet-service && npm install && cd ..
```

Start:
```bash
RGB_BACKEND=wdk WALLET_NODE=$(nvm which 22) npm run dev
```

Create the wallet on the **Wallet** page (password 8+ characters, write down the 12 words), or from
**F12 → Console**:
```js
await kasa.wallet('unlock', { password: '<your password>' })     // after every app start
await kasa.wallet('address')                                       // fund it at https://faucet.mutinynet.com
await kasa.wallet('createUtxos', { num: 10, size: 3000 })          // once the BTC has arrived
```

### 5. Start with the KaleidoSwap node (alternative)
With your node running and unlocked (see below): `npm run dev`
(PowerShell: `Remove-Item Env:RGB_MOCK -ErrorAction SilentlyContinue; npm run dev`).
The pill should say **"Mutinynet connected"**.

| Pill | Meaning |
|---|---|
| Mutinynet connected | All good |
| Node syncing… | Still unlocking / catching up – wait |
| Node locked | `kaleido node unlock` |
| Node offline | Docker or the node isn't running |

Other port: `RLN_NODE_URL=http://localhost:<port> npm run dev`.
Run tests: `npm test`.

---

## Your own test wallet (Mutinynet)

Everything is **test money with no value**. On Windows run these in **Ubuntu (WSL)**; on macOS in Terminal.

**Wallet basics:** the wallet runs as an RGB Lightning Node in Docker. The **mnemonic** (12 words) *is* your
key – write it down, never share it. **BTC** pays fees; **USDT** is what clients pay with; RGB tokens ride on
small Bitcoin outputs (**UTXOs**). An **invoice** is an `rgb:…` string; a payment takes 1–2 minutes.

1. **Tools**
   - macOS: Docker Desktop (Apple Silicon/Intel), then `brew install pipx && pipx ensurepath && pipx install kaleido-cli`
   - Windows: Docker Desktop with *WSL integration* on, then in Ubuntu `sudo apt install -y pipx && pipx ensurepath && pipx install kaleido-cli`
   - Check: `docker run hello-world`, `kaleido --help`, `python3 --version` (≥ 3.9)
2. **Create & unlock**
   ```bash
   kaleido setup && kaleido node init     # write down the mnemonic
   kaleido node unlock                    # S (signet) → T (transaction sync) → Enter → Enter
   kaleido node info                      # answers when ready; don't unlock twice
   ```
3. **Test BTC:** `kaleido wallet address` → https://faucet.mutinynet.com (GitHub login) → 500000 sats.
4. **UTXOs:** `kaleido wallet create-utxos --num 20 --size 3000`
5. **Test USDT:** `python3 scripts/rgb.py invoice` → https://faucet.mutinynet.kaleidoswap.com → tab
   **RGB on-chain** → paste → USDT → *Send asset*. Check with `python3 scripts/rgb.py status`.
6. **Send to a teammate:** receiver `python3 scripts/rgb.py invoice --amount 5`; sender
   `python3 scripts/rgb.py send --amount 5 '<invoice>'`; both run `status` until `Settled`
   (receiver refreshes first, then sender).

**Daily routine:** start Docker Desktop → `kaleido node up default` → `kaleido node unlock` (once) →
`npm run dev`.

### Rules
- Only use KaleidoSwap's Mutinynet USDT `rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0`
  (precision 6). Another "USDT" with a different ID is a different asset.
- Wrap invoices in **single quotes** (they contain `&`). An invoice must end with `&endpoints=rpcs://…`.
- `rgb.py` and the app take USDT (`5`); the `kaleido` CLI takes raw units (`5000000`).
- Use `scripts/rgb.py`, not `kaleido asset send` (kaleido-cli 0.1.2 bug).
- One send at a time – unsettled sends lock your USDT ("Not enough assets").
- Never run `kaleido node clean` or `docker compose down -v` – RGB assets can't be restored from the mnemonic.

### Troubleshooting

| Message | Fix |
|---|---|
| `running scripts is disabled` (Windows) | `Set-ExecutionPolicy` line above |
| App crashes about `better-sqlite3` | `npx electron-builder install-app-deps`; repo path without spaces |
| `Cannot call other APIs while node is changing state` | Still unlocking – wait |
| `Unknown RGB contract ID` | First receive: `rgb.py invoice` without `--amount` |
| `Not enough assets` | A previous send hasn't settled |
| Invoice creation fails | `kaleido wallet create-utxos --up-to --num 20 --size 3000` |
| Send stays `WaitingCounterparty` | Receiver hasn't refreshed, or the invoice had no `&endpoints=` |
| Send ends `Failed` | Receiver rejected it (wrong asset/network) – ask for a new invoice |

---

## For developers

- **UI:** `src/UI/index.html` is the only UI file. `src/UI/src/kasa.ts` connects it to the backend and relies
  on these ids: `stat-received`, `stat-paid`, `stat-awaiting`, `stat-review`, `dash-invoices`, `inv-table`,
  `rv-client`, `rv-total`, `done-text`, `done-invoice`, `w-balance`, `w-usdt`, `w-usdt-id`, `w-btc`, `w-tx`,
  the modal ids (`modal`, `qvac-box`, `qvac-text`, `send-modal`, `send-amt-input`, `send-addr-input`,
  `receive-modal`, `rcv-qr-svg`, `rcv-addr-text`, `rcv-seal-info`) and the functions `issueRGB`,
  `executeSend`, `setReceiveAsset`, `openM`, `closeM`, `toast`.
- **Agents (QVAC):** read data through `src/main/db` (`listInvoices`, `listPayments`, `paymentsForInvoice`,
  `listProposals`) from the main process – read-only. Amounts are raw units (`toUsdt()` in `core/units.ts`).
- **Database file:** `<app data>/kasa.db` (`kasa-mock.db` in mock mode) – macOS
  `~/Library/Application Support/<app>/`, Windows `%APPDATA%\<app>\`, Linux `~/.config/<app>/`.

## Payment checks and assistant explanations

The default `SignetCustom` configuration uses the verified Mutinynet profile for both
`npm run dev` and packaged launches: node indexer
`https://esplora.signet.kaleidoswap.com`, reference `https://mutinynet.com/api`, and
checkpoint height `100000` with hash
`00000166f046342c6b499798686eb13cd2b4c6e5fd4189157922dca54705eb71`.
These are test-network settings. Explicit environment overrides remain supported;
other networks require their own trusted indexer/checkpoint configuration. Invalid
configuration is shown in the node status tooltip and still blocks payment review.

The assistant shows payment details separately from expandable technical evidence.
Questions such as “Were there warnings on my last payment of 10 USDT?” select the
latest matching outgoing submission; ambiguous requests ask you to select a record.
Payment conclusions come from recorded checks, not model-generated safety verdicts.
A settled transfer does not establish recipient identity or absence of fraud.
Evidence timestamps and resolved notices remain visible. Earlier overwritten
findings cannot be reconstructed; new changes preserve a bounded check history.

Open-amount RGB invoices accept positive amounts; fixed invoices still require an
exact match. Every submission still requires review and confirmation. Unknown
submission outcomes and duplicate recipients remain blocked against blind retries.
