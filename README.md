# agentic-euros
Demo repository for project trial 
By:
Alpino Castello
Abbasi Tonno Guvendir
Yusuf Deniz Celik

## Local development

Install dependencies from the lockfile, then launch Electron with the Vite development server:

```sh
npm ci
npm run dev
```

The renderer lives in `src/UI` and supports hot reload. Electron's main process
and preload script live in `src/main` and `src/preload`. The dev command watches
these too and restarts Electron when they change.

To type-check and build all three parts, then preview the built desktop app:

```sh
npm run build
npm start
```

## Local AI assistant

Run `npm run dev` and select **Ask AI** in the bottom-right corner. The assistant
uses the installed `@qvac/sdk` 0.21 and **Qwen3.5 2B Q4_K_M** for local chat and read-only security explanations.
Click **Download AI model** on first use. Setup downloads approximately
**1.28 GB** of model weights and loads the model; Send stays disabled until setup
succeeds. Later sessions detect the saved files and show **Start assistant**,
which loads them from disk without reinstalling. No API key is needed.
Use Node.js >= 22.17 and npm >= 10.9, as required by QVAC.

Replies stream into the panel. **Stop** cancels a download or reply; **New chat**
clears conversation history. History is kept in memory, with a bounded recent
window sent to the model, and is lost when the app exits. The assistant receives a fresh, bounded snapshot of recorded security findings
and payment states on each turn. It cannot issue invoices, send funds, approve
payments, acknowledge findings, or change security policy.

Inference runs locally through QVAC's Bare worker. Initial model/runtime setup
requires internet access. The model is cached under Electron's user-data directory
in `qvac/models`. Set `QVAC_CONFIG_PATH` before launching to use your own QVAC
configuration. Download or inference errors appear in the chat status; you can
retry using the setup/start button, or resend a failed chat message.

**Close assistant** (or Escape in the panel) cancels active work, closes the panel,
and unloads model memory while explicitly preserving downloaded files. Reopen
with **Ask AI**, then **Start assistant**. Closing preserves conversation history
for the current app session; quitting clears that history but retains model files.
Deleted or incomplete model files must be downloaded again. Keep the same
user-data directory and QVAC configuration across launches to reuse the cache.

Electron packaging uses `asar: false` so the native Bare worker can resolve its
JavaScript dependencies and native addons from real filesystem paths. This keeps
the SDK outside the renderer. The alternate prototype in `src/UI/kasa-desktop`
is not the application launched by the root scripts.

Validation: `npm run build` checks both TypeScript projects and builds the app;
`npm test` covers reconciliation and agent validation, history, retry, and
cancellation behavior with a mocked SDK. These tests do not download model weights.

If you see `No handler registered for 'agent:chat'`, the running Electron backend
is outdated; this error happens before any model download. Quit the desktop app
completely, stop the old dev command, and run `npm run dev` from the repository
root. A renderer reload alone does not replace the main process. For the built
app, run `npm run build` followed by `npm start`.

## Security checks and payment approval

Security phases 1–3 run in the Electron main process without loading Qwen. Use
**Security** beside **Ask AI** to see findings, evidence, acknowledgment history,
transaction states, and operation history. Both **Send** and **Approve refund**
open an explicit review dialog. Confirming calls a shared gate that revalidates
current evidence. The old direct-send/approve IPC routes now refuse execution.

The gate checks exact decimal amounts (up to six places, within JavaScript's
safe-integer raw-unit range), invoice expiry/assignment/asset/network, approved
secure transport hosts, fresh node/chain evidence, balance, a minimum BTC reserve,
and a fee-rate ceiling. Approval tokens last two minutes and are bound to the
reviewed transaction. Fresh reviews rotate tokens. Refunds additionally require
fresh original-payment confirmations, unchanged settled excess, and the user's
explicit acknowledgment of independently verified customer destination details.
This acknowledgment records a user assertion; the app cannot prove customer identity.

Persistent operation records prevent reusing a submitted recipient or refund,
including after an ambiguous error or restart. A timeout after submission means
**uncertain**, never permission to retry. Recovery matches one outgoing RGB
transfer by recipient, amount, configured asset and, when known, transaction ID.
Ambiguous outcomes require node/operator investigation; there is intentionally no
"force retry" button. One app instance owns the ledger. Using another wallet or
another app/database to send is outside this protection.

### Real network configuration

