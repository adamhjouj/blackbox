/**
 * The timeline UI — a single self-contained page served from the daemon.
 * No framework, no build step. ALL recorded data is rendered via textContent /
 * DOM construction (never innerHTML with interpolation), so an agent's recorded
 * command/path strings cannot inject script into the viewer (stored-XSS safe).
 *
 * Design: industrial-brutalist "tactical telemetry" — dark CRT substrate, one
 * hazard-red accent, zero border-radius, visible compartment borders, uppercase
 * mono chrome. Governing content rule: chrome is uppercase; evidence (commands,
 * paths, hashes) is verbatim and never case-transformed by content generation.
 * All textures are pure CSS gradients / inline SVG — the CSP (default-src
 * 'none', no img-src/font-src) blocks every external asset and data: URI, and
 * must stay untouched.
 *
 * The page is authored as module-level constants (CSS + client JS) concatenated
 * in renderPage(). Rules for the string contents:
 *  - CLIENT_JS uses '...' + concatenation only — no backticks/nested templates.
 *  - No `${` may appear in the emitted output except the intended interpolations
 *    in the skeleton below (gated in verification).
 *  - Literal UTF-8 glyphs over escape sequences; keep `\\` doublings as-is.
 */

const PAGE_CSS = `  :root {
    /* substrate — deactivated CRT, one neutral gray family */
    --bg-0:#0A0A0A; --bg-1:#101010; --bg-2:#161616;
    --grid:#262626;   /* 1px razor dividers */
    --grid-2:#3A3A3A; /* 2px structural borders */
    /* phosphor */
    --fg-0:#EAEAEA; --fg-1:#9A9A9A;
    --fg-2:#767676; /* decoration only — never body text */
    /* the accent (red = hazard, never selection) + the single green element */
    --red:#FF2A2A; --red-wash:rgba(255,42,42,0.06); --green:#4AF626;
    --mono:ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,"DejaVu Sans Mono",monospace;
    --macro:system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;
    --ease:cubic-bezier(0.32,0.72,0,1);
  }
  * { box-sizing:border-box; border-radius:0; }
  html { height:100%; }
  body { margin:0; height:100vh; height:100dvh; overflow:hidden;
    display:flex; flex-direction:column;
    background:var(--bg-0); color:var(--fg-0); font:400 12px/1.5 var(--mono); }
  .lb { font-size:10px; font-weight:400; letter-spacing:.08em; text-transform:uppercase; color:var(--fg-1); }
  .num { font-variant-numeric:tabular-nums; }
  .scan { background-image:repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,0,0,.4) 2px 4px); }
  samp { user-select:all; }
  kbd { border:1px solid var(--grid-2); padding:1px 6px; font:700 11px var(--mono); letter-spacing:.05em; }
  :focus-visible { outline:2px solid var(--red); outline-offset:-2px; }

  /* film grain — decorative only; delete .noise (here + the svg) on any jank */
  svg.noise { position:fixed; inset:0; width:100%; height:100%; pointer-events:none; opacity:.035; z-index:40; }

  /* ── HUD status bar ─────────────────────────────────────────────── */
  #hud { flex:none; position:relative; z-index:10; display:grid;
    grid-template-columns:max-content 1fr repeat(4,max-content) minmax(0,max-content) max-content;
    gap:1px; background:var(--grid); border-bottom:2px solid var(--grid-2); }
  #hud .cell { background:var(--bg-0); padding:7px 14px 6px; display:flex; flex-direction:column; justify-content:center; gap:1px; min-width:0; }
  #hud .brand { flex-direction:row; align-items:baseline; gap:8px; }
  #hud .brand b { font-size:12px; font-weight:700; letter-spacing:.1em; }
  #hud .spacer { background-color:var(--bg-1); }
  #hud .cv { font-size:12px; font-weight:700; letter-spacing:.05em; font-variant-numeric:tabular-nums;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #recDot { font-size:12px; font-weight:700; }
  #recDot.rec { color:var(--green); }
  #recDot.idle { color:var(--fg-1); }
  #recDot.link { color:var(--red); }

  /* ── error strip ────────────────────────────────────────────────── */
  #alert { flex:none; display:none; padding:5px 14px; background:var(--bg-0);
    border-bottom:1px solid var(--red); color:var(--red);
    font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
  #alert.on { display:block; }

  /* ── panes ──────────────────────────────────────────────────────── */
  .wrap { flex:1; min-height:0; display:flex; }
  aside { width:320px; flex:none; min-height:0; display:flex; flex-direction:column; border-right:2px solid var(--grid-2); }
  .railhead { flex:none; display:flex; justify-content:space-between; align-items:baseline; padding:8px 14px; border-bottom:1px solid var(--grid); }
  #sessions { flex:1; overflow:auto; min-height:0; }
  main { flex:1; overflow:auto; min-width:0; }

  /* ── session manifest ───────────────────────────────────────────── */
  .sess { position:relative; padding:10px 14px; cursor:pointer; border-bottom:1px solid var(--grid);
    transition:background 200ms var(--ease); }
  .sess:hover { background:var(--bg-1); }
  .sess:active { transform:scale(0.98); }
  .sess.active { background:var(--bg-2); }
  .sess.flagged::before { content:""; position:absolute; left:0; top:0; bottom:0; width:2px; background:var(--red); }
  .sess .top { display:flex; align-items:baseline; gap:8px; }
  .sess .idx { color:var(--fg-1); font-size:10px; letter-spacing:.05em; font-variant-numeric:tabular-nums; }
  .sess .sel { color:var(--fg-0); display:none; }
  .sess.active .sel { display:inline; }
  .sess .id { flex:1; min-width:0; font-weight:700; letter-spacing:.05em; text-transform:uppercase;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess .fl { color:var(--red); font-weight:700; font-size:14px; font-variant-numeric:tabular-nums; }
  .sess .fl.clean { color:var(--fg-1); font-weight:400; font-size:10px; letter-spacing:.08em; }
  .sess .meta, .sess .proj { color:var(--fg-1); font-size:10px; letter-spacing:.05em; text-transform:uppercase;
    margin-top:2px; font-variant-numeric:tabular-nums; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sess .live { color:var(--red); font-weight:700; }

  /* ── verdict bar (the screenshot hero) ──────────────────────────── */
  .verdict { position:relative; padding:14px 24px 12px; background-color:var(--bg-1);
    border-bottom:2px solid var(--grid-2); }
  .verdict::before, .verdict::after { color:var(--fg-2); font:400 12px var(--mono); position:absolute; }
  .verdict::before { content:"+"; top:2px; left:6px; }
  .verdict::after { content:"+"; bottom:2px; right:6px; }
  .vframe { display:flex; justify-content:space-between; gap:16px; margin-bottom:10px; }
  .vid { margin-bottom:12px; display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; }
  .vid samp { font-size:12px; font-weight:700; letter-spacing:.03em; }
  .vrank { display:flex; align-items:flex-end; gap:28px; flex-wrap:wrap; }
  .vnum { font-family:var(--macro); font-weight:900; font-size:clamp(2.75rem,9vw,6.5rem);
    line-height:.9; letter-spacing:-.04em; font-variant-numeric:tabular-nums; }
  .vnum.hot { color:var(--red); }
  .vnum-lb { margin-top:4px; font-weight:700; }
  .vstat .vsv { font-family:var(--macro); font-weight:700; font-size:24px; line-height:1; font-variant-numeric:tabular-nums; }
  .vstat .lb { margin-top:4px; }
  .vint { margin-left:auto; text-align:right; display:flex; flex-direction:column; gap:3px; align-items:flex-end; }
  .vint .mark { color:var(--fg-0); }
  .barcode { display:flex; gap:1px; height:14px; align-items:stretch; }
  .barcode span { display:block; background:var(--fg-2); }
  .vsig { margin-top:12px; padding-top:8px; border-top:1px solid var(--grid); display:flex; flex-wrap:wrap; gap:0; align-items:center; }
  .vsig .cellsig { padding:0 12px; border-left:1px solid var(--grid); white-space:nowrap; }
  .vsig .cellsig:first-child { padding-left:0; border-left:none; }
  .combo { width:100%; margin-top:4px; color:var(--fg-1); font-size:10px; letter-spacing:.05em; text-transform:uppercase; }
  .combo.hot { color:var(--red); }
  .combo .arrow { color:var(--red); }
  .stamp { display:inline-block; padding:2px 8px; font-size:11px; font-weight:700; letter-spacing:.08em; }
  .stamp.solid { background:var(--red); color:#0A0A0A; }
  .stamp.outline { border:1px solid var(--red); color:var(--red); }
  .stamp.neutral { border:1px solid var(--grid-2); color:var(--fg-1); }

  /* ── timeline table ─────────────────────────────────────────────── */
  table { width:100%; border-collapse:collapse; }
  thead th { position:sticky; top:0; z-index:5; background:var(--bg-0); text-align:left;
    padding:6px 8px; border-bottom:2px solid var(--grid-2);
    font:400 10px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--fg-1); }
  thead th.r { text-align:right; }
  tr.row { border-bottom:1px solid var(--grid); cursor:pointer; transition:background 200ms var(--ease); }
  tr.row:hover { background:var(--bg-1); }
  tr.row.open { background:var(--bg-2); box-shadow:inset 2px 0 0 var(--grid-2); }
  tr.row.t4 { background:var(--red-wash); box-shadow:inset 2px 0 0 var(--red); }
  td { padding:5px 8px; vertical-align:top; }
  td.seq { width:1%; text-align:right; color:var(--fg-1); font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.seq span { display:inline-block; transition:transform 200ms var(--ease); }
  tr.row:hover td.seq span { transform:translateX(2px); }
  td.t { width:1%; color:var(--fg-1); font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.ag { width:1%; color:var(--fg-1); text-align:center; }
  td.st { width:1%; text-align:center; color:var(--fg-2); }
  td.st.hot { color:var(--red); font-weight:700; }
  td.ty { width:1%; color:var(--fg-1); font-size:10px; letter-spacing:.08em; white-space:nowrap; }
  td.tool { width:1%; max-width:16ch; font-weight:700; letter-spacing:.05em; text-transform:uppercase;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  td.tgt { max-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  tr.row.t3 td.tgt { opacity:.7; }
  td.tgt .gm { color:var(--red); }
  td.dur { width:1%; text-align:right; color:var(--fg-1); font-size:11px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  td.chips { width:1%; white-space:nowrap; text-align:right; }
  tr.turn td { padding:3px 8px; background:var(--bg-0); border-bottom:1px solid var(--grid);
    color:var(--fg-2); font-size:10px; letter-spacing:.08em; text-transform:uppercase;
    white-space:nowrap; overflow:hidden; }
  tr.turn td b { color:var(--fg-1); font-weight:400; }

  /* signal tags — four luminance tiers, one hue */
  .chip { display:inline-block; margin-left:4px; padding:1px 6px;
    font-size:10px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; }
  .chip.solid { background:var(--red); color:#0A0A0A; }
  .chip.outline { border:1px solid var(--red); color:var(--red); padding:0 5px; }
  .chip.inverse { background:var(--fg-0); color:#0A0A0A; }
  .chip.neutral { border:1px solid var(--grid-2); color:var(--fg-1); padding:0 5px; }

  /* ── dossier (expanded detail) ──────────────────────────────────── */
  .detail { background:var(--bg-2); border-top:1px solid var(--grid); border-bottom:2px solid var(--grid-2); padding:14px 24px; }
  .detail .kv { color:var(--fg-1); font-size:11px; letter-spacing:.05em; margin-bottom:10px; font-variant-numeric:tabular-nums; }
  .detail .kv b { color:var(--fg-0); font-weight:700; letter-spacing:.05em; }
  .detail h4 { margin:12px 0 4px; font:500 10px/1.4 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--fg-1); }
  .detail pre { margin:0; padding:10px 12px; background:var(--bg-0); border:1px solid var(--grid); border-left:2px solid var(--grid-2);
    overflow:auto; max-height:280px; white-space:pre-wrap; word-break:break-word; font-size:12px; }
  .detail .redact { background:var(--fg-0); color:#0A0A0A; font-weight:700; padding:0 2px; }
  .chain { border:1px solid var(--grid-2); outline:1px solid var(--grid); outline-offset:2px;
    padding:8px 12px; margin:2px 0 4px; font-size:11px; font-variant-numeric:tabular-nums; }
  .chain .arrow { color:var(--red); }
  .chain .cap { margin-top:4px; color:var(--fg-1); font-size:10px; letter-spacing:.05em; text-transform:uppercase; }
  .gline { font-size:11px; margin:1px 0; font-variant-numeric:tabular-nums; }
  .gline .gl { display:inline-block; min-width:9ch; color:var(--fg-1); font-size:10px; letter-spacing:.08em; text-transform:uppercase; }
  .gline .del { color:var(--red); }
  .derr { color:var(--red); font-size:11px; font-weight:700; letter-spacing:.05em; text-transform:uppercase; }

  /* ── states ─────────────────────────────────────────────────────── */
  .empty { position:relative; margin:40px auto; max-width:520px; padding:24px; text-align:center; }
  .empty::before { content:"+"; position:absolute; top:0; left:0; color:var(--fg-2); }
  .empty::after { content:"+"; position:absolute; bottom:0; right:0; color:var(--fg-2); }
  .empty .lb { display:block; margin-bottom:8px; }
  .empty p { margin:4px 0; color:var(--fg-1); font-size:11px; letter-spacing:.05em; text-transform:uppercase; }
  .skel { padding:10px 14px; border-bottom:1px solid var(--grid); }
  .skel i { display:block; height:10px; background:var(--bg-2); margin:4px 0; }
  .skel i:first-child { width:60%; } .skel i:last-child { width:85%; }
  .cursor { display:inline-block; }

  /* ── motion (all custom-eased; nothing animates on idle polls) ──── */
  @media (prefers-reduced-motion: no-preference) {
    @keyframes enter { from { opacity:0; transform:translateY(8px); } }
    tr.row.enter, .sess.enter { animation:enter 320ms var(--ease) both; }
    @keyframes dfade { from { opacity:0; transform:translateY(-4px); } }
    .detail { animation:dfade 240ms var(--ease) both; }
    @keyframes blink { 50% { opacity:.25; } }
    #recDot.rec { animation:blink 1.6s steps(2, jump-none) infinite; }
    .skel i, .cursor { animation:blink 1.2s steps(2, jump-none) infinite; }
    @keyframes slidein { from { transform:translateY(-8px); opacity:0; } }
    #alert.on { animation:slidein 240ms var(--ease); }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation:none !important; transition:none !important; }
  }
  @media (max-width:960px) {
    aside { width:240px; }
    #hud .opt { display:none; }
    #hud { grid-template-columns:max-content 1fr repeat(4,max-content) max-content; }
  }
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
// changed rows (a Pre paired by its Post — read-api mutates in place) patch
// their cells; new rows append and animate exactly once. Dossiers persist.
//
// SECURITY: recorded strings are hostile. el()/textContent only — never
// innerHTML/insertAdjacentHTML; class names are never derived from data.
// The tag map falls back to a neutral tag for unknown flag ids (risk-rules.ts
// may grow the FlagId union without touching this file).
// Null-prototype so a flag/type/verdict named like a builtin ('constructor',
// 'toString', '__proto__') can't resolve to an inherited member and skip the
// fallback path.
const CLIENT_JS = `const SIG = Object.assign(Object.create(null), {
  'failed':           {t:'FAIL',      c:'outline'},
  'secret-touch':     {t:'SECRET',    c:'inverse'},
  'destructive-git':  {t:'DESTR-GIT', c:'solid'},
  'dangerous-shell':  {t:'DANGER-SH', c:'solid'},
  'external-send':    {t:'EXT-SEND',  c:'solid'},
  'injection-output': {t:'INJECTION', c:'solid'},
  'auth-edit':        {t:'AUTH-EDIT', c:'outline'},
  'mass-diff':        {t:'MASS-DIFF', c:'outline'},
  'new-mcp-server':   {t:'NEW-MCP',   c:'neutral'},
});
const SOLID = ['destructive-git','dangerous-shell','external-send','injection-output'];
const TYPE = Object.assign(Object.create(null), { shell_command:'SHELL', git_action:'GIT', file_read:'READ', file_write:'WRITE',
  file_edit:'EDIT', mcp_call:'MCP', web_fetch:'FETCH', task_control:'TASK', session:'SESS', other:'—' });
