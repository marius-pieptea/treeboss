# Generates the Artifacts tab sketch boards. Run: python build-boards.py (from this folder or with its path).
# Values come from design/tokens.css (light theme). Sketch only, not app code.
import json, pathlib

D = pathlib.Path(__file__).parent
P = D / "project"
P.mkdir(exist_ok=True)

CSS = """
:root{--bg:#f4f4f5;--surface:#ffffff;--surface-2:#f0f0f1;--overlay:#ffffff;--border:rgba(0,0,0,.1);--border-strong:rgba(0,0,0,.2);
--text:#1a1a1c;--muted:#55555c;--faint:#85858c;--hover:rgba(0,0,0,.05);--active:rgba(0,0,0,.09);--primary:#1a1a1c;--primary-fg:#fff;
--primary-soft:rgba(0,0,0,.08);--accent:#6d28d9;--success:#166534;--warning:#9a4608;--danger:#b91c1c;--info:#1d4ed8;
--shadow-sm:0 1px 3px 0 rgba(0,0,0,.1),0 1px 2px -1px rgba(0,0,0,.1);--shadow-lg:0 8px 30px rgba(0,0,0,.14),0 1px 0 rgba(0,0,0,.04)}
*{box-sizing:border-box}body{margin:0;font-family:"Geist",ui-sans-serif,system-ui,sans-serif;font-size:13px;line-height:1.45;color:var(--text);font-feature-settings:"cv11","ss01"}
.mono{font-family:"Geist Mono",ui-monospace,Menlo,monospace}
.frame{position:relative;overflow:hidden;background:var(--bg);display:flex}
.rail{width:48px;flex:none;display:flex;flex-direction:column;align-items:center;gap:4px;padding-top:8px;border-right:1px solid var(--border)}
.rail .it{width:40px;height:40px;border-radius:8px;display:flex;align-items:center;justify-content:center;color:var(--faint);position:relative}
.rail .it.on{color:var(--text)}.rail .it.on:before{content:"";position:absolute;left:-4px;top:10px;bottom:10px;width:2px;border-radius:2px;background:var(--primary)}
.col{display:flex;flex-direction:column;min-width:0}
.tabs{height:36px;flex:none;display:flex;align-items:stretch;border-bottom:1px solid var(--border);background:var(--bg)}
.tab{display:flex;align-items:center;gap:4px;padding:0 12px;font-size:12px;color:var(--muted);border-right:1px solid var(--border)}
.tab.on{background:var(--surface);color:var(--text);box-shadow:inset 0 -1px 0 var(--surface)}
.panel{background:var(--surface)}
.hd{display:flex;flex-direction:column;gap:8px;padding:12px;border-bottom:1px solid var(--border)}
.row{display:flex;align-items:center;gap:8px}
.h1{font-size:14px;font-weight:600;flex:1}
.input{height:32px;border:1px solid var(--border);background:var(--surface-2);border-radius:6px;padding:0 8px;display:flex;align-items:center;gap:4px;color:var(--muted);font-size:13px;flex:1;min-width:0}
.input.focus{border-color:rgba(26,26,28,.7);background:var(--surface);color:var(--text)}
.input.err{border-color:var(--danger);background:var(--surface);color:var(--text)}
.btn{height:28px;padding:0 10px;border-radius:6px;font-size:12px;font-weight:500;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;flex:none}
.btn.md{height:32px;padding:0 12px;font-size:13px}
.subtle{background:var(--surface-2);color:var(--text)}.primary{background:var(--primary);color:var(--primary-fg)}
.outline{border:1px solid var(--border-strong);color:var(--text)}.ghost{color:var(--muted)}
.ib{width:28px;height:28px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;color:var(--muted);flex:none}
.seg{display:flex;background:var(--surface-2);border-radius:8px;padding:2px;gap:2px}
.seg span{height:24px;padding:0 6px;border-radius:6px;font-size:12px;display:flex;align-items:center;gap:4px;color:var(--muted);flex:1;justify-content:center;white-space:nowrap}
.seg span.on{background:var(--surface);color:var(--text);box-shadow:var(--shadow-sm),0 0 0 1px var(--border)}
.seg b{font-weight:400;font-family:"Geist Mono",monospace;font-size:11px;color:var(--muted)}
.sel{height:28px;border:1px solid var(--border);background:var(--surface-2);border-radius:6px;padding:0 8px;display:flex;align-items:center;gap:4px;font-size:12px;flex:none;white-space:nowrap}
.gh{height:28px;display:flex;align-items:center;gap:4px;padding:0 12px;font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.gh .n{font-family:"Geist Mono",monospace;letter-spacing:0;text-transform:none;margin-left:auto}
.item{display:flex;gap:8px;align-items:flex-start;padding:8px 12px;border-bottom:1px solid var(--border)}
.item.on{background:var(--primary-soft)}
.item .t{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0}
.item .m{font-family:"Geist Mono",monospace;font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{height:18px;padding:0 6px;border-radius:4px;font-family:"Geist Mono",monospace;font-size:11px;display:inline-flex;align-items:center;background:var(--surface-2);color:var(--muted);white-space:nowrap;flex:none}
.badge.info{background:rgba(29,78,216,.1);border:1px solid rgba(29,78,216,.25);color:var(--info)}
.badge.warn{background:rgba(154,70,8,.1);border:1px solid rgba(154,70,8,.25);color:var(--warning)}
.badge.ok{background:rgba(22,101,52,.1);border:1px solid rgba(22,101,52,.25);color:var(--success)}
.ico{width:14px;height:14px;flex:none;color:var(--muted);margin-top:2px}
svg{stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:40px 24px;gap:8px}
.tile{width:40px;height:40px;border-radius:12px;background:var(--surface-2);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;color:var(--faint)}
.et{font-size:13px;font-weight:500}.eh{font-size:12px;color:var(--muted);max-width:40ch}
.card{background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:12px}
.banner{display:flex;gap:8px;align-items:flex-start;padding:12px;border-bottom:1px solid var(--border);background:rgba(154,70,8,.06);font-size:12px}
.lbl{font-size:11px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.note{position:absolute;background:#fde68a;color:#1a1a1c;font-size:12px;line-height:1.4;padding:8px 10px;border-radius:4px;box-shadow:0 2px 6px rgba(0,0,0,.15);max-width:260px;z-index:9}
.sk{background:var(--active);border-radius:6px}
.shimmer{background:linear-gradient(90deg,var(--muted) 30%,var(--faint) 50%,var(--muted) 70%);-webkit-background-clip:text;color:transparent}
.menu{position:absolute;background:var(--overlay);border:1px solid var(--border-strong);border-radius:8px;box-shadow:var(--shadow-lg);padding:4px;z-index:5}
.menu div{padding:6px 8px;border-radius:6px;font-size:13px;display:flex;align-items:center;gap:8px;white-space:nowrap}
.toast{position:absolute;background:var(--overlay);border:1px solid var(--border-strong);border-radius:8px;box-shadow:var(--shadow-lg);padding:8px 12px;font-size:13px;display:flex;gap:12px;align-items:center;z-index:5}
.kbd{font-family:"Geist Mono",monospace;font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:4px;padding:0 4px}
a{color:var(--primary);text-decoration:underline;text-underline-offset:2px}
"""

