with open('src/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Update Dashboard Stats to highlight Commercialista Set-Aside & 3 Agents
old_dash_grid = """        <div class="sgrid">
          <div class="sc"><div class="sc-l">Received</div><div class="sc-v cb">4,850 USDT</div></div>
          <div class="sc"><div class="sc-l">Paid Invoices</div><div class="sc-v cg">7</div></div>
          <div class="sc"><div class="sc-l">Awaiting Payment</div><div class="sc-v cr">2</div></div>
          <div class="sc qvac-hook">
            <div class="qvac-label">QVAC: Flags</div>
            <div class="sc-l">Pending Review</div><div class="sc-v ca">2</div>
          </div>
        </div>"""

new_dash_grid = """        <!-- Kasa v2 Primary Stat Metrics -->
        <div class="sgrid">
          <div class="sc">
            <div class="sc-l">Treasury Balance</div>
            <div class="sc-v cb">2,450 USDT</div>
            <div class="sc-s">&asymp; €2,263.80 &middot; WDK Self-Custodial</div>
          </div>
          <div class="sc" style="border-color:rgba(251,191,36,0.3); background:rgba(251,191,36,0.04);">
            <div class="sc-l" style="color:var(--amber);">Commercialista Tax Set-Aside</div>
            <div class="sc-v ca" style="color:var(--amber);">€ 412.80</div>
            <div class="sc-s">2026 Substitute Tax (33%) &middot; Estimate</div>
          </div>
          <div class="sc">
            <div class="sc-l">Reconciled Invoices</div>
            <div class="sc-v cg">7 Paid</div>
            <div class="sc-s">2 Awaiting Settlement &middot; RGB UTXOs</div>
          </div>
          <div class="sc" style="border-color:rgba(96,165,250,0.3); background:rgba(96,165,250,0.04);">
            <div class="sc-l" style="color:var(--blue);">Active Agent Proposals</div>
            <div class="sc-v" style="color:var(--blue);">3 Pending</div>
            <div class="sc-s">Agents Propose &middot; Merchant Approves</div>
          </div>
        </div>

        <!-- 3-Minute Hackathon Demo Script Quick Beats Bar -->
        <div style="background:var(--c2); border:1px solid var(--borderB); border-radius:var(--r4); padding:10px 14px; margin-bottom:20px; display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:12px;">🎙️</span>
            <span style="font-size:11px; font-weight:700; color:var(--t1); text-transform:uppercase; letter-spacing:0.5px;">Hackathon Demo Script</span>
            <span class="badge b-paid" style="font-size:9px;">3-Min Beats</span>
          </div>
          <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-s xs" onclick="go('new'); loadSampleInvoice();" title="Beat 1: Draft Order">1. Draft PDF</button>
            <button class="btn btn-s xs" onclick="demoBeatPayAndBook();" title="Beat 2: Pay & Book">2. Pay &amp; Book</button>
            <button class="btn btn-s xs" onclick="demoBeatOverpay();" title="Beat 3: Overpay Refund">3. Overpay Refund</button>
            <button class="btn btn-s xs" onclick="demoBeatTamper();" title="Beat 4: Tamper Hash Block">4. Tamper Block</button>
            <button class="btn btn-s xs" onclick="go('bitcoin');" title="Beat 5: Convert (33% Tax)">5. Convert 33% Tax</button>
            <button class="btn btn-s xs" onclick="go('collections');" title="Beat 6: Collections Chase">6. Collections</button>
            <button class="btn btn-s xs" onclick="demoBeatOffline();" title="Beat 7: 100% Offline Proof">7. Offline Proof</button>
          </div>
        </div>"""

text = text.replace(old_dash_grid, new_dash_grid, 1)

# 2. Upgrade Actions Required to the Kasa v2 Unified Agent Approval Queue
old_actions_block = text[text.find('<div class="sh"><span class="sh-t">Actions Required</span></div>'):text.find('<!-- ──────────────── NEW INVOICE ──────────────── -->')]

new_actions_block = """<div class="sh" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
          <span class="sh-t" style="font-size:13.5px; font-weight:700; color:var(--t1);">
            ⚡ Unified Agent Proposals Queue <span style="font-size:11px; font-weight:500; color:var(--t3);">&middot; "Agents propose, merchant approves, code executes"</span>
          </span>
          <span style="font-size:10px; font-family:'JetBrains Mono',monospace; color:var(--green); background:rgba(52,211,153,0.1); border:1px solid rgba(52,211,153,0.25); padding:2px 7px; border-radius:10px;">
            ● 3 Local Agents Active (QVAC Runtime)
          </span>
        </div>

        <div style="display:flex; flex-direction:column; gap:12px; margin-bottom:24px;">
          
          <!-- Proposal 1: Fraud Controller (Overpayment Refund) -->
          <div class="acard" style="border-left:3px solid var(--purple); background:var(--c3); margin-bottom:0;">
            <div class="ah">
              <span style="font-size:16px;">🛡️</span>
              <div class="ameta">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div class="atitle">Fraud Controller &middot; INV-0008 Overpayment Anomaly <span class="rtag" style="background:rgba(167,139,250,0.15); color:var(--purple); border:1px solid rgba(167,139,250,0.3);">PROPOSED ACTION</span></div>
                  <span class="mono" style="font-size:10px; color:var(--t3);">Vertex Global GmbH &middot; Sep 28</span>
                </div>
                <div class="ainv">RGB Transfer Tx: utxo:892,104:1 &middot; Reconciled State: OVERPAID</div>
              </div>
            </div>
            <div class="abody">
              <strong>Finding:</strong> Hard check confirmed payment amount exceeds invoice. Client transferred <span class="mono" style="font-weight:700; color:var(--t1);">620.00 USDT</span> on a <span class="mono">500.00 USDT</span> invoice (<strong style="color:var(--purple);">+120.00 USDT excess</strong>).
            </div>
            <div class="areason" style="background:var(--c2);">
              <span style="color:var(--purple); font-weight:700;">PROPOSAL:</span>
              <span>Execute 120.00 USDT refund to client's blinded seal. Agent never moves funds autonomously.</span>
            </div>
            <div class="abtns">
              <button class="bapp" style="background:rgba(167,139,250,0.15); border-color:rgba(167,139,250,0.4); color:var(--purple);" onclick="approv(this, 'refund')">&#x2713; Approve &amp; Execute Refund (120 USDT)</button>
              <button class="bdis" onclick="dism(this)">Hold &amp; Ask Client</button>
            </div>
          </div>

          <!-- Proposal 2: Commercialista (2026 Crypto Tax Set-Aside) -->
          <div class="acard" style="border-left:3px solid var(--amber); background:var(--c3); margin-bottom:0;">
            <div class="ah">
              <span style="font-size:16px;">⚖️</span>
              <div class="ameta">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div class="atitle">Commercialista &middot; 2026 Italian Crypto Tax Realization <span class="rtag rm">TAX WARNING</span></div>
                  <span class="mono" style="font-size:10px; color:var(--amber);">2026 Budget Law (33% Rate)</span>
                </div>
                <div class="ainv">USDT Stablecoin &middot; Italian Statutory Regime &middot; Quadro RW &middot; IVCA 0.2%</div>
              </div>
            </div>
            <div class="abody">
              <strong>Finding:</strong> USDT received for commercial invoices is booked at its EUR value at receipt as cost basis. Conversions to EUR are subject to the <strong style="color:var(--amber);">33% substitute tax</strong> (no &euro;2,000 threshold under 2026 tax law).
            </div>
            <div class="areason" style="background:var(--c2);">
              <span style="color:var(--amber); font-weight:700;">PROPOSAL:</span>
              <span>Set aside <strong style="color:var(--t1);">&euro; 412.80</strong> into designated tax reserve. Pre-conversion tax alerts armed for all trades.</span>
            </div>
            <div class="abtns">
              <button class="bapp" style="background:rgba(251,191,36,0.15); border-color:rgba(251,191,36,0.4); color:var(--amber);" onclick="approv(this, 'tax-setaside')">&#x2713; Approve &amp; Update Set-Aside Buffer (&euro;412.80)</button>
              <button class="bdis" onclick="go('tax')">Review Tax Lots</button>
            </div>
          </div>

          <!-- Proposal 3: Collections / Wildcard (Accounts Receivable Chase) -->
          <div class="acard" style="border-left:3px solid var(--blue); background:var(--c3); margin-bottom:0;">
            <div class="ah">
              <span style="font-size:16px;">⚡</span>
              <div class="ameta">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div class="atitle">Collections Agent (Wildcard) &middot; Expired Invoice Follow-Up <span class="rtag ri">AR CHASE</span></div>
                  <span class="mono" style="font-size:10px; color:var(--red);">INV-0010 &middot; 8 Days Overdue</span>
                </div>
                <div class="ainv">Meridian Creative LLC &middot; Amount: 800 USDT &middot; Expiry: Oct 2, 2026</div>
              </div>
            </div>
            <div class="abody">
              <strong>Finding:</strong> Single-use seal expired on Bitcoin mempool with zero incoming transactions detected. Local history: 1st transaction from new US client.
            </div>
            <div class="areason" style="background:var(--c2);">
              <span style="color:var(--blue); font-weight:700;">PROPOSAL:</span>
              <span>Draft gentle payment reminder email and propose re-issuing RGB invoice with a refreshed 7-day expiry seal.</span>
            </div>
            <div class="abtns">
              <button class="bapp" onclick="approv(this, 'reminder')">&#x2713; Approve &amp; Send Reminder Draft</button>
              <button class="bapp" style="background:transparent; border-color:var(--borderB); color:var(--t2);" onclick="go('new')">Re-Issue with New Expiry</button>
              <button class="bdis" onclick="dism(this)">Snooze 3 Days</button>
            </div>
          </div>

        </div>

      </div>
    </div>\n\n"""

text = text.replace(old_actions_block, new_actions_block, 1)

# 3. Insert view-collections right before view-settings
settings_marker = '<!-- ──────────────── SETTINGS ──────────────── -->'
collections_view = """<!-- ──────────────── COLLECTIONS AGENT (WILDCARD) ──────────────── -->
    <div id="view-collections" class="view">
      <div class="topbar">
        <div style="flex:1">
          <div class="tb-title">Collections Agent (Wildcard Slot)</div>
          <div class="tb-sub">Automated Receivables Follow-Up &middot; Expired &amp; Underpaid Invoice Recovery</div>
        </div>
        <div class="tb-actions">
          <button class="btn btn-s sm" onclick="toast('chase-all', '⚡', 'All Accounts Scanned', 'Zero new overdue invoices found.', 'blue')">Scan Receivables</button>
          <button class="btn btn-p sm" onclick="toast('chase-conf', '⚙️', 'Policy Updated', '7-day grace period rule active.', 'green')">Configure Rules</button>
        </div>
      </div>
      <div class="vb">
        
        <div class="sgrid">
          <div class="sc">
            <div class="sc-l">Expired Invoices</div>
            <div class="sc-v cr">1</div>
            <div class="sc-s">INV-0010 &middot; 800 USDT</div>
          </div>
          <div class="sc">
            <div class="sc-l">Underpaid Deficits</div>
            <div class="sc-v ca">1</div>
            <div class="sc-s">50.00 USDT Outstanding</div>
          </div>
          <div class="sc">
            <div class="sc-l">Recovery Rate</div>
            <div class="sc-v cg">94.2%</div>
            <div class="sc-s">Avg. 1.8 Days to Settlement</div>
          </div>
          <div class="sc">
            <div class="sc-l">Agent Runtime</div>
            <div class="sc-v cb">Local QVAC</div>
            <div class="sc-s">Offline Embedding Checks</div>
          </div>
        </div>

        <div class="sh"><span class="sh-t">Active Receivables Chase Queue</span></div>
        
        <div style="display:flex; flex-direction:column; gap:14px; margin-bottom:24px;">
          
          <!-- Case 1 -->
          <div class="acard" style="border-left:3px solid var(--red); background:var(--c3);">
            <div class="ah">
              <span style="font-size:18px;">⌛</span>
              <div class="ameta">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div class="atitle">INV-0010 &middot; Meridian Creative LLC &middot; Expired Single-Use Seal <span class="rtag rh">ACTION NEEDED</span></div>
                  <span class="mono" style="font-size:11px; font-weight:700; color:var(--red);">800.00 USDT</span>
                </div>
                <div class="ainv">Issue Date: Oct 1, 2026 &middot; Expiry: Oct 2, 2026 &middot; 8 Days Overdue</div>
              </div>
            </div>
            <div class="abody">
              <strong>Observation:</strong> Single-use seal reached its timestamp limit without UTXO commitment. Client has not yet requested a fresh RGB invoice string.
            </div>
            <div style="background:var(--c2); border:1px solid var(--borderB); border-radius:6px; padding:10px 12px; margin-bottom:12px; font-size:11.5px; line-height:1.5;">
              <div style="font-weight:700; color:var(--t1); margin-bottom:4px;">Drafted Reminder by QVAC:</div>
              <div style="color:var(--t2); font-style:italic;">
                "Hi Meridian Team, your invoice INV-0010 for 800 USDT expired on Oct 2nd. If you're ready to settle via RGB, click below to receive our renewed payment seal (valid 7 days)."
              </div>
            </div>
            <div class="abtns">
              <button class="bapp" onclick="toast('reminder-sent', '✓', 'Reminder Dispatched', 'Draft approved & sent to Meridian Creative.', 'green')">&#x2713; Approve &amp; Dispatch Reminder</button>
              <button class="btn btn-s" onclick="go('new')">Re-Issue Invoice with New Expiry</button>
            </div>
          </div>

          <!-- Case 2 -->
          <div class="acard" style="border-left:3px solid var(--amber); background:var(--c3);">
            <div class="ah">
              <span style="font-size:18px;">📉</span>
              <div class="ameta">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                  <div class="atitle">INV-0004 &middot; Nova Works &middot; Partial Payment Underpayment <span class="rtag rm">DEFICIT</span></div>
                  <span class="mono" style="font-size:11px; font-weight:700; color:var(--amber);">Deficit: -50.00 USDT</span>
                </div>
                <div class="ainv">Billed: 350 USDT &middot; Received: 300 USDT &middot; Balance Remaining</div>
              </div>
            </div>
            <div class="abody">
              <strong>Observation:</strong> Client executed transfer for 300 USDT instead of 350 USDT. Single-use seal anchored successfully, but invoice remains in <span class="badge b-underpaid">Underpaid</span> status.
            </div>
            <div class="areason" style="background:var(--c2);">
              <span style="color:var(--amber); font-weight:700;">PROPOSAL:</span>
              <span>Draft supplemental invoice for outstanding 50.00 USDT balance or propose marking difference as discount.</span>
            </div>
            <div class="abtns">
              <button class="bapp" style="background:rgba(251,191,36,0.15); border-color:rgba(251,191,36,0.4); color:var(--amber);" onclick="toast('req-bal', '✓', 'Balance Requested', '50 USDT supplemental invoice sent to Nova Works.', 'amber')">&#x2713; Request 50 USDT Balance</button>
              <button class="bdis" onclick="dism(this)">Write Off Difference</button>
            </div>
          </div>

        </div>

      </div>
    </div>\n\n"""

text = text.replace(settings_marker, collections_view + settings_marker, 1)

# 4. Add Demo Beats helper functions to script
demo_beats_script = """
  // ─── 7-Step Hackathon Demo Script Triggers ───
  function demoBeatPayAndBook() {
    go('invoices');
    toast('beat-2', '⚡', 'Beat 2: Pay & Book', 'RGB transfer landed! Invoice INV-0010 marked Paid & booked into ledger.', 'green');
    const row = document.querySelector('#view-invoices tbody tr');
    if (row) {
      const badge = row.querySelector('.badge');
      if (badge) { badge.className = 'badge b-paid'; badge.textContent = 'Paid'; }
    }
  }

  function demoBeatOverpay() {
    go('dashboard');
    toast('beat-3', '🛡️', 'Beat 3: Overpayment Detected', 'Fraud Controller flagged +120 USDT excess on INV-0008. Proposed: Refund difference.', 'purple');
  }

  function demoBeatTamper() {
    toast('beat-4', '🚫', 'Beat 4: Tampered PDF Blocked', 'Hard check blocked! Re-imported PDF hash mismatch (350 -> 420 USDT alteration).', 'red');
  }

  function demoBeatOffline() {
    toast('beat-7', '🛡️', 'Beat 7: 100% Offline Mode', 'Wi-Fi disconnect simulated: All 3 agents running on local QVAC. Zero data leak.', 'blue');
  }
"""

script_end_tag = '</script>'
text = text.replace(script_end_tag, demo_beats_script + '\n' + script_end_tag, 1)

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(text)

print("Kasa v2 multi-agent features added successfully!")