const STAMP = Object.assign(Object.create(null), { high:['[ HIGH RISK ]','solid'], medium:['[ MEDIUM RISK ]','outline'],
  low:['[ LOW RISK ]','neutral'], none:['[ CLEAN ]','neutral'] });

let current = null, expanded = new Set();
let fpSessions = null, fpTimeline = null, fpVerdict = null, fpHud = null;
let rowState = [];            // [{fp, tr, a}] parallel to the rendered action list
let tbody = null, thead = null;
let lastPrompt = null, turnN = 0;   // turn-divider walk state (reset with rowState)
let haveSessions = false, lastHealth = null, lastHead = null;
const sessEls = new Map();    // session_id -> rail card element
const cardsById = new Map();  // session_id -> latest SessionCard
const NCOLS = 9;

function el(tag, props, ...kids){ const n=document.createElement(tag); if(props) Object.assign(n,props); for(const k of kids) if(k!=null) n.append(k); return n; }
async function api(p){ const r = await fetch(p, {headers:{'accept':'application/json'}}); if(!r.ok) throw new Error(r.status); return r.json(); }
function pad(n,w){ return String(n).padStart(w,'0'); }
function hhmmss(ts){ return (ts||'').slice(11,19) || '—'; }
function fmtDur(ms){ if(ms==null) return '—'; return ms < 1000 ? ms+'ms' : (ms/1000).toFixed(1)+'s'; }
function fmtSpan(a,b){ const s=Math.max(0,Math.round((Date.parse(b)-Date.parse(a))/1000));
  if(!isFinite(s)) return '—';
  const h=Math.floor(s/3600), m=Math.floor((s%3600)/60), r=s%60;
  return h ? h+'H'+pad(m,2)+'M' : m ? m+'M'+pad(r,2)+'S' : r+'S'; }
