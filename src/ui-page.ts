/**
 * The timeline UI — a single self-contained page served from the daemon.
 * No framework, no build step. ALL recorded data is rendered via textContent /
 * DOM construction (never innerHTML with interpolation), so an agent's recorded
 * command/path strings cannot inject script into the viewer (stored-XSS safe).
 *
 * Design: minimal / calm. Off-black surface, one restrained accent (red, used
 * only for genuine flags and failures), system sans for chrome and monospace
 * only for real data (ids, commands, paths, hashes). Generous whitespace,
 * near-zero decoration. The CSP (default-src 'none', no img-src/font-src)
 * blocks every external asset, so fonts are system stacks and there are no
 * images — and it must stay untouched.
 *
 * The page is authored as module-level constants (CSS + client JS) concatenated
 * in renderPage(). Rules for the string contents:
 *  - CLIENT_JS uses '...' + concatenation only — no backticks/nested templates.
 *  - No `${` may appear in the emitted output except the intended interpolations
 *    in the skeleton below (gated in verification).
 *  - Literal UTF-8 glyphs over escape sequences; keep `\\` doublings as-is.
 */

const PAGE_CSS = `  :root {
    --bg:#0c0c0d; --panel:#151517; --panel-2:#1b1b1e; --line:#242427;
    --fg:#e7e7ea; --fg-2:#9a9aa1; --fg-3:#6b6b71;
    --accent:#e5595a;            /* the only accent: danger / flags */
    --accent-wash:rgba(229,89,90,.09);
    --live:#59b783;              /* recording indicator only */
    --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --r:6px;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; overflow:hidden; display:flex; flex-direction:column;
    background:var(--bg); color:var(--fg);
    font:14px/1.55 var(--sans); -webkit-font-smoothing:antialiased; font-smoothing:antialiased; }
  .mono { font-family:var(--mono); }
  .muted { color:var(--fg-2); }
  .faint { color:var(--fg-3); }
  .sep { color:var(--fg-3); margin:0 7px; }
  samp { font-family:var(--mono); user-select:all; }
  ::selection { background:rgba(229,89,90,.22); }
  :focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:3px; }

  /* header */
  header { flex:none; display:flex; align-items:center; justify-content:space-between;
    gap:16px; padding:0 18px; height:52px; border-bottom:1px solid var(--line); }
  header .brand { font-weight:600; letter-spacing:-.01em; }
  header .status { display:flex; align-items:center; font-size:12.5px; color:var(--fg-2); min-width:0; }
  header .path { font-family:var(--mono); font-size:11.5px; max-width:340px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:7px; height:7px; border-radius:50%; display:inline-block; margin-right:7px; background:var(--fg-3); }
  .dot.rec { background:var(--live); }
  .dot.link { background:var(--accent); }

  /* connectivity strip */
  #alert { flex:none; display:none; padding:8px 18px; font-size:12.5px; color:var(--accent);
    background:var(--accent-wash); border-bottom:1px solid var(--line); }
  #alert.on { display:block; }

  /* panes */
  .wrap { flex:1; min-height:0; display:flex; }
  aside { width:288px; flex:none; min-height:0; display:flex; flex-direction:column; border-right:1px solid var(--line); }
  .railhead { flex:none; display:flex; align-items:baseline; justify-content:space-between;
    padding:14px 18px 10px; font-size:12px; color:var(--fg-3); letter-spacing:.01em; }
  #sessions { flex:1; overflow:auto; min-height:0; padding:0 8px 12px; }
  main { flex:1; overflow:auto; min-width:0; }

  /* session rows */
  .sess { padding:11px 12px; border-radius:var(--r); cursor:pointer; margin-bottom:1px;
    transition:background .12s ease; }
  .sess:hover { background:var(--panel); }
  .sess.active { background:var(--panel-2); }
  .sess .top { display:flex; align-items:baseline; gap:8px; }
  .sess .id { flex:1; min-width:0; font-family:var(--mono); font-size:12.5px;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess .fl { font-size:12px; color:var(--accent); font-variant-numeric:tabular-nums; }
  .sess.active .id { color:var(--fg); }
  .sess:not(.active) .id { color:var(--fg-2); }
  .sess .meta { margin-top:3px; font-size:11.5px; color:var(--fg-3); font-variant-numeric:tabular-nums;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess .live { color:var(--live); }
  .sess .proj { margin-top:2px; font-size:11.5px; color:var(--fg-3);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  /* summary */
  .summary { padding:22px 26px 18px; border-bottom:1px solid var(--line); }
  .summary .sid { font-family:var(--mono); font-size:13px; color:var(--fg-2); word-break:break-all; }
  .summary .sline { margin-top:8px; font-size:15px; color:var(--fg-2); font-variant-numeric:tabular-nums; }
  .summary .n { color:var(--fg); font-weight:600; }
  .summary .flag { color:var(--accent); font-weight:600; }
  .summary .risk { color:var(--accent); }
  .summary .combo { margin-top:6px; font-size:12.5px; color:var(--fg-3); font-family:var(--mono); }

  /* timeline */
  table { width:100%; border-collapse:collapse; }
  thead th { position:sticky; top:0; z-index:1; background:var(--bg); text-align:left;
    padding:9px 12px; border-bottom:1px solid var(--line);
    font-weight:400; font-size:11px; color:var(--fg-3); }
  thead th.r { text-align:right; }
  tbody tr.row { cursor:pointer; transition:background .1s ease; }
  tbody tr.row:hover { background:var(--panel); }
  tbody tr.row.open { background:var(--panel-2); }
  tbody tr.row.flag td.tgt { color:var(--fg); }
  tbody tr.row.fail { background:var(--accent-wash); }
  td { padding:8px 12px; vertical-align:top; border-bottom:1px solid var(--line); }
  td.t { width:1%; white-space:nowrap; color:var(--fg-3); font-family:var(--mono); font-size:12px; font-variant-numeric:tabular-nums; }
  td.tool { width:1%; white-space:nowrap; color:var(--fg-2); font-size:13px; }
  td.tgt { color:var(--fg-2); font-family:var(--mono); font-size:12.5px;
    max-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  td.dur { width:1%; text-align:right; white-space:nowrap; color:var(--fg-3); font-size:12px; font-variant-numeric:tabular-nums; }
  td.sig { width:1%; white-space:nowrap; text-align:right; }
  tr.turn td { border-bottom:none; padding:20px 12px 4px; color:var(--fg-3); font-size:11px; }
  tr.turn td .tno { color:var(--fg-2); }

  /* signal tags */
  .tag { display:inline-block; margin-left:5px; padding:1px 7px; border-radius:4px;
    font-family:var(--mono); font-size:11px; color:var(--fg-2); background:var(--panel-2); }
  .tag.alert { color:var(--accent); background:var(--accent-wash); }

  /* dossier */
  .detail { background:var(--panel); border-bottom:1px solid var(--line); padding:18px 26px 22px; }
  .detail .kv { font-size:12.5px; color:var(--fg-3); margin-bottom:14px; font-variant-numeric:tabular-nums; }
  .detail .kv b { color:var(--fg-2); font-weight:600; }
  .detail h4 { margin:16px 0 6px; font-size:11px; font-weight:500; color:var(--fg-3); letter-spacing:.03em; }
  .detail h4:first-of-type { margin-top:0; }
  .detail pre { margin:0; padding:12px 14px; background:var(--bg); border:1px solid var(--line); border-radius:var(--r);
    overflow:auto; max-height:300px; white-space:pre-wrap; word-break:break-word;
    font-family:var(--mono); font-size:12px; line-height:1.5; color:var(--fg); }
  .detail .redact { color:var(--accent); background:var(--accent-wash); border-radius:3px; padding:0 3px; }
  .chain { display:flex; flex-wrap:wrap; gap:6px 14px; font-family:var(--mono); font-size:12px; color:var(--fg-2); }
  .chain .arrow { color:var(--fg-3); }
  .gline { font-size:12.5px; margin:3px 0; color:var(--fg-2); font-variant-numeric:tabular-nums; }
  .gline .gl { display:inline-block; min-width:76px; color:var(--fg-3); }
  .gline .del { color:var(--accent); }
  .derr { color:var(--accent); font-size:12.5px; }

  /* states */
  .empty { max-width:440px; margin:64px auto; padding:0 24px; text-align:center; color:var(--fg-3); }
  .empty .h { color:var(--fg-2); font-size:14px; margin-bottom:8px; }
  .empty p { margin:6px 0; font-size:12.5px; line-height:1.6; }
  .empty code { font-family:var(--mono); color:var(--fg-2); background:var(--panel); padding:2px 6px; border-radius:4px; }
  .skel { padding:11px 12px; }
  .skel i { display:block; height:9px; border-radius:4px; background:var(--panel-2); }
  .skel i:first-child { width:58%; margin-bottom:7px; }
  .skel i:last-child { width:82%; }

  @media (prefers-reduced-motion: no-preference) {
    @keyframes fade { from { opacity:0; } }
    tr.row.enter, .sess.enter { animation:fade .18s ease both; }
    @keyframes pulse { 50% { opacity:.45; } }
    .skel i { animation:pulse 1.3s ease-in-out infinite; }
  }
  @media (max-width:820px) { aside { width:220px; } header .path { display:none; } }
`;

