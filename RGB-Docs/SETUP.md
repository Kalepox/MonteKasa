# Kasa setup – the app, and your own test wallet

There are two parts. You can do the first without the second.

| Part | What you get | Time | Needed for |
|---|---|---|---|
| **A. Run the app** (with a fake wallet) | Kasa opens on your laptop, with a simulated wallet | ~10 min | UI work – you can build and test every screen |
| **B. Your own test wallet** | A real RGB wallet with test BTC and test USDT | ~30 min | Real payments with the team |

Everything here is **test money with no value**. Nothing costs anything.

---

## Wallet basics (read this once)

- A **wallet** holds the keys that own your money. Ours runs on your laptop as an **RGB Lightning Node**
  inside Docker. Nobody else holds your keys – that's what *self-custodial* means.
- The **mnemonic** is a list of 12 words that *is* your wallet key. Anyone with it controls the wallet.
  Write it down once; never share it; never paste it into an app or a chat.
- **Mutinynet** is a Bitcoin **test network**. Its BTC and USDT are free and worthless – perfect for building.
- **BTC** in the wallet pays the network **fees**. **USDT** is what clients pay invoices with.
  On RGB, tokens like USDT ride on small Bitcoin outputs called **UTXOs** – think of them as envelopes.
- An **invoice** is a long text starting with `rgb:` (also shown as a QR code). The receiver creates it,
  the sender pays it. A payment takes **1–2 minutes** (one Bitcoin block plus some back-and-forth).
- The wallet is **locked** after every restart. Unlocking it with your password is like signing in.

---

## A. Run the app

### A1. Install Node.js

- **macOS:** download the **LTS** installer from https://nodejs.org (or `brew install node`).
- **Windows:** download the **LTS → Windows Installer (.msi)** from https://nodejs.org. In the installer,
  tick **"Automatically install the necessary tools"**. Then, once, in PowerShell:
  ```powershell
  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
  ```
  (Without this, PowerShell blocks `npm` with *"running scripts is disabled on this system"*.)

Check in a new terminal: `node -v` and `npm -v` both print a version.

### A2. Get the code

Clone the repo into a folder **without spaces** in its path
(e.g. `~/dev/agentic-euros` or `C:\dev\agentic-euros`), then:
```bash
cd agentic-euros
npm install
```
`npm install` takes a few minutes. Warnings about *deprecated* packages and *vulnerabilities* are normal –
**don't run `npm audit fix --force`**, it breaks the build.

> **Windows:** run the app from **PowerShell** (not from WSL/Ubuntu) – inside WSL the window has no GPU
> and is slow and ugly. The wallet node (part B) still runs in WSL; the app reaches it the same way.

### A3. Start it with a fake wallet

| macOS / Linux | Windows (PowerShell) |
|---|---|
| `RGB_MOCK=1 npm run dev` | `$env:RGB_MOCK="1"; npm run dev` |

The Kasa window opens. The status pill in the top bar says **"Mock node"**.
The fake wallet never touches the network; its data lives in a separate file (`kasa-mock.db`).

To try the whole flow without anyone paying you:
1. **New Invoice** → upload any PDF → enter a client and an amount (e.g. `10`) → **Approve & Issue**.
   A QR code and an `rgb:` invoice appear.
2. Press **F12** → **Console** and simulate the client paying 30 instead of 10:
   ```js
   const s = await kasa.snapshot(); await kasa.mockPay(s.invoices[0].recipientId, 30)
   ```
3. Within a few seconds the invoice turns **Overpaid** and a refund proposal appears. Click the invoice →
   paste any text starting with `rgb:` → **Approve refund**.

Stop the app with **Ctrl+C** in the terminal (or close the window).

### A4. Start it with your real wallet

Once you've done part B and your node is unlocked:

| macOS / Linux | Windows (PowerShell) |
|---|---|
| `npm run dev` | `Remove-Item Env:RGB_MOCK -ErrorAction SilentlyContinue; npm run dev` |

The pill should say **"Mutinynet connected"** and the Wallet page shows your real balance.

| Pill | Meaning |
|---|---|
| Mutinynet connected | All good |
| Node syncing… | The node is still unlocking/catching up – wait a few minutes |
| Node locked | Run `kaleido node unlock` |
| Node offline | Docker or the node isn't running – see the daily routine below |