function fmtRel(ts){ const s=Math.round((Date.now()-Date.parse(ts))/1000);
  if(!isFinite(s)) return '—';   // malformed ts renders a dash, never a false LIVE
  if(s<10) return null; if(s<60) return s+'S AGO'; if(s<3600) return Math.floor(s/60)+'M AGO';
  if(s<86400) return Math.floor(s/3600)+'H AGO'; return Math.floor(s/86400)+'D AGO'; }
function basename(p){ if(!p) return null; const parts=p.split(/[\\\\/]/).filter(Boolean); return parts[parts.length-1]||null; }

function chip(s){ const m=SIG[s]||{t:s,c:'neutral'}; return el('span',{className:'chip '+m.c,textContent:m.t}); }
function rowTier(a){
  const failed = a.success===0 || a.signals.includes('failed');
  const solid = a.signals.some(s=>SOLID.includes(s));
  return { failed, solid, flagged:a.signals.length>0 };
}

/* ── HUD ─────────────────────────────────────────────────────────── */
function updateHud(h){
  lastHealth = h;
  const grew = lastHead !== null && h.head_seq > lastHead;   // track head even on gated ticks
  lastHead = h.head_seq;
  const mode = grew ? 'rec' : 'idle';
  const fp = JSON.stringify([h.count, h.head_seq, h.db, h.port, mode]);
  if(fp === fpHud) return;                                    // idle poll → zero DOM work
  fpHud = fp;
  document.getElementById('hEvents').textContent = pad(h.count||0,6);
  document.getElementById('hHead').textContent = pad(h.head_seq||0,6);
  const st = document.getElementById('hStore'); st.textContent = h.db||''; st.title = h.db||'';
  document.getElementById('hHost').textContent = '127.0.0.1:'+(h.port||'');
  setRec(mode);
}
function setRec(mode){
  const dot = document.getElementById('recDot'), lab = document.getElementById('recLabel');
  dot.className = mode;
  dot.textContent = mode==='rec' ? '●' : mode==='idle' ? '○' : '▲';
  lab.textContent = mode==='rec' ? 'REC' : mode==='idle' ? 'IDLE' : 'LINK';
}
function setLink(ok){
  const a = document.getElementById('alert');
  if(ok){ a.classList.remove('on'); return; }
  a.textContent = '/// LINK DOWN — DAEMON UNREACHABLE · RETRYING EVERY 3S';
  a.classList.add('on');
  setRec('link');
  fpHud = null;   // force the next good health poll to re-render the REC dot off 'link'
}

