# RGB setup – your own node on Mutinynet

This gets you a working RGB wallet (an RGB Lightning Node) with test BTC and test USDT,
so you can send and receive USDT with the rest of the team.

Everything here is **test money with no value**. Mutinynet is a Bitcoin test network.

Run every command from the repo root (the folder you cloned, e.g. `~/kasa`):
- **Windows:** in your **Ubuntu (WSL) terminal**
- **macOS:** in **Terminal** (or the VS Code terminal)

Everything after step 1 is the same on both.

---

## 1. Install the tools

### macOS

1. Install **Docker Desktop for Mac** from docker.com – pick **Apple Silicon** (M1–M4) or **Intel** to
   match your Mac (Apple menu → *About This Mac*). Start it and wait until it says it's running.
   The node image supports both chips natively.
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
4. Check Python (needed for `scripts/rgb.py`, must be 3.9 or newer):
   ```bash
   python3 --version
   ```
   If macOS offers to install the *Command Line Developer Tools*, accept – that provides `python3`.
   If the version is below 3.9: `brew install python`.

### Windows

1. Install **Docker Desktop** on Windows.
   In Docker Desktop: *Settings → Resources → WSL integration* → turn on your Ubuntu distro → *Apply & restart*.
   Then in PowerShell run `wsl --shutdown` and reopen Ubuntu.
2. Check Docker works from Ubuntu:
   ```bash
   docker run hello-world
   ```
3. Install the KaleidoSwap CLI:
   ```bash
   sudo apt install -y pipx
   pipx ensurepath          # then close and reopen the terminal
   pipx install kaleido-cli
   kaleido --help
   ```

## 2. Create and unlock your node

```bash
kaleido setup              # creates a node on Mutinynet, API on http://localhost:3001
kaleido node init          # choose a password (8+ chars)
```
**Write down the mnemonic it prints.** It's the key to your test wallet. Never share it, never reuse
someone else's.

```bash
kaleido node unlock
```
Answer the prompts like this:

| Prompt | Answer |
|---|---|
| Bitcoin services profile | `S` (signet defaults = Mutinynet) |
| Chain sync | `T` (transaction sync via the indexer – much faster after the laptop was off) |
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

## 3. Get test BTC (for fees)

```bash
kaleido wallet address
```
1. Open **https://faucet.mutinynet.com** in your browser and log in with GitHub.
2. Paste **your** address, request **500000** sats, click *Make it rain*.
   (Don't use the `tb1q…` address printed on the faucet page – that's the faucet's own.)
3. After ~1 minute:
   ```bash
   kaleido wallet balance   # vanilla ≈ 500000
   ```

## 4. Create UTXOs for RGB

RGB tokens sit on small Bitcoin outputs ("envelopes"). Every invoice you create reserves one, so make
a stock of them:
```bash
kaleido wallet create-utxos --num 20 --size 3000
kaleido wallet balance   # colored ≈ 60000 after the next block
```
To top up later without overshooting: `kaleido wallet create-utxos --up-to --num 20 --size 3000`.

## 5. Get test USDT

Your node doesn't know the USDT asset yet, so the first invoice must accept **any asset**:
```bash
python3 scripts/rgb.py invoice
```
1. Open **https://faucet.mutinynet.kaleidoswap.com**, log in with GitHub.
2. Tab **RGB on-chain** → paste the invoice → select **USDT** → *Send asset*.
3. Check every ~30 s until it shows up:
   ```bash
   python3 scripts/rgb.py status
   ```
   You should end with `USDT settled 100.0 spendable 100.0`.

## 6. Send USDT to a teammate

**Receiver** creates an invoice:
```bash
python3 scripts/rgb.py invoice --amount 5
```
and sends the full `rgb:…` string to the sender.

**Sender**:
```bash
python3 scripts/rgb.py send --amount 5 'rgb:...paste the full invoice...'
```

**Both** then run, every ~30 s, until the transfer shows `Settled`:
```bash
python3 scripts/rgb.py status
```
Both sides must refresh: the receiver accepts the transfer, the sender then broadcasts it, then it
waits for one block (~30 s). A payment usually settles in 1–2 minutes.

---

## Rules

- **The only USDT we use** is KaleidoSwap's Mutinynet USDT:
  `rgb:lX~ToKsO-Iup7dJ5-UM794sA-9WD21ge-VHYzBGb-E9PA_h0` (precision 6).
  Another token named "USDT" with a different ID is a different asset – transfers to it get rejected.
  `rgb.py send` refuses those invoices for you.
- **Always wrap invoices in single quotes** in the terminal. They contain `&`, which breaks the command
  otherwise.
- **Amounts:** `scripts/rgb.py` takes USDT (`--amount 5` = 5 USDT). The `kaleido` CLI takes raw units
  (`5000000` = 5 USDT).
- **Use `scripts/rgb.py`, not `kaleido asset send`.** `kaleido-cli` 0.1.2 has a bug: it passes the whole
  invoice as the recipient and fails with *"neither a blinded UTXO or a script"*. `kaleido asset invoice`
  also can't make any-asset invoices.
- **One payment at a time.** While a send is unsettled, your USDT is locked (*"Not enough assets"*).
  Wait for `Settled` before the next send.
- **Never run `kaleido node clean` or `docker compose down -v`.** They delete your node's data. BTC can be
  recovered from the mnemonic, **RGB assets cannot**.

## Daily routine

After your laptop was off (or after closing Docker Desktop):
1. Start Docker Desktop (on macOS it doesn't start with the system unless you enable that in its settings).
2. `kaleido node up default`
3. `kaleido node unlock` once, then wait for `kaleido node info` to answer.
4. `python3 scripts/rgb.py status`

Before shutting down (optional, but cleaner): `kaleido node stop default`.

## Troubleshooting

| Message | Meaning / fix |
|---|---|
| `Cannot call other APIs while node is changing state` | Node is still unlocking/syncing. Wait; don't unlock again. |
| `Unknown RGB contract ID` | Your node has never received this asset. Use `rgb.py invoice` without `--amount` (any asset). |
| `Not enough assets` | A previous send hasn't settled yet, or your balance is too low. |
| Invoice creation fails | No free UTXOs left. Run `kaleido wallet create-utxos --up-to --num 20 --size 3000`. |
| Send ends as `Failed` | The receiver rejected it – usually a wrong asset or network. Ask for a new any-asset invoice. |
| `docker: command not found` | Docker Desktop isn't running. On Windows, also check WSL integration is on for your distro. |
| `kaleido: command not found` | Run `pipx ensurepath` and open a new terminal. |