I = {
 "layers":'<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
 "document":'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/>',
 "slides":'<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
 "design":'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
 "other":'<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
 "search":'<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
 "link":'<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
 "refresh":'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
 "copy":'<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
 "more":'<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
 "ext":'<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
 "ask":'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
 "back":'<path d="m15 18-6-6 6-6"/>',
 "down":'<path d="m6 9 6 6 6-6"/>',
 "right":'<path d="m9 18 6-6-6-6"/>',
 "warn":'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
 "lock":'<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
 "user":'<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
 "globe":'<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
 "x":'<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
 "trash":'<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
 "bot":'<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
 "files":'<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
 "git":'<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
 "finger":'<path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"/><path d="M14 13.12c0 2.38 0 6.38-1 8.88"/><path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"/><path d="M2 12a10 10 0 0 1 18-6"/><path d="M2 16h.01"/><path d="M21.8 16c.2-2 .131-5.354 0-6"/><path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"/><path d="M8.65 22c.21-.66.45-1.32.57-2"/><path d="M9 6.8a6 6 0 0 1 9 5.2v2"/>',
 "check":'<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
 "shield":'<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
 "terminal":'<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
 "settings":'<circle cx="12" cy="12" r="3"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
}
def ic(n, s=14, c=""):
    return f'<svg viewBox="0 0 24 24" width="{s}" height="{s}" style="flex:none;{c}">{I[n]}</svg>'

def page(name, w, h, body):
    html = f"""<!doctype html><html><head><meta charset="utf-8"><title>{name}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body><div class="frame" style="width:{w}px;height:{h}px">{body}</div></body></html>"""
    (P / f"{name}.dc.html").write_text(html, encoding="utf-8")

