import re, os, subprocess

# 1. Read base backup script
with open('src/index.html.pre-harvey.bak', 'r', encoding='utf-8') as f:
    bak_text = f.read()

bak_script_start = bak_text.find('<script>') + 8
bak_script_end = bak_text.find('</script>', bak_script_start)
bak_script = bak_text[bak_script_start:bak_script_end]

# 2. Read current HTML structure
with open('src/index.html', 'r', encoding='utf-8') as f:
    curr_text = f.read()

curr_script_start = curr_text.find('<script>')
curr_script_end = curr_text.find('</script>', curr_script_start) + 9

html_before_script = curr_text[:curr_script_start]
html_after_script = curr_text[curr_script_end:]

# 3. Add sidebar nav item for Profile if not present
if "go('profile')" not in html_before_script[:html_before_script.find('</nav>')]:
    profile_nav = """      <div class="nlbl">Profile &amp; Chambers</div>
      <div class="ni" onclick="go('profile')"><span class="nic">&#x1F464;</span>Firm Profile &amp; Entity</div>
    </nav>"""
    html_before_script = html_before_script.replace('    </nav>', profile_nav, 1)

# 4. English translations in modals
html_after_script = html_after_script.replace('📋 Adresi Kopyala', '📋 Copy Address')
html_after_script = html_after_script.replace('🔄 Yeni Kör Mühür', '🔄 New Blinded Seal')
html_after_script = html_after_script.replace('>Kapat<', '>Close<')
html_after_script = html_after_script.replace('🖨️ Yazdır', '🖨️ Print')
html_after_script = html_after_script.replace('↓ Resmi PDF Makbuzu İndir', '↓ Download Official PDF Receipt')
html_after_script = html_after_script.replace('Mühür Hash (SHA-256):', 'Seal Hash (SHA-256):')
html_after_script = html_after_script.replace('✓ Valido ai sensi di legge', '✓ Legally Validated (AdE Compliant)')

# 5. In bak_script, replace old profile functions with executive suite
old_prof_block = """  function updateProfilePreview() {
    const name = document.getElementById('prof-name')?.value || 'Giulia Mancini';
    const co = document.getElementById('prof-co')?.value || 'Studio Mancini';
    const vat = document.getElementById('prof-vat')?.value || 'IT12345678901';
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    
    if (document.getElementById('prev-name')) document.getElementById('prev-name').textContent = name;
    if (document.getElementById('prev-co')) document.getElementById('prev-co').textContent = co;
    if (document.getElementById('prev-vat')) document.getElementById('prev-vat').textContent = vat;
    if (document.getElementById('prev-av')) document.getElementById('prev-av').textContent = initials || 'GM';
  }

  function saveProfile() {
    updateProfilePreview();
    const name = document.getElementById('prof-name').value || 'Giulia Mancini';
    const co = document.getElementById('prof-co').value || 'Studio Mancini';
    const initials = name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
    
    document.getElementById('sidebar-av').textContent = initials || 'GM';
    document.getElementById('sidebar-name').textContent = name;
    document.getElementById('sidebar-co').textContent = co;
    
    toast('profile', '✓', 'Profile Saved', 'Identity and business details updated.', 'green');
  }"""

