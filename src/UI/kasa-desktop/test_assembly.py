with open('src/index.html.pre-harvey.bak', 'r', encoding='utf-8') as f:
    bak_text = f.read()

with open('src/index.html', 'r', encoding='utf-8') as f:
    curr_text = f.read()

# Extract script from bak_text
bak_script_start = bak_text.find('<script>') + 8
bak_script_end = bak_text.find('</script>', bak_script_start)
bak_script = bak_text[bak_script_start:bak_script_end]

print('Backup script length:', len(bak_script))