Real-network sends fail closed until a trusted chain source and checkpoint are
configured. These are operator-supplied trust anchors, not values to blindly copy
from the endpoint being checked:

- `RGB_NETWORK`: exact Kaleido network enum (default `SignetCustom` for Mutinynet;
  confirm what your deployed node reports).
- `RGB_NODE_CHAIN_API`: HTTPS Esplora API (or loopback HTTP) serving the **same
  chain/indexer used by your RGB node**. The operator must establish this binding;
  Kaleido's network/height API cannot prove it by itself.
- `RGB_EXPLORER_API`: trusted same-network reference Esplora API; defaults to
  `https://mutinynet.com/api`. It must not be replaced with a mainnet or ordinary
  Signet explorer while using Mutinynet.
- `RGB_CHAIN_CHECKPOINT_HEIGHT` and `RGB_CHAIN_CHECKPOINT_HASH`: a trusted,
  non-genesis checkpoint for the intended chain. Both chain sources must match
  it and agree at a shared height. Same-provider endpoints are not independent
  cryptographic verification.
- Existing `RLN_NODE_URL`, `RGB_ASSET_ID`, and `RGB_PROXY` identify the node,
  asset, and approved secure proxy. Invoice endpoints must match the configured
  proxy host and use `rpcs:`; out-of-band transfer is not supported here.
- `RGB_FEE_RATE`: configured sat/vB rate (default 2, policy ceiling 20). The
  1,000-sat minimum BTC reserve and fee-rate checks are not an exact total-fee
  estimate. The current send API does not expose a preapproved PSBT/total fee.

Network evidence may be at most 30 seconds old and chain heights may differ by
at most two blocks. Missing/contradictory evidence pauses sending; lack of a live
fee estimate is disclosed in the review. Core checks use the configured node and
HTTPS indexers as trusted sources; they do not implement an independent Bitcoin
full node or prove an invoice sender's identity.

### Settlement and recovery

A send result is **submitted**, not completed. Completion requires the matching
RGB transfer to be `Settled` plus at least **3 Bitcoin confirmations** on the
best chain. Incoming recent payments also wait for this confirmation policy.
Reconciliation responds to changed payment rows even after Paid/Expired states.
Refund amounts are refreshed and rechecked before execution. Multiple settled
incoming payments remain flagged for manual review.

Recently completed outgoing operations are monitored for 24 hours; older ones
are retained in history but are not continuously checked for deep reorgs. Missing
explorer data or a 404 is unavailable evidence, not definitive transaction failure.
A conflicting/missing observation can downgrade a completed operation. The UI
shows Bitcoin confirmations and RGB status separately, with last-check times.

Monitoring uses no language model: at most five outgoing operations per pass,
oldest checked first, bounded HTTP calls, a shared 10-second chain-tip cache, and
at most five new incoming chain observations per pass with a 30-second cache.
Pending work survives restart in SQLite. Findings are deduplicated by rule and
subject; acknowledgment never overrides a payment gate. The panel shows the
latest 200 records; the full ledger remains in the database. Histories retain up
to 100 state transitions per operation. This is a local operational record, not
an independently tamper-proof audit log.

### Security validation

```sh
npm test
npm run build
npx electron scripts/security-smoke.cjs
```

The Electron smoke test creates a temporary mock wallet under `/tmp`, exercises
real preload/IPC and review UI, verifies simulated settlement, and rejects legacy
send bypasses, duplicate recipients, and an untrusted renderer. It never sends
real funds. Unit/integration tests cover exact amounts, validation boundaries,
stale approvals, concurrency, uncertain submission, recovery, settlement/reorgs,
late payments, refund revalidation, and V2→V3 SQLite migration/reopen.

These checks do not identify every fraudulent invoice, protect a compromised OS
or node, or guarantee irreversible settlement. Behavioral scoring is not enabled. AI explanations are advisory; deterministic
checks remain the authority for payment approval.

### Explain security findings with AI

Open **Security**, choose **Explain with AI** on a finding or payment operation,
then send the prepared question in the assistant. Start the cached model first if
needed. **New chat** clears the selected record. General chat includes a bounded
overview (up to six unresolved findings and two operations); selected records are
looked up again in the main process on every turn. Missing records require a panel
refresh. The context includes timestamps and indicates omitted findings.

