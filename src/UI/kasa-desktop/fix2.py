with open('src/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

start_idx = text.find('function executeBitcoinOrder()')
end_idx = text.find('</script>')

new_func = """  function executeBitcoinOrder() {
    const amtInput = document.getElementById('btc-order-amount');
    const amt = amtInput ? amtInput.value : '0.1';
    if (currentOrderSide === 'buy') {
      toast('btc-order', '✓', 'Order Executed', 'Successfully purchased ' + amt + ' BTC from Banca Sella via Kraken Pro.', 'green');
    } else {
      toast('btc-order', '✓', 'Order Executed', 'Successfully sold ' + amt + ' BTC to EUR Treasury balance.', 'amber');
    }
  }
"""

text = text[:start_idx] + new_func + text[end_idx:]

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(text)

print('Standalone fix2 applied!')