If your node isn't on port 3001 (check with `kaleido node list`), start the app with
`RLN_NODE_URL=http://localhost:<port> npm run dev` (PowerShell: `$env:RLN_NODE_URL="http://localhost:<port>"; npm run dev`).

### For UI work

- The whole UI is **`src/UI/index.html`** (the old `src/UI/kasa-desktop/` folder is no longer used).
- `src/UI/src/kasa.ts` connects it to the backend. It relies on these element **ids** – keep them:
  `stat-received`, `stat-paid`, `stat-awaiting`, `stat-review`, `dash-invoices`, `inv-table`, `rv-client`,
  `rv-total`, `done-text`, `done-invoice`, `w-balance`, `w-usdt`, `w-usdt-id`, `w-btc`, `w-tx`,
  plus the modal ids (`modal`, `qvac-box`, `qvac-text`, `send-modal`, `send-amt-input`, `send-addr-input`,
  `receive-modal`, `rcv-qr-svg`, `rcv-addr-text`, `rcv-seal-info`)
- …and these function names in the page script: `issueRGB`, `executeSend`, `setReceiveAsset`, `openM`,
  `closeM`, `toast`. Renaming any of them silently disconnects that feature.
- While `npm run dev` runs, saving `index.html` reloads the window automatically.

---

## B. Your own test wallet

Run the commands from the repo root:
- **macOS:** in **Terminal** (or the VS Code terminal)
- **Windows:** in your **Ubuntu (WSL) terminal** – the wallet node runs there, the app runs in PowerShell

### B1. Install the tools

**macOS**
1. Install **Docker Desktop for Mac** from docker.com – pick **Apple Silicon** (M1–M4) or **Intel** to
   match your Mac (Apple menu → *About This Mac*). Start it and wait until it says it's running.
2. Check Docker works:
   ```bash
   docker run hello-world
   ```
3. Install Homebrew if you don't have it (https://brew.sh), then the KaleidoSwap CLI:
   ```bash
   brew install pipx
   pipx ensurepath          # then close and reopen the terminal
   pipx install kaleido-cli
   kaleido --help
   ```
4. Check Python (needed for `scripts/rgb.py`, must be 3.9 or newer): `python3 --version`.
   If macOS offers the *Command Line Developer Tools*, accept. If below 3.9: `brew install python`.

**Windows**
1. Install **Docker Desktop**. In Docker Desktop: *Settings → Resources → WSL integration* → turn on your
   Ubuntu distro → *Apply & restart*. Then in PowerShell run `wsl --shutdown` and reopen Ubuntu.
2. Check Docker works from Ubuntu: `docker run hello-world`
3. Install the KaleidoSwap CLI:
   ```bash
   sudo apt install -y pipx
   pipx ensurepath          # then close and reopen the terminal
   pipx install kaleido-cli
   kaleido --help
   ```

### B2. Create and unlock your wallet

```bash
kaleido setup              # creates the wallet node on Mutinynet, at http://localhost:3001
kaleido node init          # choose a password (8+ characters)
```
It prints your **mnemonic** (12 words). **Write it down on paper now.** Never share it.

```bash
kaleido node unlock
```
Answer the prompts like this:

| Prompt | Answer |
|---|---|
| Wallet password | the password you just chose |
| Bitcoin services profile | `S` (signet defaults = Mutinynet) |
| Chain sync | `T` (much faster after the laptop was off) |
| Lightning announce alias | Enter (skip) |
| Lightning announce address | Enter (skip) |

Check it answers:
```bash
kaleido node info
```
If it says *"Cannot call other APIs while node is changing state"*, it's still syncing. Wait a few
minutes and try again. **Don't run `unlock` a second time.**

If `kaleido node list` shows your node on a port other than 3001, add `--node http://localhost:<port>`
to every `scripts/rgb.py` command below.

### B3. Get test BTC (for fees)

