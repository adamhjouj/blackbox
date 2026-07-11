/**
 * The timeline UI — a single self-contained page served from the daemon.
 * No framework, no build step. ALL recorded data is rendered via textContent /
 * DOM construction (never innerHTML with interpolation), so an agent's recorded
 * command/path strings cannot inject script into the viewer (stored-XSS safe).
 *
 * The page is authored as module-level constants (CSS + client JS) concatenated
 * in renderPage(). Rules for the string contents:
 *  - CLIENT_JS uses '...' + concatenation only — no backticks/nested templates.
 *  - No `${` may appear in the emitted output except the intended interpolations
 *    in the skeleton below (gated in verification).
 *  - Literal UTF-8 glyphs over escape sequences; keep `\\` doublings as-is.
 */

const PAGE_CSS = `  :root {
    --bg:#0e1116; --panel:#161b22; --line:#232a33; --fg:#d6dde6; --dim:#8b96a3;
    --red:#ff6b6b; --amber:#e3b341; --blue:#6cb6ff; --green:#57ab5a; --mono:ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:13px/1.5 var(--mono); }
  header { padding:10px 16px; border-bottom:1px solid var(--line); display:flex; align-items:baseline; gap:12px; }
  header b { font-size:15px; letter-spacing:.5px; }
  header .sub { color:var(--dim); }
  .wrap { display:flex; height:calc(100vh - 44px); }
  aside { width:300px; border-right:1px solid var(--line); overflow:auto; flex:none; }
  main { flex:1; overflow:auto; }
  .sess { padding:10px 14px; border-bottom:1px solid var(--line); cursor:pointer; }
  .sess:hover { background:var(--panel); }
  .sess.active { background:var(--panel); border-left:3px solid var(--blue); padding-left:11px; }
  .sess .id { color:var(--fg); }
  .sess .meta { color:var(--dim); font-size:12px; margin-top:2px; }
  .verdict { padding:12px 16px; border-bottom:1px solid var(--line); color:var(--dim); }
  .verdict .flags { margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; }
  table { width:100%; border-collapse:collapse; }
  tr.row { border-bottom:1px solid var(--line); cursor:pointer; }
  tr.row:hover { background:var(--panel); }
  td { padding:5px 8px; vertical-align:top; }
  td.t { color:var(--dim); white-space:nowrap; width:1%; }
  td.ic { width:1%; text-align:center; }
  td.tool { color:var(--blue); white-space:nowrap; width:1%; }
  td.tgt { color:var(--fg); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:0; }
  td.tgt.git { color:var(--amber); }
  td.chips { width:1%; white-space:nowrap; }
  .chip { display:inline-block; padding:1px 6px; border-radius:10px; font-size:11px; margin-left:4px; }
  .chip.red { background:rgba(255,107,107,.15); color:var(--red); }
  .chip.amber { background:rgba(227,179,65,.15); color:var(--amber); }
  .chip.blue { background:rgba(108,182,255,.15); color:var(--blue); }
  .detail { background:#0a0d12; border-bottom:1px solid var(--line); padding:12px 16px; }
  .detail h4 { margin:0 0 4px; color:var(--dim); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.5px; }
  .detail pre { margin:0 0 12px; padding:10px; background:var(--panel); border-radius:6px; overflow:auto; max-height:280px; white-space:pre-wrap; word-break:break-word; }
  .kv { color:var(--dim); margin-bottom:8px; }
  .kv b { color:var(--fg); font-weight:600; }
  .empty { padding:40px; color:var(--dim); text-align:center; }
  .ok { color:var(--green); } .fail { color:var(--red); } .warn { color:var(--amber); }
`;