/* ── session manifest ────────────────────────────────────────────── */
function select(id){
  if(current === id) return;
  current = id; expanded = new Set();
  fpTimeline = null; fpVerdict = null; rowState = []; tbody = null; thead = null;
  lastPrompt = null; turnN = 0;
  for(const [sid, d] of sessEls) d.classList.toggle('active', sid === current);
  loadTimeline().catch(()=>{});
}

async function loadSessions(){
  const cards = await api('/api/sessions');
  const fp = JSON.stringify(cards);
  if(fp === fpSessions) return;
  renderSessions(cards);
  fpSessions = fp;   // commit only after a successful render, so a mid-render throw retries
}

// Relative-age labels ('12S AGO', 'LIVE') depend on wall-clock, but the cards
// JSON is fingerprint-gated — an idle daemon would freeze them. Refresh them
// every poll outside the gate, writing only when the text actually changes.
function refreshRel(){
  for(const d of sessEls.values()){
    if(!d._relEl) continue;
    const rel = fmtRel(d._ended);
    const txt = rel === null ? 'LIVE' : rel;
    if(d._relEl.textContent !== txt){ d._relEl.textContent = txt; d._relEl.className = rel === null ? 'live' : ''; }
  }
}

function renderSessions(cards){
  const box = document.getElementById('sessions');
  document.getElementById('sessCount').textContent = pad(cards.length,3);
  document.getElementById('railStatus').textContent = '';
  haveSessions = cards.length > 0;
  cardsById.clear(); for(const c of cards) cardsById.set(c.session_id, c);
  if(!cards.length){
    sessEls.clear(); box.textContent='';
    box.append(el('div',{className:'empty'}, el('span',{className:'lb',textContent:'[ NONE RECORDED ]'})));
    return;
  }
  if(!current) current = cards[0].session_id;
  if(!sessEls.size) box.textContent='';                       // clear skeleton/empty placeholder
  const live = new Set(cards.map(c=>c.session_id));
  for(const [sid, d] of sessEls) if(!live.has(sid)){ d.remove(); sessEls.delete(sid); }
  let prev = null;
  cards.forEach((c, i)=>{
    let d = sessEls.get(c.session_id);
    if(!d){
      d = el('div',{className:'sess enter',tabIndex:0});
      d.style.animationDelay = Math.min(i,20)*25+'ms';
      // Strip 'enter' once the entrance finishes so a later insertBefore reorder
      // can't replay it. (Under reduced-motion the animation is disabled, so the
      // event never fires and never needs to — 'enter' stays inert.)
      d.addEventListener('animationend', ()=>{ d.classList.remove('enter'); d.style.animationDelay=''; }, {once:true});
      d.onclick = ()=>select(c.session_id);
      d.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); select(c.session_id); } };
      sessEls.set(c.session_id, d);
    }
    const cfp = JSON.stringify([c, i]);
    if(d._fp !== cfp){ d._fp = cfp; fillCard(d, c, i); }
    d.classList.toggle('active', c.session_id === current);
    const want = prev ? prev.nextSibling : box.firstChild;    // reposition only on real reorder
    if(want !== d) box.insertBefore(d, want);
    prev = d;
  });
}

