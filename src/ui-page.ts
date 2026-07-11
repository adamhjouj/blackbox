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
    color-scheme:dark;
    --bg:#0b0d10; --rail:#0d0f12; --surface:#131519; --surface-2:#171a1f;
    --hover:rgba(255,255,255,.035); --selected:#1f232a;
    --border-subtle:#1c1f25; --border:#2a2e36; --border-strong:#3a3f49;
    --edge:rgba(255,255,255,.045);
    --fg:#dfe1e6; --fg-hi:#f2f4f7; --fg-1:#c6c6cd; --fg-2:#9098a4; --fg-3:#7c828c; --fg-4:#565b64;
    --accent:#e5595a; --accent-wash:rgba(229,89,90,.08); --accent-line:rgba(229,89,90,.35);
    --live:#59b783;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;
    --r1:4px; --r2:6px; --r3:8px;
  }
  * { box-sizing:border-box; }
  html,body { height:100%; }
  body { margin:0; overflow:hidden; display:flex; flex-direction:column;
    background:radial-gradient(1100px 550px at 50% -8%, rgba(255,255,255,.022), transparent 60%), var(--bg);
    color:var(--fg); font:13px/1.5 var(--sans);
    -webkit-font-smoothing:antialiased; -moz-osx-font-smoothing:grayscale; }
  ::selection { background:rgba(229,89,90,.22); }
  :focus-visible { outline:2px solid rgba(233,233,238,.5); outline-offset:2px; border-radius:3px; }
  samp { font-family:var(--mono); user-select:all; }
  .sep { color:var(--fg-4); margin:0 7px; }
  * { scrollbar-width:thin; scrollbar-color:rgba(255,255,255,.14) transparent; }
  ::-webkit-scrollbar { width:11px; height:11px; }
  ::-webkit-scrollbar-thumb { background:rgba(255,255,255,.13); border-radius:7px; border:3px solid transparent; background-clip:padding-box; }
  ::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,.22); background-clip:padding-box; }

  /* header */
  header { flex:none; display:flex; align-items:center; justify-content:space-between;
    gap:16px; padding:0 18px; height:48px; border-bottom:1px solid var(--border); box-shadow:inset 0 1px 0 var(--edge); }
  header .brand { font-weight:600; font-size:13px; letter-spacing:-.01em; color:var(--fg-1); }
  header .status { display:flex; align-items:center; font-size:12px; color:var(--fg-3); min-width:0; }
  header .store { font-family:var(--mono); font-size:11px; color:var(--fg-3);
    border:1px solid var(--border); border-radius:var(--r1); padding:2px 7px;
    max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dot { width:6px; height:6px; border-radius:50%; display:inline-block; margin-right:7px; background:var(--fg-4); }
  .dot.rec { background:var(--live); }
  .dot.link { background:var(--accent); }

  /* connectivity strip */
  #alert { flex:none; display:none; padding:7px 18px; font-size:12px; color:var(--accent);
    background:var(--accent-wash); border-bottom:1px solid var(--border-subtle); }
  #alert.on { display:block; }

  /* panes */
  .wrap { flex:1; min-height:0; display:flex; }
  aside { width:270px; flex:none; min-height:0; display:flex; flex-direction:column;
    background:var(--rail); border-right:1px solid var(--border); }
  .railhead { flex:none; display:flex; align-items:baseline; justify-content:space-between;
    padding:14px 16px 8px; font-size:11px; color:var(--fg-4); letter-spacing:.04em; text-transform:uppercase; }
  #sessions { flex:1; overflow:auto; min-height:0; padding:2px 8px 14px; }
  main { flex:1; overflow:auto; min-width:0; }

  /* session rows */
  .sess { padding:9px 11px; border-radius:var(--r2); cursor:pointer; margin-bottom:1px;
    border-left:2px solid transparent; transition:background .12s ease; }
  .sess:hover { background:var(--hover); }
  .sess.active { background:var(--selected); border-left-color:var(--accent); }
  .sess .top { display:flex; align-items:baseline; gap:8px; }
  .sess .id { flex:1; min-width:0; font-size:13px; font-weight:500; color:var(--fg-1);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess.unnamed .id { font-family:var(--mono); font-weight:400; font-size:12px; color:var(--fg-2); }
  .sess.active .id { color:var(--fg); }
  .sess .fl { flex:none; font-size:11px; color:var(--accent); font-variant-numeric:tabular-nums; }
  .sess .ssid { margin-top:2px; font-family:var(--mono); font-size:11px; color:var(--fg-4);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess .meta { margin-top:3px; font-size:11.5px; color:var(--fg-3); font-variant-numeric:tabular-nums;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess .live { color:var(--live); }
  .sess .proj { margin-top:2px; font-size:11.5px; color:var(--fg-3);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  /* summary */
  .summary { padding:20px 22px 16px; border-bottom:1px solid var(--border); box-shadow:inset 0 1px 0 var(--edge); }
  .summary .sname { font-family:var(--sans); font-weight:600; font-size:19px; letter-spacing:-.02em; color:var(--fg); }
  .summary .sid { font-family:var(--mono); font-size:12px; color:var(--fg-3); margin-top:3px; word-break:break-all; }
  .summary .sline { margin-top:12px; font-size:13.5px; color:var(--fg-3); font-variant-numeric:tabular-nums; }
  .summary .n { color:var(--fg); font-weight:600; }
  .summary .flag { color:var(--accent); font-weight:600; }
  .summary .risk { margin-left:2px; padding:1px 9px; border-radius:999px; font-size:11.5px; border:1px solid var(--border); color:var(--fg-3); }
  .summary .risk.hot { border-color:var(--accent-line); color:var(--accent); }
  .summary .combo { margin-top:8px; font-size:12px; color:var(--fg-4); font-family:var(--mono); }

  /* timeline (flex rows) */
  .tl { padding-bottom:24px; }
  .thead, .trow { display:flex; align-items:center; padding:6px 16px 6px 12px; border-left:2px solid transparent; }
  .thead { position:sticky; top:0; z-index:2; background:var(--bg);
    border-bottom:1px solid var(--border); font-size:11px; color:var(--fg-4); letter-spacing:.02em; }
  .thead .c-tgt { color:var(--fg-4); }
  .trow { cursor:pointer; transition:background .1s ease; }
  .trow:hover { background:var(--hover); }
  .trow:hover .c-tgt { color:var(--fg-hi); }
  .trow.open { background:var(--selected); }
  .trow.open .c-tgt { color:var(--fg-hi); }
  .trow.flag { border-left-color:var(--fg-4); }
  .trow.fail { border-left-color:var(--accent); background:var(--accent-wash); }
  .c-time { flex:0 0 62px; font-family:var(--mono); font-size:12px; color:var(--fg-3); font-variant-numeric:tabular-nums; }
  .c-tool { flex:0 0 92px; padding-right:10px; font-size:12.5px; color:var(--fg-2);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .c-tgt  { flex:0 1 auto; min-width:0; display:flex; overflow:hidden;
    font-family:var(--mono); font-size:12.5px; color:var(--fg); }
  .c-tgt .dir  { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .c-tgt .base { flex:0 0 auto; white-space:nowrap; }
  /* plain-English summary reads in the sans face, not mono */
  .c-tgt .sum  { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--sans); color:var(--fg-1); }
  .c-sig  { flex:0 0 auto; display:flex; gap:5px; margin-left:10px; }
  .c-sig .tag { margin-left:0; }
  .c-dur  { flex:0 0 auto; margin-left:10px; font-family:var(--mono); font-size:11.5px; color:var(--fg-3); font-variant-numeric:tabular-nums; }
  .c-pad  { flex:1 1 0; min-width:14px; }
  .c-chev { flex:0 0 auto; margin-left:8px; color:var(--fg-4); opacity:0; transition:opacity .1s ease; }
  .trow:hover .c-chev { opacity:.55; }
  .turn { padding:18px 16px 4px 14px; font-size:10.5px; color:var(--fg-4); letter-spacing:.05em; }

  /* signal tags */
  .tag { display:inline-block; margin-left:5px; padding:1px 6px; border-radius:var(--r1);
    font-size:11px; color:var(--fg-2); border:1px solid rgba(255,255,255,.09); }
  .tag.alert { color:var(--accent); background:var(--accent-wash); border-color:var(--accent-line); }

  /* dossier */
  .detail { background:var(--surface-2); border-top:1px solid var(--border-subtle); border-bottom:1px solid var(--border);
    box-shadow:inset 2px 0 0 var(--border-strong); padding:16px 22px 20px; }
  .detail .kv { font-size:12.5px; color:var(--fg-3); margin-bottom:14px; font-variant-numeric:tabular-nums; }
  .detail .kv b { color:var(--fg-1); font-weight:600; }
  .detail h4 { margin:14px 0 6px; font-size:10.5px; font-weight:600; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-4); }
  .detail h4:first-of-type { margin-top:0; }
  .detail pre { margin:0; padding:12px 14px; background:var(--bg); border:1px solid var(--border-subtle); border-radius:var(--r2);
    overflow:auto; max-height:300px; white-space:pre-wrap; word-break:break-word;
    font-family:var(--mono); font-size:12px; line-height:1.5; color:var(--fg); }
  .detail .redact { color:var(--accent); background:var(--accent-wash); border-radius:3px; padding:0 3px; }
  .detail details summary { cursor:pointer; font-size:10.5px; font-weight:600; text-transform:uppercase;
    letter-spacing:.06em; color:var(--fg-4); padding:2px 0; list-style:none; }
  .detail details summary::-webkit-details-marker { display:none; }
  .detail details summary::before { content:"\\203A"; display:inline-block; margin-right:6px; transition:transform .12s ease; }
  .detail details[open] summary::before { transform:rotate(90deg); }
  .detail details[open] summary { margin-bottom:8px; }
  .chain { display:flex; flex-wrap:wrap; gap:6px 16px; font-family:var(--mono); font-size:12px; color:var(--fg-3); }
  .chain samp { color:var(--fg-2); }
  .chain .arrow { color:var(--fg-4); }
  .gline { font-size:12.5px; margin:3px 0; color:var(--fg-2); font-variant-numeric:tabular-nums; }
  .gline .gl { display:inline-block; min-width:76px; color:var(--fg-4); }
  .gline .del { color:var(--accent); }
  .derr { color:var(--accent); font-size:12.5px; }
  /* plain-English explanation — the lead of the dossier */
  .detail .exsum { font-size:13.5px; line-height:1.55; color:var(--fg-1); margin-bottom:10px; }
  .detail .esteps { margin:0 0 8px; padding-left:20px; }
  .detail .esteps li { font-size:12.5px; line-height:1.5; color:var(--fg-2); margin:3px 0; }
  .detail .esteps li.edanger { color:var(--fg-1); }
  .detail .esteps li.edanger::marker { color:var(--accent); }
  .detail .danger { margin-top:6px; padding:9px 11px; background:var(--accent-wash); border:1px solid var(--accent-line); border-radius:var(--r2); }
  .detail .danger .dwhat { font-size:12.5px; font-weight:600; color:var(--fg-hi); margin-bottom:3px; }
  .detail .danger .dwhy { font-size:12px; line-height:1.5; color:var(--fg-2); }

  /* states */
  .empty { max-width:440px; margin:60px auto; padding:0 24px; text-align:center; color:var(--fg-3); }
  .empty .h { color:var(--fg-2); font-size:13.5px; margin-bottom:8px; }
  .empty p { margin:6px 0; font-size:12.5px; line-height:1.6; color:var(--fg-4); }
  .skel { padding:9px 11px; }
  .skel i { display:block; height:9px; border-radius:4px; background:var(--surface-2); }
  .skel i:first-child { width:52%; margin-bottom:8px; }
  .skel i:last-child { width:78%; }

  @media (prefers-reduced-motion: no-preference) {
    @keyframes fade { from { opacity:0; } }
    .trow.enter, .sess.enter { animation:fade .18s ease both; }
    @keyframes dfade { from { opacity:0; transform:translateY(-3px); } }
    .detail { animation:dfade .18s ease both; }
    @keyframes shim { from { background-position:200% 0; } to { background-position:-200% 0; } }
    .skel i { background-image:linear-gradient(90deg, transparent, rgba(255,255,255,.05), transparent); background-size:200% 100%; animation:shim 1.4s ease-in-out infinite; }
  }
  @media (max-width:820px) { aside { width:220px; } header .store { max-width:130px; } }
`;

// Consumes: GET /health → {count, head_seq, port, db}; GET /api/sessions →
// SessionCard[] {session_id, events, started, ended, failures, verdict, score,
// combos[], flags{id→n}, annotations{id→n}, flagged, cwd}; GET /api/session/:id/events →
// Action[] {key, seq, post_seq, ts, hook_event, type, tool, target, summary, phase,
// success, duration_ms, redaction_count, signals[], notes[], score, prompt_id, agent_type};
// `summary` is the plain-English one-liner shown on every row (agent's own
// description when present, else synthesized from the command/target).
// GET /api/event/:seq → full detail incl. risk + chain hashes (see read-api.ts).
// All fields beyond the Phase-2 set are read defensively (missing → degraded
// display, never a crash), so this page works against older daemons too.
//
// signals[] are the row chips (red risk + a few muted always-show annotations);
// notes[] are muted context (secret-touch, failed) kept OFF the row — the full
// flag list is still in the /api/event dossier. This split is what keeps the
// timeline quiet (secret-touch alone fired 345x pre-r2).
//
// Poll-safe rendering: the 3s poll compares JSON fingerprints per pane and
// returns before ANY DOM write when nothing changed (idle polls cost zero DOM
// work — no scroll jump, no selection loss, no animation replay). When a live
// session grows, rows reconcile by index against the append-only action list:
// changed rows (a Pre paired by its Post) patch their cells; new rows append.
//
// SECURITY: recorded strings are hostile. el()/textContent only — never
// innerHTML/insertAdjacentHTML; class names are never derived from data.
// ALERT is the danger set; any other flag id falls back to a muted tag, so
// risk-rules.ts may grow the FlagId union without touching this file.
const CLIENT_JS = `const ALERT = new Set(['dangerous-shell','destructive-git','auth-edit','mass-diff']);
const RISKWORD = Object.assign(Object.create(null), { high:'high risk', medium:'medium risk', low:'low risk' });

let current = null, expanded = new Set();
let fpSessions = null, fpTimeline = null, fpVerdict = null, fpHud = null;
let rowState = [];            // [{fp, tr, a}] parallel to the rendered action list
let tbody = null;
let lastPrompt = null, turnN = 0;   // turn-divider walk state (reset with rowState)
let haveSessions = false, lastHealth = null, lastHead = null;
const sessEls = new Map();    // session_id -> rail row element
const cardsById = new Map();  // session_id -> latest SessionCard

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
function isFail(a){ return a.success===0 || (a.notes||[]).includes('failed') || a.signals.includes('failed'); }

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
  const st = document.getElementById('hStore'); const db = h.db||''; st.textContent = basename(db) || db; st.title = db;
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
  d.className = 'sess' + (keepEnter ? ' enter' : '') + (c.name ? '' : ' unnamed') + (c.session_id === current ? ' active' : '');
  const top = el('div',{className:'top'},
    el('span',{className:'id',title:c.name ? c.name+' · '+c.session_id : c.session_id,
      textContent:c.name || c.session_id.slice(0,20)}));
  if(c.flagged) top.append(el('span',{className:'fl',textContent:String(c.flagged)}));
  d.append(top);
  if(c.name) d.append(el('div',{className:'ssid',textContent:c.session_id.slice(0,20),title:c.session_id}));
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
    main.append(el('div',{className:'thead',role:'row'},
      el('div',{className:'c-time',textContent:'time'}),
      el('div',{className:'c-tool',textContent:'tool'}),
      el('div',{className:'c-tgt'}, el('span',{className:'dir',textContent:'target'})),
      el('div',{className:'c-pad'})));
    tbody = el('div',{className:'tl',role:'table','aria-label':'action timeline'});
    main.append(tbody);
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
  tbody.append(el('div',{className:'turn',textContent:'turn '+turnN}));
}

// Every row reads in plain English. File ops keep the path (dir ellipsizes, base
// pinned) since the tool column already says Read/Write/Edit; everything else
// shows the plain-English summary (the agent's own description, else synthesized)
// so a shell command or MCP call is legible at a glance. Raw text is in the title
// attr and the expanded dossier.
function targetCell(a){
  const t = a.target || '';
  const isPath = a.type==='file_read' || a.type==='file_write' || a.type==='file_edit';
  const c = el('div',{className:'c-tgt',title:t || a.summary || ''});
  const i = t.lastIndexOf('/');
  if(isPath && i >= 0 && i < t.length-1){
    c.append(el('span',{className:'dir',textContent:t.slice(0,i+1)}), el('span',{className:'base',textContent:t.slice(i+1)}));
  } else if(isPath && t){
    c.append(el('span',{className:'base',textContent:t}));
  } else {
    c.append(el('span',{className:'sum',textContent:(a.summary||t).split(String.fromCharCode(96)).join('')}));
  }
  return c;
}

function buildRowCells(a, tr, entering){
  tr.textContent='';
  const fail = isFail(a);
  tr.className = 'trow' + (fail ? ' fail' : a.signals.some(s=>ALERT.has(s)) ? ' flag' : '') +
    (expanded.has(a.seq) ? ' open' : '') + (entering ? ' enter' : '');
  tr.append(
    el('div',{className:'c-time',textContent:hhmmss(a.ts)}),
    el('div',{className:'c-tool',textContent:(a.tool||a.hook_event)}),
    targetCell(a));
  if(a.signals.length){ const sig = el('div',{className:'c-sig'}); a.signals.forEach(s=>sig.append(tag(s))); tr.append(sig); }
  const dur = fmtDur(a.duration_ms);
  if(dur) tr.append(el('div',{className:'c-dur',textContent:dur}));
  tr.append(el('div',{className:'c-pad'}), el('div',{className:'c-chev',textContent:'›'}));
}

function appendRow(a){
  maybeDivider(a);
  const tr = el('div',{role:'row',tabIndex:0});
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
  const flagN = actions.reduce((n,a)=>n+a.signals.filter(s=>ALERT.has(s)).length,0);
  const fp = JSON.stringify([current, actions.length, flagN, card]);
  if(fp === fpVerdict) return;
  fpVerdict = fp;
  v.textContent = '';
  if(card && card.name) v.append(el('div',{className:'sname',textContent:card.name}));
  v.append(el('div',{className:'sid'}, el('samp',{textContent:current})));

  const line = el('div',{className:'sline'});
  line.append(el('span',{className:'n',textContent:String(actions.length)}), ' actions');
  if(flagN){ line.append(el('span',{className:'sep',textContent:'·'}),
    el('span',{className:'flag',textContent:flagN+' flagged'})); }
  const span = card && fmtSpan(card.started, card.ended);
  if(span){ line.append(el('span',{className:'sep',textContent:'·'}), span); }
  const proj = card && basename(card.cwd);
  if(proj){ line.append(el('span',{className:'sep',textContent:'·'}), proj); }
  if(card && RISKWORD[card.verdict]){
    const hot = card.verdict === 'medium' || card.verdict === 'high';
    line.append(el('span',{className:'sep',textContent:'·'}),
      el('span',{className:'risk'+(hot?' hot':''),textContent:RISKWORD[card.verdict]}));
  }
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
    row.after(el('div',{className:'detailrow'},
      el('div',{className:'detail'}, el('span',{className:'derr',textContent:'Could not load event '+seq+'.'}))));
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

  // plain English FIRST — a forensic record no one can read is useless. The
  // agent's action in words, then the specific dangers, then the raw jargon.
  const ex = d.explanation;
  if(ex && ex.summary){
    box.append(el('div',{className:'exsum'}, ex.summary));
    if(Array.isArray(ex.steps) && ex.steps.length){
      const ol = el('ol',{className:'esteps'});
      ex.steps.forEach(s=>ol.append(el('li',{className:(s&&s.danger)?'edanger':'',textContent:(s&&s.text)||''})));
      box.append(ol);
    }
  }
  if(ex && Array.isArray(ex.dangers) && ex.dangers.length){
    box.append(secLabel('why this is risky'));
    for(const dg of ex.dangers){
      box.append(el('div',{className:'danger'},
        el('div',{className:'dwhat',textContent:(dg&&dg.what)||''}),
        el('div',{className:'dwhy',textContent:(dg&&dg.why)||''})));
    }
  }

  // the technical risk chips (the machine's view, for skeptics)
  if(d.risk && (d.risk.score || (d.risk.flags||[]).length)){
    box.append(secLabel('risk signals'));
    const r = gline('score', String(d.risk.score||0));
    (d.risk.flags||[]).forEach(f=>r.append(tag(f)));
    box.append(r);
  }

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

  // raw: the full redacted record, collapsed (it re-prints the input shown above)
  box.append(el('details',{}, el('summary',{textContent:'raw'}), el('pre',{textContent:JSON.stringify(d.raw,null,2)})));

  row.after(el('div',{className:'detailrow'}, box));
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
    <span class="sep">·</span><span id="hStore" class="store"></span>
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