new_prof_suite = """  const DEFAULT_FIRM_PROFILE = {
    name: 'Avv. Giulio Mancini',
    role: 'Senior Managing Partner & Tax Counsel',
    bar: 'Ordine degli Avvocati di Milano · Albo N. 49201',
    phone: '+39 02 8739 4410',
    email: 'giulio.mancini@mancini.studio',
    pec: 'studio.mancini@pec.ordineavvocatimilano.it',
    co: 'Studio Legale e Tributario Mancini Associazione Professionale',
    vat: 'IT09283740156',
    cf: 'MNCGLI84A41F205X',
    sdi: 'M5UXCR1',
    addr: 'Via Montenapoleone 8, 20121 Milano (MI), Italy',
    bank: 'Banca Sella S.p.A. - Private Banking Division',
    bic: 'SELBIT2BXXX',
    iban: 'IT79 S 0326 8016 0005 2948 1039 21'
  };

  function getStoredProfile() {
    try {
      const data = localStorage.getItem('vault_firm_profile');
      if (data) return JSON.parse(data);
    } catch(e) {}
    return DEFAULT_FIRM_PROFILE;
  }

  function updateProfilePreview() {
    const name = document.getElementById('prof-name')?.value || DEFAULT_FIRM_PROFILE.name;
    const role = document.getElementById('prof-role')?.value || DEFAULT_FIRM_PROFILE.role;
    const bar = document.getElementById('prof-bar')?.value || DEFAULT_FIRM_PROFILE.bar;
    const co = document.getElementById('prof-co')?.value || DEFAULT_FIRM_PROFILE.co;
    const vat = document.getElementById('prof-vat')?.value || DEFAULT_FIRM_PROFILE.vat;
    const cf = document.getElementById('prof-cf')?.value || DEFAULT_FIRM_PROFILE.cf;
    const sdi = document.getElementById('prof-sdi')?.value || DEFAULT_FIRM_PROFILE.sdi;
    const iban = document.getElementById('prof-iban')?.value || DEFAULT_FIRM_PROFILE.iban;
    
    const initials = name.replace(/^Avv\.\s*/i, '').trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'GM';
    
    if (document.getElementById('prev-av-hdr')) document.getElementById('prev-av-hdr').textContent = initials;
    if (document.getElementById('prev-name-hdr')) document.getElementById('prev-name-hdr').textContent = name;
    if (document.getElementById('prev-co-hdr')) document.getElementById('prev-co-hdr').textContent = co;

    if (document.getElementById('prev-co-card')) document.getElementById('prev-co-card').textContent = co.split(' ')[0] + ' ' + (co.split(' ')[1] || 'MANCINI');
    if (document.getElementById('prev-name-card')) document.getElementById('prev-name-card').textContent = name;
    if (document.getElementById('prev-role-card')) document.getElementById('prev-role-card').textContent = role;
    if (document.getElementById('prev-bar-card')) document.getElementById('prev-bar-card').textContent = bar;
    if (document.getElementById('prev-vat-card')) document.getElementById('prev-vat-card').textContent = vat;
    if (document.getElementById('prev-cf-card')) document.getElementById('prev-cf-card').textContent = cf;
    if (document.getElementById('prev-sdi-card')) document.getElementById('prev-sdi-card').textContent = sdi;
    
    if (document.getElementById('prev-iban-card')) {
      const parts = iban.trim().split(' ');
      if (parts.length >= 4) {
        document.getElementById('prev-iban-card').textContent = parts[0] + ' ' + parts[1] + ' •••• ' + parts[parts.length-2] + ' ' + parts[parts.length-1];
      } else {
        document.getElementById('prev-iban-card').textContent = iban.slice(0, 8) + ' •••• ' + iban.slice(-4);
      }
    }
  }

  function saveProfile() {
    updateProfilePreview();
    const prof = {
      name: document.getElementById('prof-name')?.value || DEFAULT_FIRM_PROFILE.name,
      role: document.getElementById('prof-role')?.value || DEFAULT_FIRM_PROFILE.role,
      bar: document.getElementById('prof-bar')?.value || DEFAULT_FIRM_PROFILE.bar,
      phone: document.getElementById('prof-phone')?.value || DEFAULT_FIRM_PROFILE.phone,
      email: document.getElementById('prof-email')?.value || DEFAULT_FIRM_PROFILE.email,
      pec: document.getElementById('prof-pec')?.value || DEFAULT_FIRM_PROFILE.pec,
      co: document.getElementById('prof-co')?.value || DEFAULT_FIRM_PROFILE.co,
      vat: document.getElementById('prof-vat')?.value || DEFAULT_FIRM_PROFILE.vat,
      cf: document.getElementById('prof-cf')?.value || DEFAULT_FIRM_PROFILE.cf,
      sdi: document.getElementById('prof-sdi')?.value || DEFAULT_FIRM_PROFILE.sdi,
      addr: document.getElementById('prof-addr')?.value || DEFAULT_FIRM_PROFILE.addr,
      bank: document.getElementById('prof-bank')?.value || DEFAULT_FIRM_PROFILE.bank,
      bic: document.getElementById('prof-bic')?.value || DEFAULT_FIRM_PROFILE.bic,
      iban: document.getElementById('prof-iban')?.value || DEFAULT_FIRM_PROFILE.iban
    };
    
    try {
      localStorage.setItem('vault_firm_profile', JSON.stringify(prof));
    } catch(e) {}
    
    const initials = prof.name.replace(/^Avv\.\s*/i, '').trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'GM';
    const sAv = document.getElementById('sidebar-av');
    const sName = document.getElementById('sidebar-name');
    const sCo = document.getElementById('sidebar-co');
    if (sAv) sAv.textContent = initials;
    if (sName) sName.textContent = prof.name;
    if (sCo) sCo.textContent = prof.co.split(' ')[0] + ' ' + (prof.co.split(' ')[1] || 'Mancini');

    toast('profile', '✓', 'Firm Credentials Saved', 'Profile, Modello F24 engine, and SDI channels synchronized.', 'green');
  }

  function resetProfileDefaults() {
    try { localStorage.removeItem('vault_firm_profile'); } catch(e) {}
    loadSavedProfile(DEFAULT_FIRM_PROFILE);
    toast('profile', '↺', 'Defaults Restored', 'Reset to licensed firm master credentials.', 'blue');
  }

  function loadSavedProfile(profileData) {
    const prof = profileData || getStoredProfile();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    setVal('prof-name', prof.name);
    setVal('prof-role', prof.role);
    setVal('prof-bar', prof.bar);
    setVal('prof-phone', prof.phone);
    setVal('prof-email', prof.email);
    setVal('prof-pec', prof.pec);
    setVal('prof-co', prof.co);
    setVal('prof-vat', prof.vat);
    setVal('prof-cf', prof.cf);
    setVal('prof-sdi', prof.sdi);
    setVal('prof-addr', prof.addr);
    setVal('prof-bank', prof.bank);
    setVal('prof-bic', prof.bic);
    setVal('prof-iban', prof.iban);
    
    updateProfilePreview();

    const initials = prof.name.replace(/^Avv\.\s*/i, '').trim().split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2) || 'GM';
    const sAv = document.getElementById('sidebar-av');
    const sName = document.getElementById('sidebar-name');
    const sCo = document.getElementById('sidebar-co');
    if (sAv) sAv.textContent = initials;
    if (sName) sName.textContent = prof.name;
    if (sCo) sCo.textContent = prof.co.split(' ')[0] + ' ' + (prof.co.split(' ')[1] || 'Mancini');
  }

  function copyEntityBlock() {
    const name = document.getElementById('prof-name')?.value || DEFAULT_FIRM_PROFILE.name;
    const co = document.getElementById('prof-co')?.value || DEFAULT_FIRM_PROFILE.co;
    const vat = document.getElementById('prof-vat')?.value || DEFAULT_FIRM_PROFILE.vat;
    const cf = document.getElementById('prof-cf')?.value || DEFAULT_FIRM_PROFILE.cf;
    const sdi = document.getElementById('prof-sdi')?.value || DEFAULT_FIRM_PROFILE.sdi;
    const pec = document.getElementById('prof-pec')?.value || DEFAULT_FIRM_PROFILE.pec;
    const addr = document.getElementById('prof-addr')?.value || DEFAULT_FIRM_PROFILE.addr;
    const iban = document.getElementById('prof-iban')?.value || DEFAULT_FIRM_PROFILE.iban;
    const bank = document.getElementById('prof-bank')?.value || DEFAULT_FIRM_PROFILE.bank;

    const block = co + "\\nRepresented by: " + name + "\\nRegistered Office: " + addr + "\\nPartita IVA: " + vat + " | Codice Fiscale: " + cf + "\\nCodice SDI (B2B E-Invoicing): " + sdi + "\\nCertified PEC: " + pec + "\\nSettlement Bank: " + bank + "\\nCorporate IBAN: " + iban;

    navigator.clipboard.writeText(block).then(() => {
      toast('copy-entity', '📋', 'Entity Block Copied', 'Certified firm header copied to clipboard.', 'green');
    }).catch(() => {
      toast('copy-entity', '📋', 'Entity Header', 'Ready for copy.', 'blue');
    });
  }"""