function fillCard(d, c, i){
  const keepEnter = d.className.includes('enter');
  d.textContent = '';
  d.className = 'sess' + (keepEnter ? ' enter' : '') + (c.flagged ? ' flagged' : '') +
    (c.session_id === current ? ' active' : '');
  const fl = c.flagged
    ? el('span',{className:'fl num',textContent:String(c.flagged)})
    : el('span',{className:'fl clean',textContent:'CLEAN'});
  d.append(el('div',{className:'top'},
    el('span',{className:'idx',textContent:pad(i+1,3)}),
    el('span',{className:'id',title:c.session_id}, el('span',{className:'sel',textContent:'▸ '}), c.session_id.slice(0,18)),
    fl));
  const rel = fmtRel(c.ended);
  const relEl = el('span',{className:rel===null?'live':'',textContent:rel===null?'LIVE':rel});
  d._relEl = relEl; d._ended = c.ended;   // refreshRel() keeps this current between data polls
  d.append(el('div',{className:'meta'}, pad(c.events,4)+' EV · '+fmtSpan(c.started,c.ended)+' · ', relEl));
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
  if(current !== sid) return;   // selection changed while this fetch was in flight — discard
  const fp = JSON.stringify([sid, actions]);
  if(fp === fpTimeline){
    // Events unchanged but the SessionCard (risk verdict/score/combos) may have
    // advanced — refresh the verdict bar, which self-gates and does nothing if equal.
    if(tbody && tbody.isConnected) updateVerdict(actions);
    return;
  }
  renderTimeline(main, actions);
  fpTimeline = fp;   // commit only after a successful render
}

function emptyState(kind){
  if(kind === 'sel'){
    return el('div',{className:'empty'}, el('span',{className:'lb',textContent:'[ AWAITING SELECTION ]'}));
  }
  const host = lastHealth ? '127.0.0.1:'+lastHealth.port : '127.0.0.1';
  const store = (lastHealth && lastHealth.db) || '~/.blackbox';
  const box = el('div',{className:'empty scan'});
  box.append(
    el('span',{className:'lb',textContent:'[ RECORDER ARMED ]'}),
    el('p',{textContent:'LISTENING '+host+' · STORE '+store}),
    el('p',{textContent:'RUN A CLAUDE CODE SESSION IN A HOOKED PROJECT.'}),
    el('p',{textContent:'EVENTS APPEAR HERE WITHIN 3 SECONDS. NOTHING LEAVES THIS MACHINE.'}));
  return box;
}