def note(x, y, text, w=240):
    return f'<div class="note" style="left:{x}px;top:{y}px;width:{w}px">{text}</div>'

def rail(on="artifacts"):
    items = [("bot","sessions"),("files","explorer"),("search","search"),("git","git"),("finger","evidence"),("design","designsys"),("check","checklists"),("layers","artifacts")]
    s = "".join(f'<div class="it{" on" if k==on else ""}">{ic(n,19)}</div>' for n,k in items)
    return f'<div class="rail">{s}<div style="flex:1"></div><div class="it">{ic("settings",19)}</div></div>'

def tabstrip(active="Artifacts"):
    names = [("bot","Agents"),("finger","Evidence"),("design","Design"),("check","Checklists"),("layers","Artifacts")]
    s = "".join(f'<div class="tab{" on" if n==active else ""}">{ic(i,12)}{n}{(" "+ic("x",12,"color:var(--faint);margin-left:4px")) if n==active else ""}</div>' for i,n in names)
    return f'<div class="tabs">{s}<div style="flex:1"></div></div>'

INTENT = {"document":"Documents","slides":"Slides","design":"Designs","other":"Other"}

def seg(on="all", counts=None, short=False):
    c = counts or {}
    labels = [("all","All"),("document","Docs" if short else "Documents"),("slides","Slides"),("design","Designs"),("other","Other")]
    return '<div class="seg">' + "".join(f'<span class="{"on" if k==on else ""}">{l}{(" <b>"+str(c[k])+"</b>") if k in c else ""}</span>' for k,l in labels) + "</div>"

def header(add_state="idle", query="", segon="all", counts=None, group="Session", short=False, count=None):
    if add_state == "idle":
        add = f'<div class="input">{ic("link",14,"color:var(--faint)")}Paste a claude.ai artifact link</div><span class="btn subtle">Add</span>'
    elif add_state == "typed":
        add = f'<div class="input focus">{ic("link",14,"color:var(--faint)")}<span class="mono" style="font-size:12px">https://claude.ai/artifact/9c41e7d2-…</span></div><span class="btn primary">Add</span>'
    else:
        add = f'<div class="input err">{ic("link",14,"color:var(--faint)")}<span class="mono" style="font-size:12px">https://claude.ai/chat/4be1…</span></div><span class="btn subtle">Add</span>'
    err = '<div style="font-size:11px;color:var(--danger);margin-top:-4px">That is a chat link. Paste a link that starts with claude.ai/artifact/.</div>' if add_state=="err" else ""
    q = f'<span style="color:var(--text)">{query}</span>' if query else "Search title, session, link"
    cnt = f'<span class="mono" style="font-size:11px;color:var(--muted)">{count}</span>' if count is not None else ""
    return f'''<div class="hd">
<div class="row">{ic("layers",16,"color:var(--muted)")}<div class="h1" style="flex:none">Artifacts</div>{cnt}<div style="flex:1"></div><span class="ib">{ic("refresh",16)}</span></div>
<div class="row">{add}</div>{err}
<div class="row"><div class="input" style="height:28px;font-size:12px">{ic("search",14,"color:var(--faint)")}{q}</div><span class="sel">Group: {group} {ic("down",12,"color:var(--faint)")}</span></div>
{seg(segon, counts, short)}
</div>'''

def item(intent, title, meta, on=False, badge=""):
    b = f'<span class="badge{(" "+badge[1]) if isinstance(badge,tuple) else ""}">{badge[0] if isinstance(badge,tuple) else badge}</span>' if badge else ""
    return f'<div class="item{" on" if on else ""}">{ic(intent,14,"margin-top:2px;color:var(--muted)")}<div style="min-width:0;flex:1"><div class="row" style="gap:4px"><span class="t">{title}</span>{b}</div><div class="m">{meta}</div></div></div>'

def gh(label, n, open_=True):
    return f'<div class="gh">{ic("down" if open_ else "right",12,"color:var(--faint)")}{label}<span class="n">{n}</span></div>'