```bash
kaleido wallet address
```
1. Open **https://faucet.mutinynet.com** in your browser and log in with GitHub.
2. Paste **your** address, request **500000** sats, click *Make it rain*.
   (Don't use the `tb1q…` address printed on the faucet page – that's the faucet's own.)
3. After ~1 minute: `kaleido wallet balance` → `vanilla` ≈ 500000.

### B4. Create UTXOs (the "envelopes" for USDT)

Every invoice reserves one, so make a stock of them:
```bash
kaleido wallet create-utxos --num 20 --size 3000
kaleido wallet balance   # colored ≈ 60000 after the next block
```
To top up later without overshooting: `kaleido wallet create-utxos --up-to --num 20 --size 3000`.

### B5. Get test USDT

Your wallet doesn't know the USDT asset yet, so the first invoice must accept **any asset**:
```bash
python3 scripts/rgb.py invoice
```
1. Open **https://faucet.mutinynet.kaleidoswap.com**, log in with GitHub.
2. Tab **RGB on-chain** (not the Lightning tabs) → paste the invoice → select **USDT** → *Send asset*.
3. Check every ~30 s until it shows up:
   ```bash
   python3 scripts/rgb.py status
   ```
   You should end with `USDT settled 100.0 spendable 100.0`.

If the faucet says its node is locked, that's their side – try later, or ask a teammate to send you USDT
(B6 with you as receiver).

### B6. Send USDT to a teammate

**Receiver** creates an invoice (if your wallet has never had USDT, leave out `--amount`):
```bash
python3 scripts/rgb.py invoice --amount 5
```
and sends the full `rgb:…` string to the sender. It must end with `&endpoints=rpcs://…` – if not,
make a new one.

**Sender**:
```bash
python3 scripts/rgb.py send --amount 5 'rgb:...paste the full invoice...'
```

**Both** then run, every ~30 s, until the transfer shows `Settled`:
```bash
python3 scripts/rgb.py status
```
Order matters: the **receiver** refreshes first (accepts), then the **sender** (broadcasts), then both
after a block. Both wallets must be running and unlocked.

---

## Rules

- **The only USDT we use** is KaleidoSwap's Mutinynet USDT:
  `rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0` (precision 6).
  Another token named "USDT" with a different ID is a different asset – transfers to it get rejected.
  `rgb.py send` refuses those invoices for you.
- **Always wrap invoices in single quotes** in the terminal. They contain `&`, which breaks the command
  otherwise.
- **Amounts:** `scripts/rgb.py` and the app take USDT (`5` = 5 USDT). The `kaleido` CLI takes raw units
  (`5000000` = 5 USDT).
- **Use `scripts/rgb.py`, not `kaleido asset send`.** `kaleido-cli` 0.1.2 has a bug and fails with
  *"neither a blinded UTXO or a script"*. `kaleido asset invoice` also can't make any-asset invoices.
- **One payment at a time.** While a send is unsettled, your USDT is locked (*"Not enough assets"*).
- **Shell variables vanish** when you close the terminal. Before a command with `$C` or `$USDT`, check
  `echo $C` – an empty variable makes the command hit your default wallet instead.
- **Never run `kaleido node clean` or `docker compose down -v`.** They delete your wallet's data. BTC can
  be recovered from the mnemonic, **RGB assets cannot**.

## Daily routine

After your laptop was off (or after closing Docker Desktop):
1. Start **Docker Desktop** (on macOS it doesn't start with the system unless you enable that).
2. `kaleido node up default`
3. `kaleido node unlock` once, then wait for `kaleido node info` to answer.
4. Start the app: `npm run dev` (part A4).

Before shutting down (optional, but cleaner): `kaleido node stop default`.

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `running scripts is disabled on this system` (Windows) | Run the `Set-ExecutionPolicy` line from A1. |
| App crashes mentioning `better-sqlite3` / `NODE_MODULE_VERSION` | Run `npx electron-builder install-app-deps`. If the path has spaces, move the repo to one without. |
| Pill says "Node offline" | Docker isn't running or the node is stopped – see the daily routine. |
| `Cannot call other APIs while node is changing state` | Wallet is still unlocking/syncing. Wait; don't unlock again. |
| `Unknown RGB contract ID` | Your wallet has never received this asset. Use `rgb.py invoice` without `--amount`. |
| `Not enough assets` | A previous send hasn't settled yet, or your balance is too low. |
| Invoice creation fails | No free UTXOs left: `kaleido wallet create-utxos --up-to --num 20 --size 3000`. |
| Send stays `WaitingCounterparty` | The receiver hasn't refreshed, or the invoice had no `&endpoints=` part. |
| Send ends as `Failed` | The receiver rejected it – usually a wrong asset or network. Ask for a new invoice. |
| `docker: command not found` | Docker Desktop isn't running. On Windows, also check WSL integration. |
| `kaleido: command not found` | Run `pipx ensurepath` and open a new terminal. |
