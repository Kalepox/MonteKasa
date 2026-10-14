with open('src/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Insert missing Views CSS
target_css = ".modal { background: var(--c2); color: var(--t1); }"
views_css = """.modal { background: var(--c2); color: var(--t1); }

    /* ─── Views ─────────────────────────────────────────────── */
    .view { flex: 1; overflow-y: auto; display: none; opacity: 0; }
    .view.on { display: block !important; opacity: 1 !important; animation: fadeView 0.2s ease-out forwards; }
    @keyframes fadeView { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes scanLine { 0% { top: 0; } 100% { top: 100%; } }
    @keyframes pulseDot { 0% { opacity:0.3; } 50% { opacity:1; } 100% { opacity:0.3; } }

    .skeleton-overlay { position:absolute; top:0; left:0; right:0; bottom:0; background:var(--bg); z-index:10; display:flex; flex-direction:column; padding:32px 40px; gap:20px; }
    .skel-box { height:120px; background:var(--c3); border-radius:var(--r4); position:relative; overflow:hidden; }
    .skel-box::after { content:""; position:absolute; top:0; right:0; bottom:0; left:0; transform:translateX(-100%); background-image:linear-gradient(90deg, rgba(255,255,255,0) 0, rgba(255,255,255,0.02) 20%, rgba(255,255,255,0.05) 60%, rgba(255,255,255,0)); animation:shimmer 1s infinite; }
    @keyframes shimmer { 100% { transform:translateX(100%); } }

    .vb { padding: 20px 24px; }"""

assert target_css in text, "target_css not found"
text = text.replace(target_css, views_css, 1)

# 2. Upgrade go(n) to have bulletproof inline display fallback and active tab management
old_go = """  function go(n) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('on'));
    document.querySelectorAll('.ni').forEach(i => i.classList.remove('on'));
    
    // No more artificial skeleton delay; rely on CSS fade animation
    const skel = document.getElementById('skel-loader');
    if(skel) skel.style.display = 'none';
    const v = document.getElementById('view-' + n);
    if (v) v.classList.add('on');

    document.querySelectorAll('.ni').forEach(i => {
      if ((i.getAttribute('onclick') || '').includes("'" + n + "'")) i.classList.add('on');
    });
  }"""

new_go = """  function go(n) {
    document.querySelectorAll('.view').forEach(v => {
      v.classList.remove('on');
      v.style.display = 'none';
    });
    document.querySelectorAll('.ni').forEach(i => i.classList.remove('on'));
    
    const skel = document.getElementById('skel-loader');
    if(skel) skel.style.display = 'none';

    const v = document.getElementById('view-' + n);
    if (v) {
      v.classList.add('on');
      v.style.display = 'block';
      v.scrollTop = 0;
    }

    document.querySelectorAll('.ni').forEach(i => {
      const oc = i.getAttribute('onclick') || '';
      if (oc.includes("'" + n + "'") || oc.includes('"' + n + '"')) {
        i.classList.add('on');
      }
    });
  }"""

if old_go in text:
    text = text.replace(old_go, new_go, 1)
else:
    # Try replacing using regex
    import re
    text = re.sub(r'function go\([^)]*\)\s*\{[\s\S]*?\}\s*\}\;', new_go, text)

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(text)

print("fix_tabs.py applied successfully!")