# ---------------- detail pieces ----------------
def dhead(title, intent, meta, shared=False, narrow=False, back=False):
    bk = f'<span class="ib" style="margin-left:-6px">{ic("back",16)}</span>' if back else ""
    badge = '<span class="badge info">shared with you</span>' if shared else f'<span class="badge">{intent}</span>'
    acts = (f'<span class="ib">{ic("refresh",16)}</span><span class="ib">{ic("copy",16)}</span><span class="ib">{ic("more",16)}</span>'
            if narrow else
            f'<span class="btn subtle">{ic("ask",14)}Ask an agent</span><span class="btn outline">{ic("ext",14)}Open in claude.ai</span><span class="ib">{ic("refresh",16)}</span><span class="ib">{ic("copy",16)}</span><span class="ib">{ic("more",16)}</span>')
    second = (f'<div class="row" style="gap:8px;margin-top:8px"><span class="btn subtle">{ic("ask",14)}Ask an agent</span><span class="btn outline">{ic("ext",14)}Open in claude.ai</span></div>' if narrow else "")
    return f'''<div style="padding:12px 16px;border-bottom:1px solid var(--border);background:var(--surface)">
<div class="row" style="align-items:flex-start">{bk}<div style="min-width:0;flex:1"><div style="font-size:14px;font-weight:600;line-height:1.25">{title}</div>
<div class="row" style="gap:8px;margin-top:4px;flex-wrap:wrap">{badge}<span class="mono" style="font-size:11px;color:var(--muted)">{meta}</span></div></div>
<div class="row" style="gap:4px">{acts}</div></div>{second}</div>'''

def framestrip(text):
    return f'<div class="row" style="height:28px;padding:0 12px;border-bottom:1px solid var(--border);font-size:11px;color:var(--muted);gap:4px">{ic("shield",12,"color:var(--faint)")}<span class="mono">{text}</span></div>'

def design_preview():
    # The artifact's own HTML (a design board made by a session); drawn neutrally.
    return '''<div style="padding:24px;display:flex;flex-direction:column;gap:12px;font-family:Geist,sans-serif">
<div style="font-size:18px;font-weight:600">Shelf rail · three options</div>
<div style="display:flex;gap:16px">
 <div style="flex:1;border:1px solid #e4e4e7;border-radius:8px;padding:12px;height:220px"><div style="font-size:12px;color:#55555c">A · rail on top of the composer</div><div style="margin-top:12px;height:24px;background:#f0f0f1;border-radius:6px"></div><div style="margin-top:6px;height:24px;background:#f0f0f1;border-radius:6px"></div><div style="margin-top:60px;height:56px;border:1px solid #e4e4e7;border-radius:12px"></div></div>
 <div style="flex:1;border:1px solid #e4e4e7;border-radius:8px;padding:12px;height:220px"><div style="font-size:12px;color:#55555c">B · rail in the header</div><div style="margin-top:12px;height:32px;background:#f0f0f1;border-radius:6px"></div><div style="margin-top:110px;height:56px;border:1px solid #e4e4e7;border-radius:12px"></div></div>
 <div style="flex:1;border:1px solid #e4e4e7;border-radius:8px;padding:12px;height:220px"><div style="font-size:12px;color:#55555c">C · side shelf</div><div style="display:flex;gap:6px;margin-top:12px"><div style="width:60px;height:170px;background:#f0f0f1;border-radius:6px"></div><div style="flex:1;height:170px;border:1px dashed #d4d4d8;border-radius:6px"></div></div></div>
</div>
<div style="font-size:13px;color:#55555c;max-width:62ch">Option A keeps the heads next to where you type. B saves vertical space but hides state when the header scrolls. C works only above 1200 px.</div>
</div>'''

def doc_preview():
    return '''<div style="padding:32px 40px;max-width:820px;font-family:Geist,sans-serif">
<div style="font-size:18px;font-weight:600">Hydra pair effort: how enforcement works</div>
<div style="font-size:12px;color:#55555c;margin-top:4px">Written by the planner head · 6 sections</div>
<div style="font-size:16px;font-weight:600;margin-top:20px">1. What the lead asks for</div>
<div style="font-size:13px;line-height:1.625;margin-top:6px;color:#1a1a1c">Each pair carries an effort level. When the lead opens a head it passes the level along, and the engine rejects a run that would go over it…</div>
<div style="height:10px;background:#f0f0f1;border-radius:4px;margin-top:14px;width:92%"></div><div style="height:10px;background:#f0f0f1;border-radius:4px;margin-top:8px;width:80%"></div><div style="height:10px;background:#f0f0f1;border-radius:4px;margin-top:8px;width:86%"></div>
<div style="font-size:16px;font-weight:600;margin-top:20px">2. Where it is checked</div>
<div style="height:10px;background:#f0f0f1;border-radius:4px;margin-top:10px;width:90%"></div><div style="height:10px;background:#f0f0f1;border-radius:4px;margin-top:8px;width:70%"></div>
</div>'''