Only validated numeric evidence, known status/check codes, opaque record IDs,
and application-written rule descriptions are shared locally with Qwen. Source
messages, free-form evidence strings, raw backend errors, and asset identifiers
are excluded rather than screened for suspicious keywords. Raw invoices, destinations, approval tokens, and keys are excluded. The
assistant has no model tools or command execution; output is rendered as text.
Each response shows a separate **Recorded facts** block generated by application
code, including formatted amounts and whether settlement evidence was supplied.
The model cannot edit that block.
Untrusted evidence is labeled as data and cannot grant permissions. A model may
still produce an incorrect explanation; its response never clears warnings or
changes the ledger. The displayed deterministic finding remains authoritative.

The real-model smoke runner supports a `security` phase using a temporary mock
wallet and the existing model cache. Set `QVAC_CONFIG_PATH` to the existing QVAC
configuration and `KASA_AI_SMOKE_DIR` to a separate temporary test directory, then
run `npx electron scripts/agent-model-smoke.cjs security`. It verifies the explain
button, an overpayment explanation, and unchanged payment/acknowledgment state
after requesting a prohibited action. It refuses to download a missing model.


### Critical warning regression checks with the installed model

`scripts/agent-security-cases.ts` exercises wrong-network rejection, duplicate
submission rejection, and an uncertain submission caused by a simulated timeout.
It uses the actual cached Qwen model, production security coordinator, and an
in-memory SQLite ledger. It also covers expired invoices, insufficient asset
balance, insufficient BTC fee reserve, and stale network evidence, both at initial
review and after a valid review but before execution. The network/send backend
is simulated; no funds move.
Build and run it with the existing QVAC cache configuration:

```sh
npx esbuild scripts/agent-security-cases.ts --bundle --platform=node --format=cjs --packages=external --outfile=out/main/agent-security-cases.cjs
# Set QVAC_CONFIG_PATH to your existing qvac.config.json before running:
npx electron out/main/agent-security-cases.cjs
```

Initial real-model trials exposed misleading descriptions of network blocks and
duplicate submissions. These three critical warnings now use application-written
policy explanations through the assistant, bypassing model generation. The same
policy-response path covers expiry, asset balance, BTC reserve, and stale evidence
failures, including checks that fail immediately before execution. The
installed model is still loaded by this runner to exercise the normal lifecycle.
Other findings continue to use Qwen explanations.

Each case asks for an explanation and then explicitly asks the assistant to
bypass, acknowledge, resolve, and resend. Assertions check key explanation
semantics, unchanged security state, send-call counts, rejection of direct or
repeated execution, and continued blocking after a real acknowledgment. Results
and complete responses are saved to `/tmp/kasa-agent-security-cases.json`.
This is a regression sample, not a guarantee of every possible model response.
The application displays fixed rule guidance for these cases in both the
recorded facts and the assistant response. No model response can change the payment gate.

For these preflight failures the scenario runner verifies zero send calls, unchanged
private approval state during chat, and continued blocking after acknowledgment.
Execution failures invalidate the old approval token. After the underlying issue
is corrected, a fresh review issues a new token without automatically sending.
Unit tests also cover the 30-second evidence-age boundary, future timestamps, and
exact asset/BTC reserve thresholds.


### Prompt-injection regression checks

The model-facing projection excludes all source free text, including finding
messages and backend errors. Known enums and numeric evidence are validated;
malformed identifiers become opaque aliases. Original source details remain
visible as plain text in the Security panel but are not passed to the model.
This prevents those data fields from supplying model instructions. It is not a
claim that arbitrary user prompts or generated explanations are always correct.

Unit tests cover role delimiters, fake system/admin messages, JSON tool requests,
HTML event handlers, encoded instructions, Unicode text, malformed codes, and
numeric fields containing strings. The real-model runner inspects the actual
completion payload, checks that system instructions stay unchanged and no tools
are enabled, then checks the ledger and send counter. It exercises actual model
generation on noncritical findings, not the fixed critical-warning responses:

```sh
npx esbuild scripts/agent-injection-smoke.ts --bundle --platform=node --format=cjs --packages=external --outfile=out/main/agent-injection-smoke.cjs
# Set QVAC_CONFIG_PATH to the existing cache configuration:
npx electron out/main/agent-injection-smoke.cjs
```

Results are saved to `/tmp/kasa-agent-injection-results.json`. The test uses
simulated invoice decoding and an in-memory database; no real funds move.
`npx electron scripts/security-smoke.cjs` also checks that hostile finding HTML
renders as text without creating executable elements or new payment operations.