if old_prof_block in bak_script:
    bak_script = bak_script.replace(old_prof_block, new_prof_suite, 1)

# 6. Additional interactive functions to add to script
additional_functions = """
  // ─── Extra Interactive Handlers ───
  function loadSampleInvoice() {
    document.getElementById('step-upload').style.display = 'none';
    document.getElementById('step-preview').style.display = 'block';
    toast('sample-inv', '📄', 'Sample Invoice Loaded', 'Meridian Creative (INV-0010) staged for extraction.', 'blue');
    simulateExtractWithScan();
  }

  let currentOrderSide = 'buy';
  function setOrderSide(side) {
    currentOrderSide = side;
    const btnBuy = document.getElementById('btn-side-buy');
    const btnSell = document.getElementById('btn-side-sell');
    const btnConfirm = document.getElementById('btn-order-confirm');
    if (side === 'buy') {
      if (btnBuy) { btnBuy.className = 'btn btn-p'; btnBuy.style.background = 'var(--green)'; btnBuy.style.borderColor = 'var(--green)'; btnBuy.style.color = '#fff'; }
      if (btnSell) { btnSell.className = 'btn btn-s'; btnSell.style.background = ''; btnSell.style.borderColor = ''; btnSell.style.color = ''; }
      if (btnConfirm) { btnConfirm.textContent = 'Confirm Buy Order'; btnConfirm.style.background = '#d97736'; }
    } else {
      if (btnSell) { btnSell.className = 'btn btn-p'; btnSell.style.background = 'var(--red)'; btnSell.style.borderColor = 'var(--red)'; btnSell.style.color = '#fff'; }
      if (btnBuy) { btnBuy.className = 'btn btn-s'; btnBuy.style.background = ''; btnBuy.style.borderColor = ''; btnBuy.style.color = ''; }
      if (btnConfirm) { btnConfirm.textContent = 'Confirm Sell Order'; btnConfirm.style.background = 'var(--red)'; }
    }
  }

  function executeBitcoinOrder() {
    const amtInput = document.getElementById('btc-order-amount');
    const amt = amtInput ? amtInput.value : '0.1';
    if (currentOrderSide === 'buy') {
      toast('btc-order', '✓', 'Order Executed', 'Successfully purchased ' + amt + ' BTC from Banca Sella via Kraken Pro.', 'green');
    } else {
      toast('btc-order', '✓', 'Order Executed', 'Successfully sold ' + amt + ' BTC to EUR Treasury balance.', 'amber');
    }
  }

  function openUpdateModal() {
    const m = document.getElementById('update-modal');
    if (m) m.classList.add('on');
  }
  function closeUpdateModal() {
    const m = document.getElementById('update-modal');
    if (m) m.classList.remove('on');
  }
  function refreshHardwareTelemetry() {
    const cpuVal = (18 + Math.random() * 9).toFixed(1);
    const gpuVal = (32 + Math.random() * 12).toFixed(1);
    const vramVal = (3.8 + Math.random() * 0.8).toFixed(1);
    const cpuEl = document.getElementById('cpu-usage-val');
    const gpuEl = document.getElementById('gpu-usage-val');
    const vramEl = document.getElementById('gpu-vram-val');
    if (cpuEl) cpuEl.textContent = cpuVal + '% (4P + 4E Cores)';
    if (gpuEl) gpuEl.textContent = gpuVal + '% Active Load';
    if (vramEl) vramEl.textContent = vramVal + ' GB / 16.0 GB';
    toast('telemetry', '⚡', 'Telemetry Refreshed', 'Apple Metal & CPU sensors updated in real time.', 'green');
  }

  window.addEventListener('DOMContentLoaded', () => {
    loadSavedProfile();
    updateLiveDate();
  });
"""