def errpanel(icon, title, hint, actions):
    return f'<div class="empty">{f"<div class=tile>{ic(icon,20)}</div>"}<div class="et">{title}</div><div class="eh">{hint}</div><div class="row" style="margin-top:8px;justify-content:center">{actions}</div></div>'

# ---------------- data ----------------
THREE = [
 ("design","Shelf rail · three options","agent-pane-redesign · 2h ago",True,""),
 ("document","Hydra pair effort: how enforcement works","hydra-effort · yesterday",False,""),
 ("slides","Traffic recorder: what it captures","traffic-recorder · Nov 21",False,""),
]

boards = []
def add(title, name, w, h, body):
    page(name, w, h, body); boards.append({"title": title, "w": w, "h": h, "file": f"project/{name}.dc.html"})

# 1 Wide · empty
LW = 364
body = rail() + f'''<div class="col" style="flex:1">{tabstrip()}<div style="flex:1;display:flex;min-height:0">
<div class="col panel" style="width:{LW}px;border-right:1px solid var(--border)">{header(count=0)}
<div class="empty" style="margin:12px;border:1px dashed var(--border);border-radius:12px"><div class="tile">{ic("layers",20)}</div><div class="et">No artifacts yet</div>
<div class="eh">When a Claude session publishes an artifact to your claude.ai account, it shows up here. You can also paste a link above.</div></div></div>
<div class="col" style="flex:1;align-items:center;justify-content:center">
<div class="empty"><div class="tile">{ic("layers",20)}</div><div class="et">Nothing to preview</div><div class="eh">Pick an artifact on the left to see it here.</div></div></div>
</div></div>''' + note(420, 520, "Search, Group and the filter stay visible but disabled (50%) while the list is empty, so the layout does not jump when the first artifact arrives.")
add("Wide · Empty (0 artifacts)", "Wide-Empty", 1340, 820, body)

# 2 Wide · 3 artifacts, own design selected, menu open
items = "".join(item(*t) for t in THREE)
body = rail() + f'''<div class="col" style="flex:1">{tabstrip()}<div style="flex:1;display:flex;min-height:0">
<div class="col panel" style="width:{LW}px;border-right:1px solid var(--border)">{header(group="Date", count=3, counts={"all":3,"document":1,"slides":1,"design":1,"other":0})}
<div style="flex:1;overflow:hidden">{gh("Today",1)}{item(*THREE[0])}{gh("Yesterday",1)}{item(*THREE[1])}{gh("Earlier",1)}{item(*THREE[2])}</div></div>
<div class="col" style="flex:1;min-width:0">{dhead("Shelf rail · three options","design","from <a>agent-pane-redesign</a> · created Nov 26, 11:42 · updated 2h ago")}
{framestrip("Local copy · read 2 min ago · sandboxed, no scripts leave the frame")}
<div style="flex:1;padding:16px;overflow:hidden"><div style="background:#fff;border:1px solid var(--border);border-radius:8px;height:100%;overflow:hidden">{design_preview()}</div></div>
</div></div></div>
<div class="menu" style="right:20px;top:92px;width:220px"><div>{ic("ask",14,"color:var(--muted)")}Ask an agent</div><div>{ic("refresh",14,"color:var(--muted)")}Refresh</div><div>{ic("copy",14,"color:var(--muted)")}Copy link</div><div style="border-top:1px solid var(--border);border-radius:0;margin:4px -4px 0;padding-left:12px"></div><div style="color:var(--danger)">{ic("trash",14)}Remove from list</div></div>''' \
 + note(1040, 300, "⋯ menu open. Remove from list only drops it from TreeBoss; nothing is deleted on claude.ai. No confirm dialog: a toast with Undo (see the 40+ board).") \
 + note(560, 640, "Ask an agent: puts “About this artifact: https://claude.ai/artifact/… ” into the composer of the session that made it if it is open, else the active session. Does not send.", 300) \
 + note(700, 150, "The session name is a link: it opens that session's Agents tab.", 200)
add("Wide · 3 artifacts, own design open (menu open)", "Wide-Three-Own", 1340, 820, body)

