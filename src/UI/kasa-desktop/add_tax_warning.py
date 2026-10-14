with open('src/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. In view-bitcoin, add the Commercialista 2026 tax warning box right after the quick presets
old_presets = """              <!-- Quick Presets -->
              <div style="display:flex; align-items:center; gap:6px; margin-top:10px;">
                <span style="font-size:9.5px; color:var(--t3); font-family:'JetBrains Mono',monospace;">PRESETS:</span>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(100, 'EUR')">€100</button>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(500, 'EUR')">€500</button>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(1830, 'EUR')">€1,830 (Q3 VAT)</button>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(1, 'BTC')">1 BTC</button>
              </div>
            </div>"""

new_presets_with_tax = """              <!-- Quick Presets -->
              <div style="display:flex; align-items:center; gap:6px; margin-top:10px;">
                <span style="font-size:9.5px; color:var(--t3); font-family:'JetBrains Mono',monospace;">PRESETS:</span>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(100, 'EUR')">€100</button>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(500, 'EUR')">€500 (Demo Beat 5)</button>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(1830, 'EUR')">€1,830 (Q3 VAT)</button>
                <button class="btn btn-g" style="padding:2px 7px; font-size:9.5px;" onclick="setConverterPreset(1, 'BTC')">1 BTC</button>
              </div>

              <!-- Commercialista Pre-Conversion Tax Alert (Italian 2026 Rules) -->
              <div id="conv-tax-box" style="margin-top:14px; background:rgba(251,191,36,0.06); border:1px solid rgba(251,191,36,0.3); border-radius:8px; padding:10px 14px; font-size:11px; display:flex; align-items:flex-start; gap:10px;">
                <span style="font-size:16px;">⚖️</span>
                <div style="flex:1;">
                  <div style="display:flex; justify-content:space-between; align-items:center;">
                    <strong style="color:var(--amber);">Commercialista Pre-Trade Tax Warning (2026 Rules):</strong>
                    <span class="badge" style="background:rgba(251,191,36,0.18); color:var(--amber); border:1px solid rgba(251,191,36,0.35); font-size:9px;">33% Substitute Tax</span>
                  </div>
                  <div id="conv-tax-text" style="color:var(--t2); margin-top:3px; line-height:1.45;">
                    Converting <span id="tax-warn-usdt" style="font-weight:700; color:var(--t1);">500 USDT</span> now realises an estimated capital gain of <strong id="tax-warn-gain" style="color:var(--green);">+€12.50</strong> (cost basis: €450.00). Estimated 33% statutory tax: <strong id="tax-warn-tax" style="color:var(--amber);">€4.13</strong> to set aside.
                  </div>
                  <div style="font-size:9.5px; color:var(--t3); margin-top:3px;">
                    *Italian Budget Law 2026: 33% flat tax on non-EMT crypto assets, zero €2,000 threshold. Labelled as estimate.
                  </div>
                </div>
              </div>
            </div>"""

if old_presets in text:
    text = text.replace(old_presets, new_presets_with_tax, 1)

# 2. Update runCurrencyConversion to compute the 33% tax warning live
old_run_conv = """    if (spreadLabel) {
      spreadLabel.textContent = `Kraken Avantajı: +%0.08`;
    }
  }"""

new_run_conv = """    if (spreadLabel) {
      spreadLabel.textContent = `Kraken Spread: 0.02%`;
    }

    // Dynamic Commercialista 2026 Tax Estimate Calculation
    const usdtAmt = fromCurr === 'USDT' ? (parseFloat(inputFrom.value) || 0) : (toCurr === 'USDT' ? (parseFloat(inputTo.value) || 0) : 0);
    if (usdtAmt > 0) {
      const costBasisRate = 0.900; // Booked EUR value at receipt
      const currentEurRate = 0.925; // Current exchange rate
      const gain = Math.max(0, usdtAmt * (currentEurRate - costBasisRate));
      const tax33 = gain * 0.33;
      const elText = document.getElementById('conv-tax-text');
      if (elText) {
        elText.innerHTML = `Converting <strong style="color:var(--t1);">${usdtAmt.toFixed(0)} USDT</strong> now realises an estimated gain of <strong style="color:var(--green);">+€${gain.toFixed(2)}</strong> (cost basis: €${(usdtAmt * costBasisRate).toFixed(2)}). Estimated 33% substitute tax: <strong style="color:var(--amber);">€${tax33.toFixed(2)}</strong> to set aside.`;
      }
    }
  }"""

if old_run_conv in text:
    text = text.replace(old_run_conv, new_run_conv, 1)

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(text)

print("Tax warning box and dynamic calculation added!")