// Consumes: GET /api/sessions → SessionCard[] {session_id, events, started, ended,
// failures, flags, flagged}; GET /api/session/:id/events → Action[] {key, seq,
// post_seq, ts, hook_event, type, tool, target, phase, success, duration_ms,
// redaction_count, signals[]}; GET /api/event/:seq → full detail (see read-api.ts).
const CLIENT_JS = `const SIG = {
  'failed':{t:'failed',c:'red'}, 'secret-touch':{t:'secret',c:'amber'},
  'destructive-git':{t:'destructive-git',c:'red'}, 'dangerous-shell':{t:'dangerous-shell',c:'red'},
  'new-mcp-server':{t:'new-mcp',c:'blue'},
};
let current = null, expanded = new Set();

function el(tag, props, ...kids){ const n=document.createElement(tag); if(props) Object.assign(n,props); for(const k of kids) if(k!=null) n.append(k); return n; }
async function api(p){ const r = await fetch(p, {headers:{'accept':'application/json'}}); if(!r.ok) throw new Error(r.status); return r.json(); }
function shortTime(ts){ return (ts||'').replace('T',' ').replace(/\\.\\d+Z$/,'').replace('Z',''); }

function chip(s){ const m=SIG[s]||{t:s,c:'amber'}; return el('span',{className:'chip '+m.c,textContent:m.t}); }

async function loadSessions(){
  let cards; try { cards = await api('/api/sessions'); } catch { return; }
  const box = document.getElementById('sessions'); box.textContent='';
  if(!cards.length){ box.append(el('div',{className:'empty',textContent:'no sessions recorded yet'})); return; }
  for(const c of cards){
    const flagStr = c.flagged ? c.flagged+'⚠' : 'clean';
    const div = el('div',{className:'sess'+(c.session_id===current?' active':'')},
      el('div',{className:'id',textContent:c.session_id.slice(0,18)}),
      el('div',{className:'meta',textContent:c.events+' events · '+flagStr+' · '+shortTime(c.started)}));
    div.onclick = ()=>{ current=c.session_id; expanded=new Set(); render(); };
    box.append(div);
  }
  if(!current && cards.length){ current=cards[0].session_id; }
}

async function loadTimeline(){
  const main = document.getElementById('timeline');
  if(!current){ main.textContent=''; main.append(el('div',{className:'empty',textContent:'select a session'})); return; }
  let actions; try { actions = await api('/api/session/'+encodeURIComponent(current)+'/events'); } catch { return; }
  main.textContent='';
  const flagN = actions.reduce((n,a)=>n+a.signals.length,0);
  main.append(el('div',{className:'verdict'},
    el('div',{},el('b',{textContent:current}), ' · '+actions.length+' actions · ', el('span',{className:flagN?'warn':'ok',textContent:flagN?flagN+' flags':'no flags'}))));
  const tbl = el('table'); const tb = el('tbody');
  for(const a of actions){
    const failed = a.signals.includes('failed') || a.success===0;
    const flagged = a.signals.length>0;
    const icon = failed ? el('span',{className:'fail',textContent:'✗'}) : flagged ? el('span',{className:'warn',textContent:'⚠'}) : el('span',{textContent:' '});
    const tgtCls = 'tgt'+(a.type==='git_action'?' git':'');
    const chips = el('td',{className:'chips'}); a.signals.forEach(s=>chips.append(chip(s)));
    const row = el('tr',{className:'row'},
      el('td',{className:'t',textContent:shortTime(a.ts)}),
      el('td',{className:'ic'},icon),
      el('td',{className:'tool',textContent:(a.tool||a.hook_event)}),
      el('td',{className:tgtCls,title:a.target||'',textContent:a.target||''}),
      chips);
    row.onclick = ()=>toggle(a.seq, row, tb);
    tb.append(row);
    if(expanded.has(a.seq)) insertDetail(a.seq, row, tb);
  }
  tbl.append(tb); main.append(tbl);
}

async function toggle(seq, row, tb){
  if(expanded.has(seq)){ expanded.delete(seq); const n=row.nextSibling; if(n&&n.classList&&n.classList.contains('detailrow')) n.remove(); return; }
  expanded.add(seq); insertDetail(seq, row, tb);
}
async function insertDetail(seq, row, tb){
  let d; try { d = await api('/api/event/'+seq); } catch { return; }
  const box = el('div',{className:'detail'});
  const input = d.raw && d.raw.tool_input;
  box.append(el('div',{className:'kv'},
    el('b',{textContent:(d.tool_name||d.hook_event)}), ' · '+d.action_type+' · '+d.phase+' · '+shortTime(d.ts)+(d.duration_ms!=null?' · '+d.duration_ms+'ms':'')+(d.redaction_count?' · '+d.redaction_count+' redacted':'')));
  if(input!==undefined){ box.append(el('h4',{textContent:'input (redacted)'}), el('pre',{textContent:JSON.stringify(input,null,2)})); }
  if(d.output_hash){ box.append(el('h4',{textContent:'output'}), el('pre',{textContent:'elided · '+d.output_hash+'\\n'+(d.output_size_bytes||0)+' bytes'})); }
  if(d.detail && d.detail.git){ box.append(el('h4',{textContent:'git'}), el('pre',{textContent:JSON.stringify(d.detail.git,null,2)})); }
  if(d.detail && d.detail.correlation){ box.append(el('h4',{textContent:'correlation'}), el('pre',{textContent:JSON.stringify(d.detail.correlation,null,2)})); }
  box.append(el('h4',{textContent:'chain'}), el('pre',{textContent:'seq '+d.seq+'\\nprev '+d.prev_hash+'\\nhash '+d.hash}));
  const dr = el('tr',{className:'detailrow'}, el('td',{colSpan:5}, box));
  row.after(dr);
}

async function render(){ await loadSessions(); await loadTimeline(); }
render();
setInterval(render, 3000);  // auto-refresh so a live session fills in
`;

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>blackbox</title>
<style>
${PAGE_CSS}</style>
</head>
<body>
<header><b>blackbox</b> <span class="sub" id="sub">forensic timeline · reading ~/.blackbox</span></header>
<div class="wrap">
  <aside id="sessions"><div class="empty">loading…</div></aside>
  <main id="timeline"><div class="empty">select a session</div></main>
</div>
<script>
${CLIENT_JS}</script>
</body>
</html>`;
}