# 3 Wide · 40+ grouped by session, filter slides? keep All with search; preview loading; toast
rows = (gh("agent-pane-redesign",9)+item("design","Shelf rail · three options","2h ago · design",False)+item("slides","Head cards: before and after","3h ago",True)+item("document","Composer toolbar spec: every state, including the narrow window and 130% zoom","3h ago")
 +item("document","Tool timeline wording","Nov 25")+gh("hydra-effort",6)+item("document","Hydra pair effort: how enforcement works","yesterday")+item("other","effort-matrix.json viewer","yesterday")
 +gh("traffic-recorder",12)+item("slides","Traffic recorder: what it captures","Nov 21")+item("document","Recorder privacy notes","Nov 21")+gh("Pasted links",8)+item("design","Q4 marketplace landing page","added Nov 20",False,("shared","info"))+item("document","Onboarding checklist v2","added Nov 18")+gh("windows-path-banner",4, False)+gh("Older sessions",4, False))
body = rail() + f'''<div class="col" style="flex:1">{tabstrip()}<div style="flex:1;display:flex;min-height:0">
<div class="col panel" style="width:{LW}px;border-right:1px solid var(--border)">{header(count=43, counts={"all":43,"document":19,"slides":9,"design":11,"other":4})}
<div style="flex:1;overflow:hidden">{rows}</div></div>
<div class="col" style="flex:1;min-width:0">{dhead("Head cards: before and after","slides","from <a>agent-pane-redesign</a> · created Nov 26, 10:58")}
<div class="row" style="height:28px;padding:0 12px;border-bottom:1px solid var(--border);font-size:11px;gap:4px">{ic("refresh",12,"color:var(--faint)")}<span class="mono" style="color:var(--muted)">Reading from claude.ai…</span></div>
<div style="flex:1;padding:16px"><div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;height:100%;padding:24px;display:flex;flex-direction:column;gap:12px">
<div class="sk" style="height:18px;width:40%"></div><div class="sk" style="height:12px;width:70%"></div><div class="sk" style="flex:1"></div></div></div>
</div></div></div>
<div class="toast" style="left:620px;bottom:24px">Removed “Recorder draft” from the list. It is still on claude.ai.<span style="font-weight:500;text-decoration:underline">Undo</span></div>''' \
 + note(400, 96, "Grouped by session (default). Groups sort by newest artifact; groups past the 5th start collapsed. Pasted links get their own group. Counts in the filter are for the current search.", 270) \
 + note(400, 700, "Long titles truncate on one line in the list (full title in the tooltip and in the detail header, which wraps).", 250)
add("Wide · 43 artifacts, by session, preview loading", "Wide-Many-Loading", 1340, 820, body)

# 4 Wide · shared by others: summary + open live view
body = rail() + f'''<div class="col" style="flex:1">{tabstrip()}<div style="flex:1;display:flex;min-height:0">
<div class="col panel" style="width:{LW}px;border-right:1px solid var(--border)">{header(group="Date", count=4)}
<div style="flex:1">{gh("Today",2)}{item(*THREE[0][:3],False,"")}{item("design","Q4 marketplace landing page","pasted · 1 min ago",True,("shared","info"))}{gh("Yesterday",1)}{item(*THREE[1])}{gh("Earlier",1)}{item(*THREE[2])}</div></div>
<div class="col" style="flex:1;min-width:0">{dhead("Q4 marketplace landing page","design","pasted Nov 26, 14:10 · claude.ai/artifact/9c41e7d2…", shared=True)}
<div style="flex:1;padding:24px 32px;overflow:hidden"><div style="max-width:760px;display:flex;flex-direction:column;gap:16px">
<div class="card"><div class="lbl">Summary from claude.ai</div><div style="font-size:13px;line-height:1.625;margin-top:8px">A landing page for the plugin marketplace: hero with search, three featured plugins, a pricing strip with Free and Team columns, and a footer with docs links. Built as a single HTML page with light and dark versions.</div></div>
<div class="row" style="gap:12px;align-items:flex-start"><div style="flex:1;font-size:12px;color:var(--muted);line-height:1.625">Someone else owns this artifact, so TreeBoss can only read its summary. To see the page itself, open it in a browser view signed in to claude.ai.</div>
<span class="btn md primary">{ic("globe",16)}Open live view</span></div>
</div></div>
</div></div></div>''' \
 + note(860, 440, "Desktop: the live view opens in the embedded browser inside this pane (next board). Web: it opens the streamed browser pane, same as other browser views; this pane keeps the summary.", 300) \
 + note(860, 560, "Ask an agent works here too: the agent gets the link and the summary, not the page.", 300)
add("Wide · Shared with you: summary + live view button", "Wide-Shared", 1340, 820, body)

