with open('src/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace root tokens with permanent Slate Dark theme
start_root = text.find('/* ─── Tokens ──────────────────────────────────────────────── */')
end_root = text.find('/* ─── Components ─────────────────────────────────────────── */')

new_dark_root_css = """/* ─── Tokens ──────────────────────────────────────────────── */
    /* ─── Permanent Slate Dark Studio Theme (White Mode Completely Removed) ─── */
    :root {
      --bg:          #12151b;
      --c0:          #14171e;
      --c1:          #0f1217;
      --c2:          #1a1e27;
      --c3:          #212631;
      --c4:          #2c3342;
      --c5:          #171a22;

      --border:      rgba(255,255,255,0.08);
      --borderB:     rgba(255,255,255,0.16);

      --gold:        #94a3b8;
      --gold-border: rgba(255, 255, 255, 0.08);
      --gold-d:      rgba(148, 163, 184, 0.08);
      --glow-gold:   none;
      --bar-gold:    0 0 6px rgba(96, 165, 250, 0.4);
      --topbar-gold: none;

      --blue:        #60a5fa;
      --blue-d:      rgba(96,165,250,0.16);
      --green:       #34d399;
      --green-d:     rgba(52,211,153,0.16);
      --red:         #f87171;
      --red-d:       rgba(248,113,113,0.16);
      --amber:       #cbd5e1;
      --amber-d:     rgba(203,213,225,0.12);
      --purple:      #a78bfa;
      --purple-d:    rgba(167,139,250,0.16);
      --slate:       #94a3b8;

      --t1: #f8fafc;
      --t2: #cbd5e1;
      --t3: #7c8ba1;

      --r3: 6px; --r4: 8px; --r5: 12px; --r6: 16px;
      --sw: 224px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; background: #12151b; color: #f8fafc; }
    body { font-family: 'Inter', system-ui, sans-serif; color: var(--t1); font-size: 13px; line-height: 1.5; -webkit-font-smoothing: antialiased; }
    button { cursor: pointer; font-family: inherit; border: none; background: none; color: inherit; }
    input, select { font-family: inherit; color: var(--t1); }

    /* ─── Layout ─────────────────────────────────────────────── */
    .shell { display: grid; grid-template-columns: var(--sw) 1fr; height: 100vh; position: relative; z-index: 1; }
    .sidebar { background: rgba(53, 58, 65, 0.55); backdrop-filter: blur(28px); border-right: 1px solid rgba(255,255,255,0.07); display: flex; flex-direction: column; overflow: hidden; }
    .brand { padding: 40px 16px 16px; border-bottom: 1px solid rgba(255,255,255,0.07); -webkit-app-region: drag; }
    .brand-name { font-size: 17px; font-weight: 700; letter-spacing: -0.4px; color: var(--t1); }
    .brand-tag { font-size: 10px; color: var(--t3); margin-top: 1px; font-weight: 500; letter-spacing: 0.2px; }

    /* wallet pill */
    .wpill { margin: 12px 12px 0; background: var(--c2); border: 1px solid rgba(255,255,255,0.08); box-shadow: none; border-radius: var(--r4); padding: 9px 11px; display: flex; align-items: center; gap: 8px; }
    .wdot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); flex-shrink: 0; box-shadow: 0 0 5px var(--green); }
    .wmeta { flex: 1; min-width: 0; }
    .wnet  { font-size: 9px; color: var(--t3); text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700; }
    .waddr { font-family: 'JetBrains Mono', monospace; font-size: 10px; color: var(--t2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wbal  { font-family: 'JetBrains Mono', monospace; font-size: 11px; font-weight: 700; color: var(--green); flex-shrink: 0; }

    nav { flex: 1; padding: 8px; overflow-y: auto; }
    .nlbl { font-size: 9px; color: var(--t3); text-transform: uppercase; letter-spacing: 0.8px; font-weight: 700; padding: 12px 8px 4px; }
    .ni { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: var(--r4); color: var(--t2); font-size: 12.5px; font-weight: 500; cursor: pointer; transition: background 0.1s, color 0.1s; user-select: none; position: relative; }
    .ni:hover { background: var(--c3); color: var(--t1); }
    .ni.on { background: var(--blue-d); color: var(--blue); }
    .ni.on::before { content: ''; position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: 2.5px; height: 18px; background: var(--blue); border-radius: 0 2px 2px 0; box-shadow: 0 0 6px rgba(96, 165, 250, 0.4); }
    .nic { font-size: 13px; width: 16px; text-align: center; flex-shrink: 0; }
    .nbadge { margin-left: auto; font-size: 9.5px; font-weight: 700; background: var(--red); color: #fff; padding: 0 5px; border-radius: 10px; line-height: 1.65; }

    .sfoot { padding: 10px 12px; border-top: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
    .sav { width: 26px; height: 26px; border-radius: 50%; background: var(--c4); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: var(--t2); flex-shrink: 0; }
    .sname { font-size: 11.5px; font-weight: 600; line-height: 1.2; }
    .sco   { font-size: 10px; color: var(--t3); }

    /* ─── Main ─────────────────────────────────────────────── */
    .main { display: flex; flex-direction: column; overflow: hidden; min-width: 0; background: rgba(60, 65, 73, 0.35); }
    .topbar { padding: 40px 24px 12px; border-bottom: 1px solid rgba(255,255,255,0.07); background: rgba(53, 58, 65, 0.3); backdrop-filter: blur(28px); box-shadow: none; display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
    .topbar .tb-title { font-size: 15px; font-weight: 700; flex: 1; -webkit-app-region: drag; }
    .topbar button, .topbar select, .topbar input, .topbar .qvac-lens-trigger { -webkit-app-region: no-drag !important; }
    .tb-sub   { font-size: 11px; color: var(--t3); margin-top: 2px; font-weight: 400; }

    /* ─── Signature Background ─────────────────────────────────────────────── */
    .aura-bg { position: fixed; inset: 0; z-index: 0; background: var(--c0); overflow: hidden; pointer-events: none; }
    .aura-bg::after { content: ''; position: absolute; inset: 0; opacity: 0.05; background-image: radial-gradient(var(--t1) 1px, transparent 1px); }
    @keyframes panGrid { 0% { transform: translateY(0); } 100% { transform: translateY(24px); } }

    .qlog-line::after { content:'_'; animation: blink 1s step-end infinite; }
    @keyframes blink { 50% { opacity: 0; } }

    /* ─── Buttons ─────────────────────────────────────────────── */
    .btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 13px; border-radius: var(--r4); font-size: 12px; font-weight: 600; transition: all 0.12s; white-space: nowrap; }
    .btn-p { background: var(--blue); color: #fff; border: none; }
    .btn-p:hover { background: #3b82f6; }
    .btn-g { background: transparent; border: 1px solid var(--borderB); color: var(--t2); }
    .btn-g:hover { background: var(--c3); color: var(--t1); }
    .btn-s { background: var(--c3); border: 1px solid var(--border); color: var(--t2); }
    .btn-s:hover { background: var(--c4); color: var(--t1); }
    .sm { padding: 4px 10px; font-size: 11px; }
    .xs { padding: 3px 8px; font-size: 10.5px; }

    .modal { background: var(--c2); color: var(--t1); }

"""

if start_root != -1 and end_root != -1:
    text = text[:start_root] + new_dark_root_css + text[end_root:]

# Replace Settings Theme section
old_settings_appearance = text.find('<span>🎨 Interface Appearance</span>')
if old_settings_appearance != -1:
    sg_start = text.rfind('<div class="sg">', 0, old_settings_appearance)
    sg_end = text.find('</div>\n            </div>\n            <div class="sg">', sg_start) + 19
    
    new_settings_html = """<div class="sg">
              <div class="sgh" style="display:flex; justify-content:space-between; align-items:center;">
                <span>🎨 Interface Appearance</span>
                <span class="badge b-paid" style="font-size:9.5px;">Slate Dark Mode</span>
              </div>
              <div class="sgb">
                <div class="fg">
                  <label class="fl">Color Scheme</label>
                  <input class="fi" value="Slate Dark / Charcoal (Permanent Studio Theme)" readonly style="font-weight:600; color:var(--blue);" />
                </div>
                <div style="font-size:11px; color:var(--t3); line-height:1.4;">
                  Application is permanently styled in the high-contrast Slate Dark Charcoal workspace. Light/Ivory theme has been completely removed.
                </div>
              </div>
            </div>"""
    text = text[:sg_start] + new_settings_html + text[sg_end:]

with open('src/index.html', 'w', encoding='utf-8') as f:
    f.write(text)

print('Permanently removed white/ivory theme and set Slate Dark as native default!')