// Consumes: GET /health → {count, head_seq, port, db}; GET /api/sessions →
// SessionCard[] {session_id, events, started, ended, failures, verdict, score,
// combos[], flags{id→n}, flagged, cwd}; GET /api/session/:id/events → Action[]
// {key, seq, post_seq, ts, hook_event, type, tool, target, phase, success,
// duration_ms, redaction_count, signals[], score, prompt_id, agent_type};
// GET /api/event/:seq → full detail incl. risk + chain hashes (see read-api.ts).
// All fields beyond the Phase-2 set are read defensively (missing → degraded
// display, never a crash), so this page works against older daemons too.
//
// Poll-safe rendering: the 3s poll compares JSON fingerprints per pane and
// returns before ANY DOM write when nothing changed (idle polls cost zero DOM
// work — no scroll jump, no selection loss, no animation replay). When a live
// session grows, rows reconcile by index against the append-only action list:
// changed rows (a Pre paired by its Post) patch their cells; new rows append.
//
// SECURITY: recorded strings are hostile. el()/textContent only — never
// innerHTML/insertAdjacentHTML; class names are never derived from data.
// ALERT is the danger set; any unknown flag id falls back to a muted tag, so
// risk-rules.ts may grow the FlagId union without touching this file.
const CLIENT_JS = `const ALERT = new Set(['failed','dangerous-shell','destructive-git','external-send','injection-output','auth-edit']);
const RISKWORD = Object.assign(Object.create(null), { high:'high risk', medium:'medium risk', low:'low risk' });

let current = null, expanded = new Set();
let fpSessions = null, fpTimeline = null, fpVerdict = null, fpHud = null;
let rowState = [];            // [{fp, tr, a}] parallel to the rendered action list
let tbody = null;
let lastPrompt = null, turnN = 0;   // turn-divider walk state (reset with rowState)
let haveSessions = false, lastHealth = null, lastHead = null;
const sessEls = new Map();    // session_id -> rail row element
const cardsById = new Map();  // session_id -> latest SessionCard
const NCOLS = 5;

function el(tag, props, ...kids){ const n=document.createElement(tag); if(props) Object.assign(n,props); for(const k of kids) if(k!=null) n.append(k); return n; }
async function api(p){ const r = await fetch(p, {headers:{'accept':'application/json'}}); if(!r.ok) throw new Error(r.status); return r.json(); }
function hhmmss(ts){ return (ts||'').slice(11,19); }
function fmtDur(ms){ if(ms==null) return ''; return ms < 1000 ? ms+'ms' : (ms/1000).toFixed(1)+'s'; }
function fmtSpan(a,b){ const s=Math.round((Date.parse(b)-Date.parse(a))/1000);
  if(!isFinite(s)||s<0) return '';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60);
  return h ? h+'h '+m+'m' : m ? m+'m '+(s%60)+'s' : s+'s'; }
function fmtRel(ts){ const s=Math.round((Date.now()-Date.parse(ts))/1000);
  if(!isFinite(s)) return '';
  if(s<10) return null; if(s<60) return s+'s ago'; if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago'; return Math.floor(s/86400)+'d ago'; }
function basename(p){ if(!p) return null; const parts=p.split(/[\\\\/]/).filter(Boolean); return parts[parts.length-1]||null; }

function tag(s){ return el('span',{className:'tag'+(ALERT.has(s)?' alert':''),textContent:s}); }
function isFail(a){ return a.success===0 || a.signals.includes('failed'); }

/* ── header status ───────────────────────────────────────────────── */
function updateHud(h){
  lastHealth = h;
  const grew = lastHead !== null && h.head_seq > lastHead;
  lastHead = h.head_seq;
  const mode = grew ? 'rec' : 'idle';
  const fp = JSON.stringify([h.count, h.db, mode]);
  if(fp === fpHud) return;                                    // idle poll → zero DOM work
  fpHud = fp;
  document.getElementById('hEvents').textContent = String(h.count||0);
  const st = document.getElementById('hStore'); st.textContent = h.db||''; st.title = h.db||'';
  setRec(mode);
}
function setRec(mode){
  const dot = document.getElementById('recDot'), lab = document.getElementById('recLabel');
  dot.className = 'dot ' + mode;
  lab.textContent = mode==='rec' ? 'recording' : mode==='link' ? 'offline' : 'idle';
}
function setLink(ok){
  const a = document.getElementById('alert');
  if(ok){ a.classList.remove('on'); return; }
  a.textContent = "can't reach the recorder. retrying every 3 seconds.";
  a.classList.add('on');
  setRec('link');
  fpHud = null;   // force the next good health poll to re-render the status
}

/* ── sessions ────────────────────────────────────────────────────── */
function select(id){
  if(current === id) return;
  current = id; expanded = new Set();
  fpTimeline = null; fpVerdict = null; rowState = []; tbody = null;
  lastPrompt = null; turnN = 0;
  for(const [sid, d] of sessEls) d.classList.toggle('active', sid === current);
  loadTimeline().catch(()=>{});
}

async function loadSessions(){
  const cards = await api('/api/sessions');
  const fp = JSON.stringify(cards);
  if(fp === fpSessions) return;
  renderSessions(cards);
  fpSessions = fp;   // commit only after a successful render
}

// Relative-age labels depend on wall-clock but the cards JSON is fingerprint-
// gated, so refresh them every poll outside the gate, writing only on change.
function refreshRel(){
  for(const d of sessEls.values()){
    if(!d._relEl) continue;
    const rel = fmtRel(d._ended);
    const txt = rel === null ? 'live' : rel;
    if(d._relEl.textContent !== txt){ d._relEl.textContent = txt; d._relEl.className = rel === null ? 'live' : ''; }
  }
}

function renderSessions(cards){
  const box = document.getElementById('sessions');
  document.getElementById('sessCount').textContent = cards.length ? String(cards.length) : '';
  haveSessions = cards.length > 0;
  cardsById.clear(); for(const c of cards) cardsById.set(c.session_id, c);
  if(!cards.length){
    sessEls.clear(); box.textContent='';
    box.append(el('div',{className:'empty'}, el('p',{textContent:'No sessions yet.'})));
    return;
  }
  if(!current) current = cards[0].session_id;
  if(!sessEls.size) box.textContent='';                       // clear skeleton
  const live = new Set(cards.map(c=>c.session_id));
  for(const [sid, d] of sessEls) if(!live.has(sid)){ d.remove(); sessEls.delete(sid); }
  let prev = null;
  cards.forEach((c, i)=>{
    let d = sessEls.get(c.session_id);
    if(!d){
      d = el('div',{className:'sess enter',tabIndex:0});
      d.addEventListener('animationend', ()=>{ d.classList.remove('enter'); }, {once:true});
      d.onclick = ()=>select(c.session_id);
      d.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); select(c.session_id); } };
      sessEls.set(c.session_id, d);
    }
    const cfp = JSON.stringify(c);
    if(d._fp !== cfp){ d._fp = cfp; fillCard(d, c); }
    d.classList.toggle('active', c.session_id === current);
    const want = prev ? prev.nextSibling : box.firstChild;    // reposition only on real reorder
    if(want !== d) box.insertBefore(d, want);
    prev = d;
  });
}

function fillCard(d, c){
  const keepEnter = d.className.includes('enter');
  d.textContent = '';
  d.className = 'sess' + (keepEnter ? ' enter' : '') + (c.session_id === current ? ' active' : '');
  const top = el('div',{className:'top'}, el('span',{className:'id',title:c.session_id,textContent:c.session_id.slice(0,20)}));
  if(c.flagged) top.append(el('span',{className:'fl',textContent:c.flagged+' flagged'}));
  d.append(top);
  const rel = fmtRel(c.ended);
  const relEl = el('span',{className:rel===null?'live':'',textContent:rel===null?'live':rel});
  d._relEl = relEl; d._ended = c.ended;
  d.append(el('div',{className:'meta'}, c.events+' events', el('span',{className:'sep',textContent:'·'}), relEl));
  const proj = basename(c.cwd);
  if(proj) d.append(el('div',{className:'proj',textContent:proj,title:c.cwd||''}));
}

/* ── timeline ────────────────────────────────────────────────────── */
async function loadTimeline(){
  const main = document.getElementById('timeline');
  if(!current){
    const key = haveSessions ? 'sel' : 'armed';
    if(fpTimeline !== key){ fpTimeline = key; main.textContent=''; main.append(emptyState(key)); }
    return;
  }
  const sid = current;
  const actions = await api('/api/session/'+encodeURIComponent(sid)+'/events');
  if(current !== sid) return;   // selection changed while this fetch was in flight
  const fp = JSON.stringify([sid, actions]);
  if(fp === fpTimeline){
    if(tbody && tbody.isConnected) updateVerdict(actions);   // card risk may have advanced
    return;
  }
  renderTimeline(main, actions);
  fpTimeline = fp;   // commit only after a successful render
}

function emptyState(kind){
  if(kind === 'sel') return el('div',{className:'empty'}, el('p',{textContent:'Select a session.'}));
  const host = lastHealth ? '127.0.0.1:'+lastHealth.port : '127.0.0.1';
  return el('div',{className:'empty'},
    el('div',{className:'h',textContent:'Waiting for the first session'}),
    el('p',{textContent:'Listening on '+host+'. Run a Claude Code session in a hooked project and its actions show up here within a few seconds.'}),
    el('p',{className:'faint',textContent:'Nothing leaves this machine.'}));
}

function renderTimeline(main, actions){
  const incremental = tbody && tbody.isConnected && rowState.length > 0 &&
    rowState.length <= actions.length &&
    rowState[0].a.key === actions[0].key;
  if(!incremental){
    main.textContent='';
    fpVerdict = null; rowState = []; lastPrompt = null; turnN = 0;
    main.append(el('section',{className:'summary',id:'verdict'}));
    const tbl = el('table');
    tbl.setAttribute('aria-label','action timeline');
    const thead = el('thead',{}, el('tr',{},
      el('th',{scope:'col',textContent:'time'}), el('th',{scope:'col',textContent:'tool'}),
      el('th',{scope:'col',textContent:'target'}), el('th',{scope:'col',className:'r',textContent:'dur'}),
      el('th',{scope:'col',className:'r',textContent:''})));
    tbody = el('tbody');
    tbl.append(thead, tbody); main.append(tbl);
  }
  updateVerdict(actions);
  for(let i=0;i<actions.length;i++){
    const a = actions[i];
    if(i < rowState.length){
      const st = rowState[i];
      const afp = JSON.stringify(a);
      if(st.fp !== afp){
        if(st.a.key !== a.key){ fpTimeline = null; rowState = []; tbody = null; renderTimeline(main, actions); return; }
        buildRowCells(a, st.tr, false);
        st.fp = afp; st.a = a;
        if(expanded.has(a.seq)) insertDetail(a.seq, st.tr);   // refresh on Pre→Post pairing
      }
    } else {
      appendRow(a);
    }
  }
}

function maybeDivider(a){
  if(!a.prompt_id || a.prompt_id === lastPrompt) return;   // null never opens/closes a turn
  lastPrompt = a.prompt_id; turnN++;
  const td = el('td',{colSpan:NCOLS}, el('span',{className:'tno',textContent:'turn '+turnN}));
  tbody.append(el('tr',{className:'turn'}, td));
}

function buildRowCells(a, tr, entering){
  tr.textContent='';
  const fail = isFail(a);
  tr.className = 'row' + (fail ? ' fail' : a.signals.length ? ' flag' : '') +
    (expanded.has(a.seq) ? ' open' : '') + (entering ? ' enter' : '');
  const sig = el('td',{className:'sig'}); a.signals.forEach(s=>sig.append(tag(s)));
  let t = a.target || '';
  if(t.length > 140 && (a.type==='file_read'||a.type==='file_write'||a.type==='file_edit')) t = '…'+t.slice(-139);
  tr.append(
    el('td',{className:'t',textContent:hhmmss(a.ts)}),
    el('td',{className:'tool',textContent:(a.tool||a.hook_event)}),
    el('td',{className:'tgt',title:a.target||'',textContent:t}),
    el('td',{className:'dur',textContent:fmtDur(a.duration_ms)}),
    sig);
}

function appendRow(a){
  maybeDivider(a);
  const tr = el('tr',{tabIndex:0});
  buildRowCells(a, tr, true);
  tr.onclick = ()=>toggle(a.seq, tr);
  tr.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(a.seq, tr); } };
  tbody.append(tr);
  rowState.push({fp: JSON.stringify(a), tr, a});
  if(expanded.has(a.seq)) insertDetail(a.seq, tr);
}

/* ── summary ─────────────────────────────────────────────────────── */
function updateVerdict(actions){
  const v = document.getElementById('verdict');
  if(!v) return;
  const card = cardsById.get(current) || null;
  const flagN = actions.reduce((n,a)=>n+a.signals.length,0);
  const fp = JSON.stringify([current, actions.length, flagN, card]);
  if(fp === fpVerdict) return;
  fpVerdict = fp;
  v.textContent = '';
  v.append(el('div',{className:'sid'}, el('samp',{textContent:current})));

  const line = el('div',{className:'sline'});
  line.append(el('span',{className:'n',textContent:String(actions.length)}), ' actions');
  if(flagN){ line.append(el('span',{className:'sep',textContent:'·'}),
    el('span',{className:'flag',textContent:flagN+' flagged'})); }
  const span = card && fmtSpan(card.started, card.ended);
  if(span){ line.append(el('span',{className:'sep',textContent:'·'}), span); }
  const proj = card && basename(card.cwd);
  if(proj){ line.append(el('span',{className:'sep',textContent:'·'}), proj); }
  if(card && RISKWORD[card.verdict]){ line.append(el('span',{className:'sep',textContent:'·'}),
    el('span',{className:'risk',textContent:RISKWORD[card.verdict]})); }
  v.append(line);

  if(card && Array.isArray(card.combos)){
    for(const cb of card.combos){
      v.append(el('div',{className:'combo'},
        (cb.id||'combo')+': '+(cb.antecedent_seq||0)+' → '+(cb.consequent_seq||0)+(cb.note?' ('+cb.note+')':'')));
    }
  }
}

/* ── dossier ─────────────────────────────────────────────────────── */
function removeDetail(row){
  const n = row.nextSibling;
  if(n && n.classList && n.classList.contains('detailrow')) n.remove();
}

async function toggle(seq, row){
  if(expanded.has(seq)){ expanded.delete(seq); removeDetail(row); row.classList.remove('open'); return; }
  expanded.add(seq); row.classList.add('open'); insertDetail(seq, row);
}

function secLabel(text){ return el('h4',{textContent:text}); }

function redactedPre(text){
  const pre = el('pre',{});
  const re = /\\[REDACTED:[a-z0-9_-]+\\]/gi;
  let i = 0, m;
  while((m = re.exec(text))){
    if(m.index > i) pre.append(text.slice(i, m.index));
    pre.append(el('span',{className:'redact',textContent:m[0]}));
    i = m.index + m[0].length;
  }
  pre.append(text.slice(i));
  return pre;
}

function gline(label, ...kids){ return el('div',{className:'gline'}, el('span',{className:'gl',textContent:label}), ...kids); }

async function insertDetail(seq, row){
  const gen = row._dgen = (row._dgen || 0) + 1;   // only the newest fetch for this row wins
  const stale = ()=> row._dgen !== gen || !expanded.has(seq) || !row.isConnected;
  let d;
  try { d = await api('/api/event/'+seq); }
  catch {
    if(stale()) return;
    removeDetail(row);
    row.after(el('tr',{className:'detailrow'}, el('td',{colSpan:NCOLS},
      el('div',{className:'detail'}, el('span',{className:'derr',textContent:'Could not load event '+seq+'.'})))));
    return;
  }
  if(stale()) return;
  removeDetail(row);
  const box = el('div',{className:'detail'});

  const idbits = [(d.action_type||''), (d.phase||''), hhmmss(d.ts)];
  if(d.duration_ms != null) idbits.push(fmtDur(d.duration_ms));
  if(d.redaction_count) idbits.push(d.redaction_count+' redacted');
  box.append(el('div',{className:'kv'},
    el('b',{textContent:(d.tool_name||d.hook_event)}), ' · '+idbits.filter(Boolean).join(' · ')));

  const input = d.raw && typeof d.raw === 'object' ? d.raw.tool_input : undefined;
  if(input !== undefined){
    box.append(secLabel('input'+(d.redaction_count?' (redacted)':'')), redactedPre(JSON.stringify(input,null,2)));
  }
  if(d.output_hash){
    box.append(secLabel('output'),
      el('pre',{textContent:'elided · sha-256 '+d.output_hash+' · '+(d.output_size_bytes||0)+' bytes'}));
  }
  const git = d.detail && d.detail.git;
  if(git){
    box.append(secLabel('git'));
    if(git.ref) box.append(gline('ref', el('samp',{textContent:git.ref})));
    if(git.kind) box.append(gline('kind', String(git.kind)));
    if(git.old_sha || git.new_sha){
      box.append(gline('shas', el('samp',{textContent:String(git.old_sha||'').slice(0,7)}),
        el('span',{className:'arrow',textContent:' → '}), el('samp',{textContent:String(git.new_sha||'').slice(0,7)})));
    }
    const warn = ['is_force','is_reset','is_delete','is_amend'].filter(k=>git[k]);
    if(warn.length){ const w = gline('flags'); warn.forEach(k=>w.append(el('span',{className:'tag alert',textContent:k.slice(3)}))); box.append(w); }
    if(git.diffstat){
      box.append(gline('diffstat', '+'+(git.diffstat.insertions||0)+' ',
        el('span',{className:'del',textContent:'-'+(git.diffstat.deletions||0)}), ' · '+(git.diffstat.files||0)+' files'));
    }
    if(git.commit && git.commit.subject) box.append(gline('commit', git.commit.subject));
  }
  const corr = d.detail && d.detail.correlation;
  if(corr){
    box.append(secLabel('correlation'),
      gline('cause', String(corr.confidence||'none'),
        corr.session_id ? ' · '+String(corr.session_id).slice(0,20) : ''));
  }
  if(d.risk && (d.risk.score || (d.risk.flags||[]).length)){
    box.append(secLabel('risk'));
    const r = gline('score', String(d.risk.score||0));
    (d.risk.flags||[]).forEach(f=>r.append(tag(f)));
    box.append(r);
  }
  const reds = d.detail && d.detail.redactions;
  if(Array.isArray(reds) && reds.length){
    box.append(secLabel('redactions'));
    for(const r of reds) box.append(gline(String(r.type||''), (r.path||'')+' · '+(r.bytes||0)+' bytes'));
  }

  // chain: quiet integrity line, verbatim hashes selectable
  box.append(secLabel('chain'));
  const chain = el('div',{className:'chain'});
  chain.append(el('span',{}, 'seq ', String(d.seq)));
  chain.append(el('span',{}, 'prev ', d.seq === 1 ? 'genesis'
    : el('samp',{title:d.prev_hash||'',textContent:(d.prev_hash||'').slice(0,12)+'…'})));
  chain.append(el('span',{}, 'hash ', el('samp',{title:d.hash||'',textContent:(d.hash||'').slice(0,12)+'…'})));
  box.append(chain);

  box.append(secLabel('raw'), el('pre',{textContent:JSON.stringify(d.raw,null,2)}));

  row.after(el('tr',{className:'detailrow'}, el('td',{colSpan:NCOLS}, box)));
}

/* ── poll loop ───────────────────────────────────────────────────── */
async function render(){
  let linkOk = true;
  try { updateHud(await api('/health')); } catch { linkOk = false; }
  try { await loadSessions(); } catch {}
  try { await loadTimeline(); } catch {}
  refreshRel();
  setLink(linkOk);
}
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
<header>
  <div class="brand">blackbox</div>
  <div class="status">
    <span id="recDot" class="dot"></span><span id="recLabel">idle</span>
    <span class="sep">·</span><span id="hEvents">0</span>&nbsp;events
    <span class="sep">·</span><span id="hStore" class="path"></span>
  </div>
</header>
<div id="alert" role="status" aria-live="polite"></div>
<div class="wrap">
  <aside>
    <div class="railhead"><span>sessions</span><span id="sessCount"></span></div>
    <div id="sessions"><div class="skel"><i></i><i></i></div><div class="skel"><i></i><i></i></div><div class="skel"><i></i><i></i></div></div>
  </aside>
  <main id="timeline"></main>
</div>
<script>
${CLIENT_JS}</script>
</body>
</html>`;
}