# 5 Wide · live view open (desktop)
body = rail() + f'''<div class="col" style="flex:1">{tabstrip()}<div style="flex:1;display:flex;min-height:0">
<div class="col panel" style="width:{LW}px;border-right:1px solid var(--border)">{header(group="Date", count=4)}
<div style="flex:1">{gh("Today",2)}{item(*THREE[0][:3],False,"")}{item("design","Q4 marketplace landing page","pasted · 1 min ago",True,("shared","info"))}{gh("Yesterday",1)}{item(*THREE[1])}{gh("Earlier",1)}{item(*THREE[2])}</div></div>
<div class="col" style="flex:1;min-width:0">{dhead("Q4 marketplace landing page","design","pasted Nov 26, 14:10 · live view", shared=True)}
<div class="row" style="height:36px;padding:0 8px;border-bottom:1px solid var(--border);background:var(--surface);gap:4px"><span class="ib">{ic("back",16)}</span><span class="ib">{ic("refresh",16)}</span>
<div class="input" style="height:28px"><span class="mono" style="font-size:12px;color:var(--text)">https://claude.ai/artifact/9c41e7d2-5a0b-4c1e-8f3a-2d6b1e0c77a4</span></div><span class="btn ghost">{ic("x",14)}Close live view</span></div>
<div style="flex:1;background:#fff;display:flex;flex-direction:column;align-items:center;padding:40px;gap:16px;font-family:Geist,sans-serif">
<div style="font-size:22px;font-weight:600;color:#1a1a1c">Find a plugin for your team</div><div style="width:420px;height:40px;border:1px solid #d4d4d8;border-radius:8px"></div>
<div style="display:flex;gap:16px;margin-top:16px"><div style="width:200px;height:140px;border:1px solid #e4e4e7;border-radius:8px"></div><div style="width:200px;height:140px;border:1px solid #e4e4e7;border-radius:8px"></div><div style="width:200px;height:140px;border:1px solid #e4e4e7;border-radius:8px"></div></div></div>
</div></div></div>''' + note(880, 620, "The page here is claude.ai itself in the embedded browser. If that browser is not signed in, claude.ai shows its own sign-in page in this frame; the sign-in is kept for next time.", 300)
add("Wide · Live view open (desktop)", "Wide-LiveView", 1340, 820, body)

# 6 Narrow · 1 artifact + pasting a link (bad link)
body = f'''<div class="col" style="flex:1">{tabstrip()}<div class="col panel" style="flex:1">{header(add_state="err", count=1, group="Date", short=True)}
{gh("Today",1)}{item("design","Shelf rail · three options","agent-pane-redesign · 2h ago")}</div></div>''' \
 + note(300, 380, "Narrow (left pane under ~760px): list only. Clicking a row opens the detail in its place, with a back arrow (next board). The filter uses “Docs” to fit.", 270) \
 + note(300, 500, "Add accepts claude.ai/artifact/… links. Enter adds. A good link is read at once: owned → full preview, someone else's → summary.", 270)
add("Narrow 600 · 1 artifact, wrong link pasted", "Narrow-One-BadLink", 600, 820, body)

# 7 Narrow · detail drill-in, doc preview
body = f'''<div class="col" style="flex:1">{tabstrip()}<div class="col" style="flex:1;min-height:0">
{dhead("Hydra pair effort: how enforcement works","document","<a>hydra-effort</a> · updated yesterday", narrow=True, back=True)}
{framestrip("Local copy · read yesterday, 18:20 · sandboxed")}
<div style="flex:1;padding:12px;overflow:hidden"><div style="background:#fff;border:1px solid var(--border);border-radius:8px;height:100%;overflow:hidden">{doc_preview()}</div></div></div></div>''' \
 + note(300, 640, "Narrow: icon buttons stay on the title row (Refresh, Copy link, ⋯); Ask an agent and Open in claude.ai go to a second row so the title keeps its width.", 270)
add("Narrow 600 · Artifact open (back to list)", "Narrow-Detail", 600, 820, body)

# 8 Narrow · errors
def errbox(content, h):
    return f'<div style="height:{h}px;border-bottom:8px solid var(--bg);background:var(--surface);overflow:hidden;position:relative">{content}</div>'