function renderTimeline(main, actions){
  // Incremental only when the rendered prefix still matches the append-only list;
  // anything else (session switch, db swap/shrink) is a full rebuild.
  const incremental = tbody && tbody.isConnected && rowState.length > 0 &&
    rowState.length <= actions.length &&
    rowState[0].a.key === actions[0].key;
  if(!incremental){
    main.textContent='';
    fpVerdict = null; rowState = []; lastPrompt = null; turnN = 0;
    main.append(el('section',{className:'verdict scan',id:'verdict'}));
    const tbl = el('table');
    tbl.setAttribute('aria-label','action timeline');
    thead = el('thead',{}, el('tr',{},
      el('th',{className:'r',textContent:'SEQ'}), el('th',{textContent:'TIME'}),
      el('th',{textContent:'AG'}), el('th',{textContent:'ST'}), el('th',{textContent:'TYPE'}),
      el('th',{textContent:'TOOL'}), el('th',{textContent:'TARGET'}),
      el('th',{className:'r',textContent:'DUR'}), el('th',{className:'r',textContent:'SIGNALS'})));
    for(const th of thead.querySelectorAll('th')) th.setAttribute('scope','col');
    tbody = el('tbody');
    tbl.append(thead, tbody); main.append(tbl);
  }
  updateVerdict(actions);
  let batch = 0;
  for(let i=0;i<actions.length;i++){
    const a = actions[i];
    if(i < rowState.length){
      const st = rowState[i];
      const afp = JSON.stringify(a);
      if(st.fp !== afp){
        if(st.a.key !== a.key){ fpTimeline = null; rowState = []; tbody = null; renderTimeline(main, actions); return; }
        buildRowCells(a, st.tr, false);
        st.fp = afp; st.a = a;
        if(expanded.has(a.seq)) insertDetail(a.seq, st.tr);  // refresh on Pre→Post pairing; insertDetail swaps atomically (no blank frame)
      }
    } else {
      appendRow(a, batch++);
    }
  }
}

function maybeDivider(a){
  if(!a.prompt_id || a.prompt_id === lastPrompt) return;   // null never opens/closes a turn
  lastPrompt = a.prompt_id; turnN++;
  const td = el('td',{colSpan:NCOLS},
    '── TURN '+pad(turnN,2)+' · ', el('b',{textContent:a.prompt_id.slice(0,6)}),
    ' ─────────────────────────────────────────────');
  tbody.append(el('tr',{className:'turn'}, td));
}

function buildRowCells(a, tr, entering){
  tr.textContent='';
  const tier = rowTier(a);
  tr.className = 'row' + (tier.solid ? ' t4' : tier.failed ? ' t3' : '') +
    (expanded.has(a.seq) ? ' open' : '') + (entering ? ' enter' : '');
  const mark = tier.failed ? '×' : tier.solid ? '█' : tier.flagged ? '!' : '·';
  const sub = a.agent_type && a.agent_type !== 'main';
  const chips = el('td',{className:'chips'}); a.signals.forEach(s=>chips.append(chip(s)));
  const tgt = el('td',{className:'tgt',title:a.target||''});
  if(a.type === 'git_action') tgt.append(el('span',{className:'gm',textContent:'» '}));
  let t = a.target || '';
  if(t.length > 120 && (a.type==='file_read'||a.type==='file_write'||a.type==='file_edit')) t = '…'+t.slice(-119);
  tgt.append(t);
  tr.append(
    el('td',{className:'seq'}, el('span',{textContent:pad(a.seq,4)})),
    el('td',{className:'t',textContent:hhmmss(a.ts)}),
    el('td',{className:'ag',title:sub?(a.agent_type||''):'',textContent:sub?'▸':''}),
    el('td',{className:'st'+(mark==='·'?'':' hot'),textContent:mark}),
    el('td',{className:'ty',textContent:TYPE[a.type]||(a.type||'').slice(0,5)}),
    el('td',{className:'tool',title:a.tool||a.hook_event,textContent:(a.tool||a.hook_event)}),
    tgt,
    el('td',{className:'dur',textContent:fmtDur(a.duration_ms)}),
    chips);
}

function appendRow(a, batchIdx){
  maybeDivider(a);
  const tr = el('tr',{tabIndex:0});
  tr.style.animationDelay = Math.min(batchIdx,20)*25+'ms';
  buildRowCells(a, tr, true);
  tr.onclick = ()=>toggle(a.seq, tr);
  tr.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(a.seq, tr); } };
  tbody.append(tr);
  rowState.push({fp: JSON.stringify(a), tr, a});
  if(expanded.has(a.seq)) insertDetail(a.seq, tr);
}