final_script = "<script>\n" + bak_script + additional_functions + "\n</script>"

# 7. Clean remaining Turkish strings in JS
final_script = final_script.replace("toast('f24-dl', '✓', 'F24 Makbuzu İndirildi', filename + ' resmi vergi arşivinize eklendi.', 'green');", "toast('f24-dl', '✓', 'F24 Receipt Downloaded', filename + ' added to official tax records.', 'green');")
final_script = final_script.replace("toast('inv-dl', '✓', 'Fatura İndirildi', filename + ' yerel diskinize kaydedildi.', 'blue');", "toast('inv-dl', '✓', 'Invoice Downloaded', filename + ' saved to your local drive.', 'blue');")
final_script = final_script.replace("toast('cons-dl', '📦', 'Konsinye Paketi İndirildi', filename + ' RGB ağına gönderilmeye hazır.', 'purple');", "toast('cons-dl', '📦', 'Consignment Exported', filename + ' ready for RGB network dispatch.', 'purple');")
final_script = final_script.replace("toast('rcv-copy', '✓', 'Adres Kopyalandı', 'Kör mühürlü RGB fatura dizesi panoya kopyalandı.', 'green');", "toast('rcv-copy', '✓', 'Address Copied', 'Blinded RGB invoice string copied to clipboard.', 'green');")
final_script = final_script.replace("toast('seal-gen', '⚡', 'Yeni Kör Mühür Üretildi', 'Yeni bir Bitcoin UTXO çıktısı körlendi ve bağlandı.', 'blue');", "toast('seal-gen', '⚡', 'New Blinded Seal Generated', 'Fresh Bitcoin UTXO output committed and anchored.', 'blue');")
final_script = final_script.replace("toast('tax-exec', '✓', 'F24 Ödeme Emri İletildi', '1,421.92 EUR vergi transferi Agenzia delle Entrate hesabına onaylandı.', 'green');", "toast('tax-exec', '✓', 'F24 Settlement Dispatched', '1,421.92 EUR tax payment authorized to Agenzia delle Entrate account.', 'green');")
final_script = final_script.replace("toast('tax-rep', '📊', 'Vergi Raporu Hazırlandı', '2026 Q3 KDV beyannamesi ve indirimler yerel belleğe kaydedildi.', 'green');", "toast('tax-rep', '📊', 'Tax Report Generated', '2026 Q3 VAT statement and deductions compiled locally.', 'green');")
final_script = final_script.replace("toast('send', '✓', 'Transfer Başlatıldı', `${amt} ${curr} başarıyla ${addr.slice(0, 16)}... adresine gönderildi.`, 'green');", "toast('send', '✓', 'Transfer Dispatched', `${amt} ${curr} sent to ${addr.slice(0, 16)}...`, 'green');")
final_script = final_script.replace("title = 'Son Fatura Defteri';", "title = 'Recent Invoices Ledger';")
final_script = final_script.replace("title = 'Kritik Risk ve Hata Havuzu';", "title = 'Critical Risk & Quarantine Pool';")

full_html = html_before_script + final_script + html_after_script

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(full_html)

print('Full index.html assembled successfully! Total length:', len(full_html))
