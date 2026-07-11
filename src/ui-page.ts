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
  .verdict .combos { margin-top:8px; display:flex; flex-direction:column; gap:5px; }
  .combo { color:var(--fg); font-size:12px; }
  .verdict .chip { margin-left:0; }
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
//
// Poll-safe rendering: the 3s poll compares JSON fingerprints per pane and
// returns before ANY DOM write when nothing changed (idle polls cost zero DOM
// work — no scroll jump, no selection loss, no animation replay). When a live
// session grows, rows reconcile by index against the append-only action list:
// changed rows (a Pre paired by its Post — read-api mutates in place) patch
// their cells; new rows append. Expanded dossiers persist across polls.
const CLIENT_JS = `const SIG = {
  'failed':{t:'failed',c:'red'}, 'secret-touch':{t:'secret',c:'amber'},
  'destructive-git':{t:'destructive-git',c:'red'}, 'dangerous-shell':{t:'dangerous-shell',c:'red'},
  'new-mcp-server':{t:'new-mcp',c:'blue'}, 'auth-edit':{t:'auth-edit',c:'red'},
  'mass-diff':{t:'mass-diff',c:'red'}, 'external-send':{t:'external-send',c:'amber'},
  'injection-output':{t:'injection',c:'amber'},
};
const VC = { high:'red', medium:'amber', low:'blue', none:'', unscored:'' };
let current = null, expanded = new Set();
let fpSessions = null, fpTimeline = null;
let rowState = [];            // [{fp, tr, a}] parallel to the rendered action list
let tbody = null;
const sessEls = new Map();    // session_id -> rail card element
const cardsById = new Map();  // session_id -> latest SessionCard (verdict/combos)
const verdict = { root:null, id:null, pill:null, mid:null, combos:null };

function el(tag, props, ...kids){ const n=document.createElement(tag); if(props) Object.assign(n,props); for(const k of kids) if(k!=null) n.append(k); return n; }
async function api(p){ const r = await fetch(p, {headers:{'accept':'application/json'}}); if(!r.ok) throw new Error(r.status); return r.json(); }
function shortTime(ts){ return (ts||'').replace('T',' ').replace(/\\.\\d+Z$/,'').replace('Z',''); }

function chip(s){ const m=SIG[s]||{t:s,c:'amber'}; return el('span',{className:'chip '+m.c,textContent:m.t}); }

function select(id){
  if(current === id) return;
  current = id; expanded = new Set();
  fpTimeline = null; rowState = []; tbody = null; verdict.root = null;
  for(const [sid, d] of sessEls) d.classList.toggle('active', sid === current);
  loadTimeline();
}

async function loadSessions(){
  let cards; try { cards = await api('/api/sessions'); } catch { return; }
  cardsById.clear(); for(const c of cards) cardsById.set(c.session_id, c);
  const fp = JSON.stringify(cards);
  if(fp === fpSessions) return;
  fpSessions = fp;
  renderSessions(cards);
}

function renderSessions(cards){
  const box = document.getElementById('sessions');
  if(!cards.length){
    sessEls.clear(); box.textContent='';
    box.append(el('div',{className:'empty',textContent:'no sessions recorded yet'}));
    return;
  }
  if(!current) current = cards[0].session_id;
  if(!sessEls.size) box.textContent='';                       // clear loading/empty placeholder
  const live = new Set(cards.map(c=>c.session_id));
  for(const [sid, d] of sessEls) if(!live.has(sid)){ d.remove(); sessEls.delete(sid); }
  let prev = null;
  for(const c of cards){
    let d = sessEls.get(c.session_id);
    if(!d){
      d = el('div',{className:'sess'}, el('div',{className:'id'}), el('div',{className:'meta'}));
      d.onclick = ()=>select(c.session_id);
      sessEls.set(c.session_id, d);
    }
    const flagStr = (c.verdict && c.verdict!=='none' && c.verdict!=='unscored') ? c.verdict.toUpperCase() : (c.flagged ? c.flagged+'⚠' : 'clean');
    const idText = c.session_id.slice(0,18);
    const metaText = c.events+' events · '+flagStr+' · '+shortTime(c.started);
    if(d.firstChild.textContent !== idText) d.firstChild.textContent = idText;
    if(d.lastChild.textContent !== metaText) d.lastChild.textContent = metaText;
    d.classList.toggle('active', c.session_id === current);
    const want = prev ? prev.nextSibling : box.firstChild;    // reposition only on real reorder
    if(want !== d) box.insertBefore(d, want);
    prev = d;
  }
}

async function loadTimeline(){
  const main = document.getElementById('timeline');
  if(!current){
    if(fpTimeline !== ''){ fpTimeline=''; main.textContent=''; main.append(el('div',{className:'empty',textContent:'select a session'})); }
    return;
  }
  let actions; try { actions = await api('/api/session/'+encodeURIComponent(current)+'/events'); } catch { return; }
  const fp = JSON.stringify([current, actions]);
  if(fp === fpTimeline) return;
  fpTimeline = fp;
  renderTimeline(main, actions);
}

function renderTimeline(main, actions){
  // Incremental only when the rendered prefix still matches the append-only list;
  // anything else (session switch, db swap/shrink) is a full rebuild.
  const incremental = tbody && tbody.isConnected && rowState.length > 0 &&
    rowState.length <= actions.length &&
    rowState[0].a.key === actions[0].key;
  if(!incremental){
    main.textContent='';
    verdict.root = null; rowState = [];
    ensureVerdict(main);
    const tbl = el('table'); tbody = el('tbody'); tbl.append(tbody); main.append(tbl);
  }
  updateVerdict(actions);
  for(let i=0;i<actions.length;i++){
    const a = actions[i];
    if(i < rowState.length){
      const st = rowState[i];
      const afp = JSON.stringify(a);
      if(st.fp !== afp){
        if(st.a.key !== a.key){ fpTimeline = null; rowState = []; tbody = null; renderTimeline(main, actions); return; }
        buildRowCells(a, st.tr);
        st.fp = afp; st.a = a;
        if(expanded.has(a.seq)){ removeDetail(st.tr); insertDetail(a.seq, st.tr); }  // refresh once on Pre→Post pairing
      }
    } else {
      appendRow(a);
    }
  }
}

function ensureVerdict(main){
  verdict.id = el('b',{});
  verdict.pill = el('span',{className:'chip'});
  verdict.mid = document.createTextNode('');
  verdict.combos = el('div',{className:'combos'});
  verdict.root = el('div',{className:'verdict'}, el('div',{}, verdict.id, ' ', verdict.pill, verdict.mid), verdict.combos);
  main.append(verdict.root);
}

function updateVerdict(actions){
  const card = cardsById.get(current) || {};
  const v = card.verdict || 'unscored';
  if(verdict.id.textContent !== current.slice(0,18)) verdict.id.textContent = current.slice(0,18);
  const pillText = v.toUpperCase() + (card.ruleset_version ? ' · '+card.ruleset_version : '');
  if(verdict.pill.textContent !== pillText) verdict.pill.textContent = pillText;
  const pc = 'chip' + (VC[v] ? ' '+VC[v] : '');
  if(verdict.pill.className !== pc) verdict.pill.className = pc;
  const mid = ' · '+actions.length+' actions'+(card.score ? ' · score '+card.score : '');
  if(verdict.mid.data !== mid) verdict.mid.data = mid;
  const combos = card.combos || [];
  const cfp = JSON.stringify(combos);
  if(verdict.combos.__fp !== cfp){
    verdict.combos.__fp = cfp;
    verdict.combos.textContent='';
    for(const c of combos){
      verdict.combos.append(el('div',{className:'combo'},
        el('span',{className:'chip red',textContent:c.id}),
        ' '+c.note+' (#'+c.antecedent_seq+' → #'+c.consequent_seq+')'));
    }
  }
}

function buildRowCells(a, tr){
  tr.textContent='';
  const failed = a.signals.includes('failed') || a.success===0;
  const flagged = a.signals.length>0;
  const icon = failed ? el('span',{className:'fail',textContent:'✗'}) : flagged ? el('span',{className:'warn',textContent:'⚠'}) : el('span',{textContent:' '});
  const tgtCls = 'tgt'+(a.type==='git_action'?' git':'');
  const chips = el('td',{className:'chips'}); a.signals.forEach(s=>chips.append(chip(s)));
  tr.append(
    el('td',{className:'t',textContent:shortTime(a.ts)}),
    el('td',{className:'ic'},icon),
    el('td',{className:'tool',textContent:(a.tool||a.hook_event)}),
    el('td',{className:tgtCls,title:a.target||'',textContent:a.target||''}),
    chips);
}

function appendRow(a){
  const tr = el('tr',{className:'row'});
  buildRowCells(a, tr);
  tr.onclick = ()=>toggle(a.seq, tr);
  tbody.append(tr);
  rowState.push({fp: JSON.stringify(a), tr, a});
  if(expanded.has(a.seq)) insertDetail(a.seq, tr);
}

function removeDetail(row){
  const n = row.nextSibling;
  if(n && n.classList && n.classList.contains('detailrow')) n.remove();
}

async function toggle(seq, row){
  if(expanded.has(seq)){ expanded.delete(seq); removeDetail(row); return; }
  expanded.add(seq); insertDetail(seq, row);
}
async function insertDetail(seq, row){
  let d; try { d = await api('/api/event/'+seq); } catch { return; }
  if(!expanded.has(seq) || !row.isConnected) return;  // collapsed or replaced while fetching
  removeDetail(row);                                  // never double-insert
  const box = el('div',{className:'detail'});
  const input = d.raw && d.raw.tool_input;
  box.append(el('div',{className:'kv'},
    el('b',{textContent:(d.tool_name||d.hook_event)}), ' · '+d.action_type+' · '+d.phase+' · '+shortTime(d.ts)+(d.duration_ms!=null?' · '+d.duration_ms+'ms':'')+(d.redaction_count?' · '+d.redaction_count+' redacted':'')));
  if(input!==undefined){ box.append(el('h4',{textContent:'input (redacted)'}), el('pre',{textContent:JSON.stringify(input,null,2)})); }
  if(d.output_hash){ box.append(el('h4',{textContent:'output'}), el('pre',{textContent:'elided · '+d.output_hash+'\\n'+(d.output_size_bytes||0)+' bytes'})); }
  if(d.detail && d.detail.git){ box.append(el('h4',{textContent:'git'}), el('pre',{textContent:JSON.stringify(d.detail.git,null,2)})); }
  if(d.detail && d.detail.correlation){ box.append(el('h4',{textContent:'correlation'}), el('pre',{textContent:JSON.stringify(d.detail.correlation,null,2)})); }
  if(d.risk){ box.append(el('h4',{textContent:'risk'}), el('pre',{textContent:'score '+d.risk.score+' · ['+d.risk.flags.join(', ')+']'+(d.risk.evidence?'\\n'+JSON.stringify(d.risk.evidence,null,2):'')})); }
  box.append(el('h4',{textContent:'chain'}), el('pre',{textContent:'seq '+d.seq+'\\nprev '+d.prev_hash+'\\nhash '+d.hash}));
  const dr = el('tr',{className:'detailrow'}, el('td',{colSpan:5}, box));
  row.after(dr);
}

async function render(){ await loadSessions(); await loadTimeline(); }
function tick(){ render().catch(()=>{}).finally(()=>setTimeout(tick, 3000)); }  // self-scheduling: a slow fetch can't overlap the next poll
tick();
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