/* ── verdict bar ─────────────────────────────────────────────────── */
function updateVerdict(actions){
  const v = document.getElementById('verdict');
  if(!v) return;
  const card = cardsById.get(current) || null;
  const flagN = actions.reduce((n,a)=>n+a.signals.length,0);
  const failN = actions.filter(a=>a.success===0 || a.signals.includes('failed')).length;
  const fp = JSON.stringify([current, actions.length, flagN, failN, card]);
  if(fp === fpVerdict) return;
  fpVerdict = fp;
  v.textContent = '';

  v.append(el('div',{className:'vframe'},
    el('span',{className:'lb',textContent:'[ SESSION VERDICT ]'}),
    el('span',{className:'lb',textContent:'BLACKBOX · LOCAL FLIGHT RECORDER'})));

  const idLine = el('div',{className:'vid'}, el('samp',{textContent:current}));
  const bits = [];
  if(actions.length){
    const d0 = (actions[0].ts||'').slice(0,10);
    bits.push(d0+' '+(actions[0].ts||'').slice(11,16)+'→'+(actions[actions.length-1].ts||'').slice(11,16));
  }
  if(card) bits.push(fmtSpan(card.started, card.ended));
  const proj = card && basename(card.cwd); if(proj) bits.push(proj);
  if(bits.length) idLine.append(el('span',{className:'lb',textContent:bits.join(' · ')}));
  v.append(idLine);

  const rank = el('div',{className:'vrank'});
  rank.append(el('div',{},
    el('div',{className:'vnum'+(flagN?' hot':''),textContent:pad(flagN,2)}),
    el('div',{className:'lb vnum-lb',textContent:flagN?'FLAGS RAISED':'NOMINAL'})));
  rank.append(el('div',{className:'vstat'},
    el('div',{className:'vsv',textContent:String(actions.length)}), el('div',{className:'lb',textContent:'ACTIONS'})));
  rank.append(el('div',{className:'vstat'},
    el('div',{className:'vsv',textContent:String(failN)}), el('div',{className:'lb',textContent:'FAILED'})));
  if(card && card.verdict && card.verdict !== 'unscored' && STAMP[card.verdict]){
    const s = STAMP[card.verdict];
    rank.append(el('div',{className:'vstat'}, el('span',{className:'stamp '+s[1],textContent:s[0]}),
      el('div',{className:'lb',textContent:'RULESET '+(card.ruleset_version||'')})));
  }
  const seqA = actions.length ? pad(actions[0].seq,4) : '0000';
  const seqB = actions.length ? pad(actions[actions.length-1].seq,4) : '0000';
  const integ = el('div',{className:'vint'},
    el('span',{className:'lb'}, el('span',{className:'mark',textContent:'■ '}), 'HASH-CHAINED · SEQ '+seqA+'→'+seqB+' · APPEND-ONLY'),
    el('span',{className:'lb'}, 'VERIFY: ', el('kbd',{textContent:'blackbox verify'})));
  const bar = el('div',{className:'barcode'});
  const sid = current || '';
  for(let i=0;i<Math.min(sid.length,48);i++){
    const w = (sid.charCodeAt(i) % 3) + 1;
    bar.append(el('span',{style:'width:'+w+'px'}));
  }
  integ.append(bar);
  rank.append(integ);
  v.append(rank);

  const sig = el('div',{className:'vsig'});
  const counts = (card && card.flags && Object.keys(card.flags).length)
    ? Object.entries(card.flags)
    : Object.entries(actions.reduce((m,a)=>{ a.signals.forEach(s=>m[s]=(m[s]||0)+1); return m; }, Object.create(null)));
  counts.sort((x,y)=>y[1]-x[1]);
  if(counts.length){
    for(const kn of counts){
      sig.append(el('span',{className:'cellsig'}, chip(kn[0]), el('span',{className:'lb num',textContent:' ×'+kn[1]})));
    }
  } else {
    sig.append(el('span',{className:'cellsig'},
      el('span',{className:'stamp neutral',textContent:'[ CLEAN ]'}),
      el('span',{className:'lb num',textContent:' '+actions.length+' ACTIONS · 0 FLAGS · HASH-CHAINED '+seqA+'→'+seqB})));
  }
  if(card && Array.isArray(card.combos)){
    for(const cb of card.combos){
      sig.append(el('div',{className:'combo'+(cb.severity==='high'?' hot':'')},
        '» COMBO '+(cb.id||'')+' · '+pad(cb.antecedent_seq||0,4), el('span',{className:'arrow',textContent:' ─▶ '}),
        pad(cb.consequent_seq||0,4)+(cb.note?' · '+cb.note:'')));
    }
  }
  v.append(sig);
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

function secLabel(text){ return el('h4',{textContent:'[ '+text+' ]'}); }

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
  // Per-row generation token: two in-flight detail fetches for the same row
  // (a toggle + a Pre→Post pairing refresh) must not race — only the newest wins.
  const gen = row._dgen = (row._dgen || 0) + 1;
  const stale = ()=> row._dgen !== gen || !expanded.has(seq) || !row.isConnected;
  let d;
  try { d = await api('/api/event/'+seq); }
  catch {
    if(stale()) return;
    removeDetail(row);
    row.after(el('tr',{className:'detailrow'}, el('td',{colSpan:NCOLS},
      el('div',{className:'detail'}, el('span',{className:'derr',textContent:'▲ RECORD FETCH FAILED — SEQ '+pad(seq,4)})))));
    return;
  }
  if(stale()) return;                                 // superseded / collapsed / replaced while fetching
  removeDetail(row);                                  // never double-insert
  const box = el('div',{className:'detail'});

  // identity strip
  const idbits = ['EVT '+pad(d.seq,4), (d.action_type||''), (d.phase||''), hhmmss(d.ts)];
  if(d.duration_ms != null) idbits.push(fmtDur(d.duration_ms));
  if(d.redaction_count) idbits.push(d.redaction_count+' REDACTED');
  box.append(el('div',{className:'kv'},
    el('b',{textContent:(d.tool_name||d.hook_event)}), ' · '+idbits.join(' · ')));

  // chain link — the tamper-evidence seal
  const chain = el('div',{className:'chain'});
  chain.append(el('div',{}, el('span',{className:'lb',textContent:'[ CHAIN LINK ] '}),
    el('span',{className:'num'}, pad(Math.max(0,d.seq-1),4), el('span',{className:'arrow',textContent:' ─▶ '}), pad(d.seq,4))));
  const hashes = el('div',{});
  hashes.append(el('span',{className:'lb',textContent:'PREV '}));
  hashes.append(d.seq === 1 ? 'GENESIS' : el('samp',{title:d.prev_hash||'',textContent:(d.prev_hash||'').slice(0,16)+'…'}));
  hashes.append(el('span',{className:'arrow',textContent:' ─▶ '}), el('span',{className:'lb',textContent:'HASH '}),
    el('samp',{title:d.hash||'',textContent:(d.hash||'').slice(0,16)+'…'}));
  chain.append(hashes);
  chain.append(el('div',{className:'cap',textContent:'EACH RECORD HASHES ITS PREDECESSOR — EDIT ANY ROW AND blackbox verify BREAKS HERE.'}));
  box.append(chain);

  const input = d.raw && typeof d.raw === 'object' ? d.raw.tool_input : undefined;
  if(input !== undefined){
    box.append(secLabel('INPUT · REDACTED'+(d.redaction_count?' · '+d.redaction_count:'')),
      redactedPre(JSON.stringify(input,null,2)));
  }
  if(d.output_hash){
    box.append(secLabel('OUTPUT PROVENANCE'),
      el('pre',{textContent:'OUTPUT ELIDED BY POLICY — CONTENT NEVER WRITTEN TO DISK\\nSHA-256 '+d.output_hash+'\\n'+(d.output_size_bytes||0)+' BYTES'}));
  }
  const git = d.detail && d.detail.git;
  if(git){
    box.append(secLabel('GIT'));
    if(git.ref) box.append(gline('REF', el('samp',{textContent:git.ref})));
    if(git.kind) box.append(gline('KIND', String(git.kind).toUpperCase()));
    if(git.old_sha || git.new_sha){
      box.append(gline('SHAS', el('samp',{textContent:String(git.old_sha||'').slice(0,7)}),
        el('span',{className:'arrow gm',textContent:' ─▶ '}), el('samp',{textContent:String(git.new_sha||'').slice(0,7)})));
    }
    const warn = ['is_force','is_reset','is_delete','is_amend'].filter(k=>git[k]);
    if(warn.length){
      const w = gline('FLAGS');
      warn.forEach(k=>w.append(el('span',{className:'chip solid',textContent:k.slice(3).toUpperCase()})));
      box.append(w);
    }
    if(git.diffstat){
      box.append(gline('DIFFSTAT', '+'+(git.diffstat.insertions||0)+' ', el('span',{className:'del',textContent:'−'+(git.diffstat.deletions||0)}),
        ' · '+(git.diffstat.files||0)+' FILES'));
    }
    if(git.commit && git.commit.subject) box.append(gline('COMMIT', git.commit.subject));
  }
  const corr = d.detail && d.detail.correlation;
  if(corr){
    box.append(secLabel('CORRELATION'));
    const conf = String(corr.confidence||'none').toUpperCase();
    box.append(gline('CAUSE', el('span',{className:'chip '+(conf==='EXACT'?'inverse':'neutral'),textContent:conf}),
      corr.session_id ? ' SESSION '+String(corr.session_id).slice(0,18) : '',
      corr.tool_use_id ? ' · '+corr.tool_use_id : ''));
  }
  if(d.risk && (d.risk.score || (d.risk.flags||[]).length)){
    box.append(secLabel('RISK'));
    const r = gline('SCORE', el('span',{className:'num',textContent:String(d.risk.score||0)}));
    (d.risk.flags||[]).forEach(f=>r.append(chip(f)));
    box.append(r);
    if(d.risk.evidence) box.append(el('pre',{textContent:JSON.stringify(d.risk.evidence,null,2)}));
  }
  const reds = d.detail && d.detail.redactions;
  if(Array.isArray(reds) && reds.length){
    box.append(secLabel('REDACTIONS'));
    for(const r of reds) box.append(gline(String(r.type||'').toUpperCase(), (r.path||'')+' · '+(r.bytes||0)+' BYTES'));
  }
  box.append(secLabel('RAW · REDACTED · VERBATIM AS HASHED'), el('pre',{textContent:JSON.stringify(d.raw,null,2)}));

  const dr = el('tr',{className:'detailrow'}, el('td',{colSpan:NCOLS}, box));
  row.after(dr);
}

