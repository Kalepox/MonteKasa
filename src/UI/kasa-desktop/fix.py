with open('src/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

start_idx = text.find('function copyEntityBlock()')
end_idx = text.find('function loadSampleInvoice()')

new_func = """  function copyEntityBlock() {
    const name = document.getElementById('prof-name')?.value || DEFAULT_FIRM_PROFILE.name;
    const co = document.getElementById('prof-co')?.value || DEFAULT_FIRM_PROFILE.co;
    const vat = document.getElementById('prof-vat')?.value || DEFAULT_FIRM_PROFILE.vat;
    const cf = document.getElementById('prof-cf')?.value || DEFAULT_FIRM_PROFILE.cf;
    const sdi = document.getElementById('prof-sdi')?.value || DEFAULT_FIRM_PROFILE.sdi;
    const pec = document.getElementById('prof-pec')?.value || DEFAULT_FIRM_PROFILE.pec;
    const addr = document.getElementById('prof-addr')?.value || DEFAULT_FIRM_PROFILE.addr;
    const iban = document.getElementById('prof-iban')?.value || DEFAULT_FIRM_PROFILE.iban;
    const bank = document.getElementById('prof-bank')?.value || DEFAULT_FIRM_PROFILE.bank;

    const block = co + "\\nRepresented by: " + name + "\\nRegistered Office: " + addr + "\\nPartita IVA: " + vat + " | Codice Fiscale: " + cf + "\\nCodice SDI: " + sdi + "\\nCertified PEC: " + pec + "\\nSettlement Bank: " + bank + "\\nCorporate IBAN: " + iban;

    navigator.clipboard.writeText(block).then(() => {
      toast('copy-entity', '📋', 'Entity Block Copied', 'Certified firm header copied to clipboard.', 'green');
    }).catch(() => {
      toast('copy-entity', '📋', 'Entity Header', 'Ready for copy.', 'blue');
    });
  }\n\n"""

text = text[:start_idx] + new_func + text[end_idx:]

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(text)

print('Standalone python fix applied!')