e1 = f'''<div class="hd"><div class="row">{ic("layers",16,"color:var(--muted)")}<div class="h1" style="flex:none">Artifacts</div><span class="mono" style="font-size:11px;color:var(--muted)">3</span></div></div>
<div class="banner">{ic("warn",14,"color:var(--warning);margin-top:2px")}<div style="flex:1"><div style="font-weight:500;font-size:13px">Claude Code is not signed in to claude.ai</div><div style="color:var(--muted);margin-top:2px">Artifacts live in a claude.ai account, so TreeBoss can't read or refresh them. Run <span class="mono">/login</span> in Claude Code and pick your claude.ai account, then refresh. The list below is from the last read.</div></div><span class="btn subtle">{ic("refresh",14)}Refresh</span></div>
{item("design","Shelf rail · three options","agent-pane-redesign · 2h ago")}{item("document","Hydra pair effort: how enforcement works","hydra-effort · yesterday")}'''
e2 = errpanel("lock","Your plan does not include artifacts","claude.ai turned down this account for artifacts. Check which plan the account Claude Code uses is on.", f'<span class="btn outline">{ic("ext",14)}Open claude.ai</span><span class="btn subtle">{ic("refresh",14)}Try again</span>')
e3 = errpanel("user","You don't have access to this artifact","It may be private, or the owner stopped sharing it. Ask them for a new link.", f'<span class="btn outline">{ic("ext",14)}Open in claude.ai</span><span class="btn ghost" style="color:var(--danger)">{ic("trash",14)}Remove from list</span>')
e4 = errpanel("terminal","Claude Code is too old for artifacts",'Artifacts need Claude Code <span class="mono">2.1.318</span> or newer. This machine has <span class="mono">2.1.290</span>.', f'<span class="btn primary">{ic("copy",14)}Copy <span class="mono">claude update</span></span><span class="btn subtle">{ic("refresh",14)}Check again</span>')
lab = lambda t: f'<div class="lbl" style="padding:8px 12px 0">{t}</div>'
body = f'''<div class="col" style="flex:1">{errbox(lab("Account · banner over the list")+e1, 330)}{errbox(lab("Account · in the preview pane")+e2, 260)}{errbox(lab("One artifact · in the preview pane")+e3, 260)}{errbox(lab("Install · banner and preview pane")+e4, 270)}</div>''' \
 + note(340, 20, "Account errors (not signed in, plan, too old) show once, as a banner over the list; the old list stays readable. A one-artifact error shows only in its preview.", 240)
add("Narrow 600 · Errors (4)", "Narrow-Errors", 600, 1140, body)

# 9 Entry points
body = f'''<div style="display:flex;gap:24px;padding:24px;width:100%">
<div style="display:flex;flex-direction:column;gap:8px"><div class="lbl">Activity rail</div><div style="position:relative;background:var(--bg);border:1px solid var(--border);border-radius:8px;height:400px;width:48px">{rail().replace('class="rail"','class="rail" style="height:100%;border:0"')}
<div style="position:absolute;left:56px;top:316px;background:var(--overlay);border:1px solid var(--border-strong);border-radius:6px;box-shadow:var(--shadow-lg);padding:4px 8px;font-size:11px;white-space:nowrap">Artifacts</div></div></div>
<div style="flex:1;display:flex;flex-direction:column;gap:8px"><div class="lbl">Editor tab strip</div><div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">{tabstrip()}</div>
<div class="lbl" style="margin-top:16px">Command palette</div>
<div style="width:600px;background:var(--overlay);border:1px solid var(--border-strong);border-radius:12px;box-shadow:var(--shadow-lg);overflow:hidden">
<div style="padding:12px;border-bottom:1px solid var(--border);font-size:13px">artif<span style="border-left:1.5px solid var(--text);margin-left:1px"></span></div>
<div style="padding:4px"><div class="menu" style="position:static;border:0;box-shadow:none;padding:0"><div style="background:var(--hover)">{ic("layers",14,"color:var(--muted)")}Open artifacts<span style="flex:1"></span></div><div>{ic("link",14,"color:var(--muted)")}Add artifact link…</div><div>{ic("refresh",14,"color:var(--muted)")}Refresh artifacts</div></div></div></div>
</div></div>''' + note(700, 300, "Rail icon: Layers, after Checklists. The tab is a singleton like Evidence: opening it again focuses the open tab. “Add artifact link…” opens the tab with the link field focused.", 260)
add("Entry points · rail, tab strip, command palette", "Entry-Points", 1000, 460, body)

# layout row
x = 0
for b in boards:
    b["x"] = x; b["y"] = 0; x += b["w"] + 70
(D / "canvas-additions.json").write_text(json.dumps({"row": "Artifacts tab · claude.ai artifacts (sketch)", "boards": boards}, indent=2, ensure_ascii=False), encoding="utf-8")
print("boards:", len(boards))