/* ── poll loop ───────────────────────────────────────────────────── */
async function render(){
  // The LINK banner tracks reachability, which is exactly what /health probes.
  // A single endpoint returning non-2xx must not read as 'daemon unreachable';
  // each pane degrades to its last-good DOM on its own error.
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
<svg class="noise" aria-hidden="true"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="2"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>
<header id="hud">
  <div class="cell brand"><b>BLACKBOX</b><span class="lb">® FLIGHT RECORDER</span></div>
  <div class="cell spacer scan"></div>
  <div class="cell"><span class="lb" id="recLabel">LINK</span><span id="recDot" class="idle">○</span></div>
  <div class="cell"><span class="lb">EVENTS</span><span class="cv" id="hEvents">000000</span></div>
  <div class="cell"><span class="lb">HEAD</span><span class="cv" id="hHead">000000</span></div>
  <div class="cell"><span class="lb">SESSIONS</span><span class="cv" id="sessCount">000</span></div>
  <div class="cell opt"><span class="lb">STORE</span><span class="cv" id="hStore">—</span></div>
  <div class="cell"><span class="lb">HOST</span><span class="cv" id="hHost">127.0.0.1</span></div>
</header>
<div id="alert" role="status" aria-live="polite"></div>
<div class="wrap">
  <aside>
    <div class="railhead"><span class="lb">[ SESSIONS ]</span><span class="lb" id="railStatus">LOADING<span class="cursor">▊</span></span></div>
    <div id="sessions"><div class="skel"><i></i><i></i></div><div class="skel"><i></i><i></i></div><div class="skel"><i></i><i></i></div><div class="skel"><i></i><i></i></div></div>
  </aside>
  <main id="timeline"></main>
</div>
<script>
${CLIENT_JS}</script>
</body>
</html>`;
}
