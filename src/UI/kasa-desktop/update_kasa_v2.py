with open('src/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Update Title and Brand Name
text = text.replace('<title>Vault – RGB Invoicing</title>', '<title>Kasa v2 – Multi-Agent RGB Invoicing</title>')
text = text.replace('<div class="brand-name">Vault</div>', '<div class="brand-name">Kasa <span style="font-size:12px; font-weight:600; color:var(--blue); vertical-align:middle; background:rgba(96,165,250,0.15); padding:1px 6px; border-radius:10px; border:1px solid rgba(96,165,250,0.3);">v2</span></div>')
text = text.replace('<div class="brand-tag">RGB · Self-custodial · Testnet</div>', '<div class="brand-tag">Multi-Agent RGB Invoicing &middot; Self-Custodial</div>')

# 2. Beautify the top-left WDK Wallet Card (.wpill)
old_wpill_block = """      <div class="wpill">
        <div class="wdot"></div>
        <div class="wmeta"><div class="wnet">WDK Wallet</div><div class="waddr">bc1q&hellip;k4a9x7</div></div>
        <div class="wbal">2,450 USDT</div>
      </div>
      <div style="margin-top:8px; display:flex; gap:6px; align-items:center; justify-content:space-between; font-size:9.5px; color:var(--t3); padding:4px 8px; background:rgba(255,255,255,0.03); border:1px solid var(--borderB); border-radius:6px;">
        <span style="display:flex; align-items:center; gap:5px;">
          <span style="width:5px; height:5px; border-radius:50%; background:var(--green); box-shadow:0 0 5px var(--green); animation: pulseDot 2s infinite;"></span>
          WDK Synced
        </span>
        <span class="mono" style="font-size:9px; color:var(--t3);">Blk #834,192</span>
      </div>"""

new_wpill_block = """      <!-- Beautified WDK Self-Custodial Wallet Card -->
      <div style="margin:12px 0 0; padding:12px 14px; background:linear-gradient(145deg, rgba(26,30,39,0.95), rgba(18,21,27,0.98)); border:1px solid rgba(255,255,255,0.12); border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.4); display:flex; flex-direction:column; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <div style="display:flex; align-items:center; gap:6px;">
            <span style="width:6px; height:6px; border-radius:50%; background:var(--green); box-shadow:0 0 6px var(--green); animation: pulseDot 2s infinite;"></span>
            <span style="font-size:9.5px; font-weight:700; color:var(--t2); letter-spacing:0.6px; text-transform:uppercase;">WDK · RGB20 SINGLE-USE SEAL</span>
          </div>
          <span class="badge b-paid" style="font-size:8.5px; padding:1px 6px;">TESTNET</span>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:baseline;">
          <div>
            <div style="font-family:'JetBrains Mono',monospace; font-size:16px; font-weight:800; color:var(--t1); letter-spacing:-0.5px;">2,450.00 <span style="font-size:11px; color:var(--green);">USDT</span></div>
            <div style="font-size:10px; color:var(--t3);">&asymp; €2,263.80 &middot; 0.042 BTC</div>
          </div>
          <button class="btn btn-g" style="padding:3px 8px; font-size:10px; border-radius:4px; font-weight:600;" onclick="openReceiveModal()" title="Generate Blinded Invoice">
            + Receive
          </button>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid rgba(255,255,255,0.06); padding-top:6px; font-size:9.5px; color:var(--t3);">
          <span style="display:flex; align-items:center; gap:4px; font-family:'JetBrains Mono',monospace;">
            <span>bc1q7...9x2m4</span>
            <span style="cursor:pointer;" onclick="toast('addr-cp', '📋', 'Address Copied', 'WDK SegWit address copied to clipboard.', 'green')" title="Copy Address">📋</span>
          </span>
          <span class="mono" style="color:var(--t3);">Seal: #803,214:0</span>
        </div>
      </div>"""

if old_wpill_block in text:
    text = text.replace(old_wpill_block, new_wpill_block, 1)

# 3. Update Sidebar Navigation: Remove System Logs, Group the 3 Agents prominently
old_nav_block = text[text.find('<nav>'):text.find('</nav>')+6]

new_nav_block = """<nav>
      <div class="nlbl">Workspace</div>
      <div class="ni on" onclick="go('dashboard')"><span class="nic">▨</span>Dashboard</div>
      <div class="ni" onclick="go('invoices')"><span class="nic">▢</span>Invoices<span class="nbadge">2</span></div>
      <div class="ni" onclick="go('new')"><span class="nic">+</span>New Invoice</div>
      <div class="ni" onclick="go('ledger')"><span class="nic">☰</span>Ledger &amp; Cost Basis</div>
      <div class="ni" onclick="go('bitcoin')"><span class="nic" style="font-weight:700;">⇄</span>Convert &amp; Treasury</div>
      <div class="ni" onclick="go('wallet')"><span class="nic">◉</span>WDK Wallet</div>

      <div class="nlbl" style="display:flex; justify-content:space-between; align-items:center; margin-top:12px;">
        <span>The 3 Agents (QVAC Runtime)</span>
        <span style="font-size:8px; color:var(--green); font-family:'JetBrains Mono',monospace;">● ACTIVE</span>
      </div>
      <div class="ni" onclick="go('fraud')"><span class="nic">🛡️</span>Fraud Controller<span class="rtag rh" style="font-size:8.5px; margin-left:auto;">1 Alert</span></div>
      <div class="ni" onclick="go('tax')"><span class="nic">⚖️</span>Commercialista<span class="rtag rm" style="font-size:8.5px; margin-left:auto;">€412 Set Aside</span></div>
      <div class="ni" onclick="go('collections')"><span class="nic">⚡</span>Collections (Wildcard)<span class="rtag ri" style="font-size:8.5px; margin-left:auto;">1 Expired</span></div>

      <div class="nlbl" style="margin-top:12px;">Organization</div>
      <div class="ni" onclick="go('profile')"><span class="nic">👤</span>Firm Profile &amp; Entity</div>
      <div class="ni" onclick="go('settings')"><span class="nic">⚙</span>Settings &amp; Telemetry</div>
    </nav>"""

text = text.replace(old_nav_block, new_nav_block, 1)

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(text)

print("Nav & WDK wallet card updated successfully!")
