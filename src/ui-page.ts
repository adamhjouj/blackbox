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
  main { flex:1; overflow:auto; min-width:0; position:relative; }   /* offset parent for turn-jump's offsetTop math */

  /* session rows */
  .sess { padding:9px 11px; border-radius:var(--r2); cursor:pointer; margin-bottom:1px;
    border-left:2px solid transparent; transition:background .12s ease; }
  .sess:hover { background:var(--hover); }
  .sess.active { background:var(--selected); border-left-color:var(--border-strong); }
  .sess .top { display:flex; align-items:baseline; gap:8px; }
  .sess .rk { flex:0 0 auto; width:5px; height:5px; border-radius:50%; background:var(--fg-4); align-self:center; }
  .sess .rk.hot { background:var(--accent); }
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
  /* the Brief's flagged count links into the deep log (scoped under #verdict so Story's summary is untouched) */
  #verdict .flag.jump { cursor:pointer; text-decoration:underline; text-decoration-color:var(--accent-line); text-underline-offset:2px; }
  #verdict .flag.jump:hover { text-decoration-color:var(--accent); }

  /* timeline (flex rows) */
  .tl { padding-bottom:24px; }
  .trow { display:flex; align-items:center; padding:6px 16px 6px 22px; border-left:2px solid transparent; }

  /* filter bar — sticky over the timeline; the column labels ride under it */
  .tlhead { position:sticky; top:0; z-index:3; background:var(--bg); }
  .filterbar { display:flex; align-items:center; gap:8px; padding:8px 16px 8px 12px; border-bottom:1px solid var(--border-subtle); }
  .filterbar button, .filterbar select, .filterbar input {
    font:12.5px var(--sans); color:var(--fg-1); background:var(--surface); border:1px solid var(--border); border-radius:var(--r2); }
  .filterbar :focus { border-color:var(--border-strong); }
  .filterbar :focus:not(:focus-visible) { outline:none; }
  .fb-toggle { padding:5px 11px; color:var(--fg-2); cursor:pointer; white-space:nowrap;
    transition:color .1s ease, border-color .1s ease, background .1s ease; }
  .fb-toggle:hover { color:var(--fg-1); border-color:var(--border-strong); }
  .fb-toggle.on { color:var(--accent); background:var(--accent-wash); border-color:var(--accent-line); }
  .fb-tool { padding:5px 8px; cursor:pointer; max-width:160px; }
  .fb-search { flex:1 1 auto; min-width:90px; padding:5px 10px; color:var(--fg); }
  .fb-search::placeholder { color:var(--fg-4); }
  .fb-jump { padding:5px 11px; color:var(--fg-2); cursor:pointer; white-space:nowrap;
    transition:color .1s ease, border-color .1s ease; }
  .fb-jump:hover:not(:disabled) { color:var(--fg-1); border-color:var(--border-strong); }
  .fb-jump:disabled { opacity:.4; cursor:default; }
  .fb-count { flex:none; margin-left:2px; color:var(--fg-4); font-size:11.5px; font-variant-numeric:tabular-nums; white-space:nowrap; }
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
  .c-tgt .dir  { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--fg-3); }
  .c-tgt .base { flex:0 0 auto; white-space:nowrap; }
  /* the repeated path prefix recedes so the filename is the ink that reads */
  .trow:hover .c-tgt .dir, .trow.open .c-tgt .dir { color:var(--fg-2); }
  /* plain-English summary reads in the sans face, not mono */
  .c-tgt .sum  { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:var(--sans); color:var(--fg-1); }
  .c-sig  { flex:0 0 auto; display:flex; gap:5px; margin-left:10px; }
  .c-sig .tag { margin-left:0; }
  .c-dur  { flex:0 0 auto; margin-left:10px; font-family:var(--mono); font-size:11.5px; color:var(--fg-3); font-variant-numeric:tabular-nums; }
  .c-pad  { flex:1 1 0; min-width:14px; }
  .c-chev { flex:0 0 auto; margin-left:8px; color:var(--fg-4); opacity:0; transition:opacity .1s ease; }
  .trow:hover .c-chev { opacity:.55; }

  /* turn outline — sticky collapsible section bars; a LOG table-of-contents, not a Story card */
  .turnhead { position:sticky; top:var(--turntop,38px); z-index:2;
    display:flex; align-items:center; gap:10px; padding:8px 16px 8px 12px;
    cursor:pointer; user-select:none; background:var(--bg);
    border-top:1px solid var(--border-subtle); border-left:2px solid transparent;
    scroll-margin-top:calc(var(--turntop,38px) + 4px); }
  .turnhead:first-child { border-top:0; }
  .turnhead:hover { background:var(--hover); }
  .turnhead .th-chev { flex:0 0 auto; color:var(--fg-4); transition:transform .12s ease; }
  .turnhead.open .th-chev { transform:rotate(90deg); }
  .turnhead .th-n { flex:0 0 auto; font-size:10.5px; letter-spacing:.05em; color:var(--fg-4); font-variant-numeric:tabular-nums; }
  .turnhead .th-gist { flex:1 1 auto; min-width:0; font-size:12.5px; color:var(--fg-3);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .turnhead.open .th-gist { color:var(--fg-1); }
  .turnhead .th-meta { flex:0 0 auto; font-size:11px; color:var(--fg-4); font-variant-numeric:tabular-nums; white-space:nowrap; }
  .turnhead .th-risk { flex:0 0 auto; width:5px; height:5px; border-radius:50%; background:var(--accent); }

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
  /* mutation diff — the "what changed" evidence */
  .detail .diffstat { font-size:12px; color:var(--fg-3); margin-bottom:6px; font-variant-numeric:tabular-nums; }
  .detail .diffstat .ins { color:var(--live); }
  .detail .diffstat .del { color:var(--accent); }
  .detail pre.diff { white-space:pre; overflow-x:auto; }
  .detail pre.diff .add { color:var(--live); background:rgba(89,183,131,.08); display:block; }
  .detail pre.diff .rem { color:var(--accent); background:var(--accent-wash); display:block; }
  .detail pre.diff .ctx { color:var(--fg-3); display:block; }
  .detail .mnote { font-size:12px; color:var(--fg-3); line-height:1.5; }

  /* story view — the re-traceable session narrative */
  .viewbar { padding:16px 18px 4px; }
  .viewtoggle { display:inline-flex; gap:2px; padding:2px; background:var(--surface); border:1px solid var(--border); border-radius:var(--r2); }
  .viewtoggle button { font:12px var(--sans); color:var(--fg-2); background:transparent; border:0; border-radius:var(--r1);
    padding:4px 13px; cursor:pointer; transition:color .1s ease, background .1s ease; }
  .viewtoggle button:hover { color:var(--fg-1); }
  .viewtoggle button.on { color:var(--fg-hi); background:var(--selected); }

  /* one card per turn; a single flex-gap sets the vertical rhythm (no stray margins) */
  .turns { padding:10px 18px 40px; display:flex; flex-direction:column; gap:10px; }
  .turncard { border:1px solid var(--border-subtle); border-radius:var(--r3); padding:13px 15px 14px;
    background:var(--surface); display:flex; flex-direction:column; gap:11px; }
  .turncard .thd { display:flex; align-items:baseline; gap:14px; }
  .turncard .tnum { flex:0 0 auto; font-size:10.5px; letter-spacing:.06em; text-transform:uppercase;
    color:var(--fg-4); font-variant-numeric:tabular-nums; }
  .turncard .tmeta { flex:1 1 auto; text-align:right; font-size:11.5px; color:var(--fg-4); font-variant-numeric:tabular-nums;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .turncard .tmeta .tflag { color:var(--accent); }
  .turncard .tprompt { font-size:13.5px; line-height:1.55; color:var(--fg-hi); white-space:pre-wrap; word-break:break-word; }
  .turncard .tprompt.muted { color:var(--fg-4); font-size:12px; }

  /* a labelled group of outcome rows (changed files, commits) — shared shell */
  .fgroup { display:flex; flex-direction:column; gap:1px; }
  .summary .fgroup { margin-top:14px; }
  .glabel { font-size:10px; letter-spacing:.05em; text-transform:uppercase; color:var(--fg-4); margin-bottom:4px; }
  .frow, .crow, .srow { border-left:2px solid transparent; }
  .frow { display:flex; align-items:center; gap:14px; padding:4px 8px; border-radius:var(--r1); cursor:pointer; transition:background .1s ease; }
  .frow:hover { background:var(--hover); }
  .frow.open { background:var(--selected); }
  .frow .fname { flex:1 1 auto; min-width:0; font-family:var(--mono); font-size:12.5px; color:var(--fg-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .frow .fstat { flex:0 0 auto; font-family:var(--mono); font-size:11.5px; letter-spacing:.02em; font-variant-numeric:tabular-nums; }
  .frow .fstat .ins { color:var(--live); }
  .frow .fstat .del { color:var(--accent); margin-left:7px; }
  .frow .fskip { flex:0 0 auto; font-size:10.5px; color:var(--fg-4); }
  .crow { display:flex; align-items:center; gap:10px; padding:6px 9px; border-radius:var(--r2);
    cursor:pointer; background:var(--surface-2); border:1px solid var(--border-subtle); }
  .crow:hover { background:var(--hover); }
  .crow.open { background:var(--selected); }
  .crow .csha { flex:0 0 auto; font-family:var(--mono); font-size:11.5px; color:var(--live); }
  .crow .csub { flex:1 1 auto; min-width:0; font-size:12.5px; color:var(--fg-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .crow .cstat { flex:0 0 auto; font-family:var(--mono); font-size:11px; color:var(--fg-3); font-variant-numeric:tabular-nums; }
  .tsteps-toggle { width:fit-content; font-size:11.5px; color:var(--fg-3); cursor:pointer; user-select:none; }
  .tsteps-toggle:hover { color:var(--fg-1); }
  /* R1 reasoning (the "why") */
  .treason pre { margin:0; padding:10px 12px; background:var(--bg); border:1px solid var(--border-subtle); border-radius:var(--r2);
    white-space:pre-wrap; word-break:break-word; font:12px/1.55 var(--mono); color:var(--fg-2); max-height:300px; overflow:auto; }
  .treason .redact { color:var(--accent); background:var(--accent-wash); border-radius:3px; padding:0 3px; }
  /* R2 git-corroboration strip */
  .covstrip { margin:0 18px 12px; padding:10px 14px; border-radius:var(--r3); font-size:12.5px; line-height:1.5; border:1px solid var(--border-subtle); color:var(--fg-3); }
  .covstrip .covlabel { font-weight:600; }
  .covstrip.cov-ok .covlabel { color:var(--live); }
  .covstrip.cov-none { color:var(--fg-4); }
  .covstrip.cov-warn { border-color:var(--accent-line); background:var(--accent-wash); }
  .covstrip.cov-warn .covlabel { color:var(--accent); }
  .covhead { margin-bottom:7px; }
  .covlist { display:flex; flex-direction:column; gap:5px; }
  .covrow { display:flex; gap:11px; align-items:baseline; }
  .covtype { flex:0 0 62px; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--accent); font-weight:600; }
  .covpath { flex:0 0 auto; font-family:var(--mono); font-size:12px; color:var(--fg-1); }
  .covnote { flex:1 1 auto; min-width:0; color:var(--fg-3); font-size:11.5px; }
  /* R4 provenance graph */
  .graphctl { display:flex; align-items:center; gap:14px; padding:9px 18px; flex-wrap:wrap; border-bottom:1px solid var(--border-subtle); }
  .graphctl .fb-tool { padding:5px 8px; }
  .gcount { font-size:11.5px; color:var(--fg-4); font-variant-numeric:tabular-nums; }
  .glegend { display:flex; gap:13px; margin-left:auto; flex-wrap:wrap; }
  .gleg { display:inline-flex; align-items:center; gap:5px; font-size:11px; color:var(--fg-3); }
  .gdot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .graphcanvas { display:block; width:100%; height:560px; cursor:grab; touch-action:none;
    background:radial-gradient(620px 420px at 50% 42%, rgba(255,255,255,.02), transparent 70%); }
  .graphcanvas:active { cursor:grabbing; }
  .gpanel { padding:0 18px 24px; }
  .gpanel .detailrow { margin-top:12px; }
  .gpanel .detail { border:1px solid var(--border); border-radius:var(--r3); }
  .tsteps { display:flex; flex-direction:column; margin-top:-3px; }
  .srow { display:flex; align-items:center; gap:11px; padding:3px 8px; border-radius:var(--r1); cursor:pointer; }
  .srow:hover { background:var(--hover); }
  .srow.open { background:var(--selected); }
  .srow.flag { border-left-color:var(--fg-4); }
  .srow.fail { border-left-color:var(--accent); }
  .srow .stime { flex:0 0 52px; font-family:var(--mono); font-size:11px; color:var(--fg-4); font-variant-numeric:tabular-nums; }
  .srow .stool { flex:0 0 74px; font-size:11.5px; color:var(--fg-3); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .srow .ssum { flex:1 1 auto; min-width:0; font-size:12px; color:var(--fg-1); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .srow .sub { flex:0 0 auto; font-size:9.5px; letter-spacing:.04em; text-transform:uppercase; color:var(--fg-4);
    border:1px solid var(--border); border-radius:var(--r1); padding:0 5px; }

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
    @keyframes rowflash { from { background:rgba(229,89,90,.20); } }
    .trow.flash { animation:rowflash 1s ease; }
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
let viewMode = 'story';               // 'story' (default lens) | 'timeline' | 'graph'
let fpStory = null, storyOpen = new Set();   // fp gate + per-turn step-expansion (by turn key)
let fpGraph = null, graphState = null, graphPrompt = '', graphTurns = [];   // R4 graph: fp gate · running sim · turn filter · turn options
const NODE_COLOR = { prompt:'#8ab4f8', file:'#59b783', commit:'#6cc38a', step:'#8a919c', secret:'#e5595a', host:'#e5595a', mcp:'#b48ead' };
let fpSessions = null, fpTimeline = null, fpVerdict = null, fpHud = null;
let rowState = [];            // [{fp, tr, a}] parallel to the rendered action list
let tbody = null;
let lastPrompt = null, turnN = 0;   // turn-divider walk state (reset with rowState)
// turn-outline state — display-only, survives the 3s poll; reset on session/view switch + full render.
let collapsedTurns = new Set();   // prompt_ids currently folded
let bigSession = false;           // >60 actions → turns fold by default
const turns = [];                 // [{key, hdr}] in render order (keyboard turn-jump)
const turnHeadByKey = new Map();  // prompt_id → .turnhead element
let curTurnKey = null;            // prompt_id the rows are currently appended under
let _rz = 0;                      // rAF handle for the debounced --turntop remeasure
let flagCursor = -1;              // next-flag cursor into the flagged rows (seeded from the viewport, then steps)
let turnCursor = -1;              // turn-jump cursor into the turn headers (seeded from the pinned turn, then steps)
let haveSessions = false, lastHealth = null, lastHead = null;
const sessEls = new Map();    // session_id -> rail row element
const cardsById = new Map();  // session_id -> latest SessionCard

// timeline filter state — module-level, so it survives the 3s poll untouched.
let fltFlagged = false, fltTool = '', fltText = '';   // flagged-only · tool key · search text (lowercased)
let toolSel = null, searchBox = null, flaggedBtn = null, jumpBtn = null, shownCount = null;
let toolOpts = new Set();     // tool keys currently offered in the dropdown

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
  fpStory = null; storyOpen = new Set();
  fpGraph = null; graphPrompt = ''; graphTurns = []; stopGraph();   // tear the graph down on session change
  lastPrompt = null; turnN = 0;
  collapsedTurns = new Set(); turns.length = 0; turnHeadByKey.clear(); curTurnKey = null; bigSession = false; flagCursor = -1; turnCursor = -1;
  for(const [sid, d] of sessEls) d.classList.toggle('active', sid === current);
  loadView().catch(()=>{});
}

// The main pane shows either the story (default) or the flat timeline.
function loadView(){ return viewMode === 'story' ? loadStory() : viewMode === 'graph' ? loadGraph() : loadTimeline(); }
function setView(mode){
  if(viewMode === mode) return;
  viewMode = mode;
  // reset every view's render state so the switch repaints cleanly from cache
  fpTimeline = null; fpVerdict = null; rowState = []; tbody = null;
  fpStory = null; lastPrompt = null; turnN = 0;
  fpGraph = null; stopGraph();
  collapsedTurns = new Set(); turns.length = 0; turnHeadByKey.clear(); curTurnKey = null; bigSession = false; flagCursor = -1; turnCursor = -1;
  document.getElementById('timeline').textContent = '';
  loadView().catch(()=>{});
}
function viewBar(){
  const seg = el('div',{className:'viewtoggle',role:'tablist'});
  const mk = (mode, label)=> el('button',{type:'button',className:(viewMode===mode?'on':''),
    role:'tab','aria-selected':String(viewMode===mode),textContent:label,onclick:()=>setView(mode)});
  seg.append(mk('story','Story'), mk('timeline','Timeline'), mk('graph','Graph'));
  return el('div',{className:'viewbar'}, seg);
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
  const rkHot = (c.verdict === 'medium' || c.verdict === 'high');   // red only for real risk; class from a literal boolean, never the data string
  const top = el('div',{className:'top'},
    el('span',{className:'rk'+(rkHot?' hot':'')}),
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
    collapsedTurns = new Set(); turns.length = 0; turnHeadByKey.clear(); curTurnKey = null;
    bigSession = actions.length > 60;   // fold turns by default only when the log is a wall
    main.append(viewBar());
    main.append(el('section',{className:'summary',id:'verdict'}));
    buildFilterBar(main);   // filter bar, sticky over the rows
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
  refreshTools(actions);   // fold any newly-seen tools into the dropdown
  refreshTurns();          // recompute per-turn step counts / span / risk from the rows
  applyFilter();           // re-apply collapse + active filter to new/patched rows
}

// A turn boundary opens a sticky, collapsible section header (the turn outline). The
// header lives OUTSIDE rowState — exactly like the old .turn divider — so the append-only
// reconcile invariant is untouched. Its gist is the first observed action's plain-English
// summary (evidence), which is the deliberate split from Story (Story leads with the user
// prompt; the timeline never shows the prompt).
function maybeDivider(a){
  if(!a.prompt_id || a.prompt_id === lastPrompt) return;   // null never opens/closes a turn
  lastPrompt = a.prompt_id; turnN++;
  const key = a.prompt_id, folded = bigSession;            // fold state set once per full render (a live-watched session is not re-folded mid-stream)
  if(folded) collapsedTurns.add(key);
  const gist = (a.summary || a.target || '').split(String.fromCharCode(96)).join('');
  const metaEl = el('span',{className:'th-meta'});
  const riskEl = el('span',{className:'th-risk',title:'flagged'}); riskEl.style.display = 'none';
  riskEl.setAttribute('role','img'); riskEl.setAttribute('aria-label','flagged');   // risk is not conveyed by colour alone
  const hdr = el('div',{className:'turnhead'+(folded?'':' open'),role:'button',tabIndex:0},
    el('span',{className:'th-chev',textContent:'›'}),
    el('span',{className:'th-n',textContent:'turn '+turnN}),
    el('span',{className:'th-gist',textContent:gist,title:gist}),
    metaEl, riskEl);
  hdr.setAttribute('aria-expanded', String(!folded));
  hdr._key = key; hdr._metaEl = metaEl; hdr._riskEl = riskEl;
  hdr.onclick = ()=> toggleTurn(key);
  hdr.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggleTurn(key); } };
  turnHeadByKey.set(key, hdr); turns.push({key, hdr}); curTurnKey = key;
  tbody.append(hdr);
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
  tr._a = a;                    // stash for the filter pass (rowMatches / empty-divider hiding)
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
  tr._turnKey = curTurnKey;   // which turn this row belongs to (null pre-turn rows never fold)
  buildRowCells(a, tr, true);
  tr.onclick = ()=>toggle(a.seq, tr);
  tr.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(a.seq, tr); } };
  tbody.append(tr);
  rowState.push({fp: JSON.stringify(a), tr, a});
  if(expanded.has(a.seq)) insertDetail(a.seq, tr);
}

// Recompute each turn header's meta (step count · span) and risk dot from its rows. Walks
// tbody once between .turnhead boundaries with compare-before-write, so a live append writes
// only deltas and an idle poll never reaches here (the fpTimeline gate returns first).
function refreshTurns(){
  if(!tbody) return;
  let hdr = null, steps = 0, firstTs = null, lastTs = null, flagged = false;
  const flush = ()=>{ if(hdr) writeTurnMeta(hdr, steps, firstTs, lastTs, flagged); };
  for(const n of tbody.children){
    const cl = n.classList;
    if(cl.contains('turnhead')){ flush(); hdr = n; steps = 0; firstTs = null; lastTs = null; flagged = false; continue; }
    if(cl.contains('detailrow')) continue;
    if(!hdr) continue;                     // pre-turn lifecycle rows have no header
    const a = n._a; if(!a) continue;
    steps++; if(firstTs == null) firstTs = a.ts; lastTs = a.ts;
    if(a.signals.some(s=>ALERT.has(s))) flagged = true;   // dot = a genuinely flagged action (matches the Brief count), not a mere failed call
  }
  flush();
}
function writeTurnMeta(hdr, steps, firstTs, lastTs, flagged){
  let text = steps + ' step' + (steps === 1 ? '' : 's');
  const span = fmtSpan(firstTs, lastTs);
  if(span) text += ' · ' + span;
  if(hdr._metaEl.textContent !== text) hdr._metaEl.textContent = text;
  setDisp(hdr._riskEl, flagged);         // single marker; setDisp is compare-before-write
}

/* ── filters ─────────────────────────────────────────────────────── */
// A presentation layer over the poll-safe rows: rowMatches() decides per action,
// applyFilter() toggles display only (never rebuilds), so the 3s reconcile and the
// selection/expansion state are untouched. Filter state lives at module scope, so it
// persists across every poll; an idle poll never calls renderTimeline → zero churn.
function toolKey(a){
  const t = a.tool || a.hook_event || '';
  return t.slice(0,5) === 'mcp__' ? 'mcp' : (t || '—');   // collapse mcp__server__tool → mcp
}
function isFlagged(a){ return isFail(a) || a.signals.some(s=>ALERT.has(s)); }
function rowMatches(a){
  if(!a) return true;
  if(fltFlagged && !isFlagged(a)) return false;
  if(fltTool && toolKey(a) !== fltTool) return false;
  if(fltText && ((a.summary||'')+' '+(a.target||'')).toLowerCase().indexOf(fltText) < 0) return false;
  return true;
}
function setDisp(n, vis){ const d = vis ? '' : 'none'; if(n.style.display !== d) n.style.display = d; }

// One display-only walk of tbody. Two independent gates decide a row's visibility:
//   match   = rowMatches(a)                     (the active flagged/tool/search filter)
//   folded  = collapsedTurns.has(row._turnKey)  (the turn outline, overridden while filtering)
// A turn header's visibility tracks whether ANY of its rows MATCH (collapse-independent),
// which is the fix for the old divider bug: a collapsed turn's header must still show. An
// active filter always wins over collapse so search hits are never hidden inside a fold.
function applyFilter(){
  if(!tbody) return;
  const filterActive = !!(fltFlagged || fltTool || fltText);
  let shown = 0, total = 0, flaggedMatch = 0;
  let hdr = null, hdrKey = null, hdrMatch = false;
  const flushHdr = ()=>{ if(hdr){ setDisp(hdr, filterActive ? hdrMatch : true);
    const open = filterActive || !collapsedTurns.has(hdrKey);
    hdr.classList.toggle('open', open);
    if(hdr.getAttribute('aria-expanded') !== String(open)) hdr.setAttribute('aria-expanded', String(open)); } };
  const kids = tbody.children;
  for(let i=0;i<kids.length;i++){
    const n = kids[i], cl = n.classList;
    if(cl.contains('turnhead')){ flushHdr(); hdr = n; hdrKey = n._key; hdrMatch = false; continue; }
    if(cl.contains('detailrow')) continue;   // mirrors its row, set alongside it below
    total++;
    const a = n._a, match = rowMatches(a);
    if(match){ hdrMatch = true; if(a && isFlagged(a)) flaggedMatch++; }   // count flags by match, not visibility (collapse-aware jumpNext reveals them)
    const vis = match && (filterActive || !collapsedTurns.has(n._turnKey));
    if(vis) shown++;
    setDisp(n, vis);
    const nx = n.nextSibling;
    if(nx && nx.classList && nx.classList.contains('detailrow')) setDisp(nx, vis);
  }
  flushHdr();
  // collapse is not a filter, so the count reads only while an actual filter narrows the log
  if(shownCount){ const txt = filterActive ? (shown+' of '+total+' shown') : ''; if(shownCount.textContent !== txt) shownCount.textContent = txt; }
  if(jumpBtn) jumpBtn.disabled = flaggedMatch === 0;
}

// Fold/unfold one turn (display-only → no fetch, no rebuild, no scroll jump or dossier loss).
function toggleTurn(key){
  if(collapsedTurns.has(key)) collapsedTurns.delete(key); else collapsedTurns.add(key);
  const hdr = turnHeadByKey.get(key);
  if(hdr) hdr.setAttribute('aria-expanded', String(!collapsedTurns.has(key)));
  applyFilter();
}

function syncFlagged(){
  if(!flaggedBtn) return;
  flaggedBtn.classList.toggle('on', fltFlagged);
  flaggedBtn.setAttribute('aria-pressed', String(fltFlagged));
}

// Fold newly-seen tools into the dropdown (a live session can grow new tools between
// polls) without disturbing the selection; drop a stale pick left by a session switch.
function refreshTools(actions){
  if(!toolSel) return;
  for(const a of actions){
    const k = toolKey(a);
    if(k && !toolOpts.has(k)){ toolOpts.add(k); toolSel.append(el('option',{value:k,textContent:k})); }
  }
  if(fltTool && !toolOpts.has(fltTool)) fltTool = '';
  if(toolSel.value !== fltTool) toolSel.value = fltTool;
}

function buildFilterBar(main){
  const head = el('div',{className:'tlhead'});
  const bar = el('div',{className:'filterbar',role:'search'});

  flaggedBtn = el('button',{type:'button',className:'fb-toggle',title:'show only flagged actions',
    textContent:'flagged', onclick:()=>{ fltFlagged = !fltFlagged; flagCursor = -1; turnCursor = -1; syncFlagged(); applyFilter(); }});
  bar.append(flaggedBtn);

  toolOpts = new Set(['']);
  toolSel = el('select',{className:'fb-tool',title:'filter by tool',
    onchange:()=>{ fltTool = toolSel.value; flagCursor = -1; turnCursor = -1; applyFilter(); }});
  toolSel.append(el('option',{value:'',textContent:'all tools'}));
  bar.append(toolSel);

  searchBox = el('input',{type:'search',className:'fb-search',placeholder:'search summary or target…',
    value:fltText, spellcheck:false,
    oninput:()=>{ fltText = searchBox.value.trim().toLowerCase(); flagCursor = -1; turnCursor = -1; applyFilter(); }});
  bar.append(searchBox);

  jumpBtn = el('button',{type:'button',className:'fb-jump',title:'jump to next flagged action · press n',
    textContent:'next flag ↓', onclick:jumpNext});
  bar.append(jumpBtn);

  shownCount = el('div',{className:'fb-count'});
  bar.append(shownCount);

  head.append(bar);
  main.append(head);
  syncFlagged();
  measureTurnTop();   // pin turn headers just below this filter bar
}

// The sticky turn headers pin at the bottom edge of the filter bar. Measure it into
// a CSS var so a wrapped/tall bar never overlaps the pinned header; re-measure on resize.
function measureTurnTop(){
  const head = document.querySelector('.tlhead');
  if(!head) return;
  const h = Math.round(head.getBoundingClientRect().height);
  if(h) document.documentElement.style.setProperty('--turntop', h+'px');
}

// Scroll the next flagged row below the fold into view (wraps at the end); counts
// only rows the filter leaves visible. Bound to the button and the 'n' key.
// Step to the next flagged row (wraps). A module cursor guarantees each press ADVANCES
// (scrollIntoView centres the target, so a geometry-only "first below the fold" would keep
// re-selecting it). Cold press (cursor reset by a session/view/filter change) seeds from the
// first flag below the fold to honour "next ↓"; subsequent presses increment. Collapse-aware:
// a flagged row inside a folded turn is still a candidate and its turn is expanded on landing.
function jumpNext(){
  if(!tbody) return;
  const cands = rowState.filter(s=> isFlagged(s.a) && rowMatches(s.a));   // filter-aware, collapse-independent
  if(!cands.length){ flagCursor = -1; return; }
  if(flagCursor < 0 || flagCursor >= cands.length){
    const main = document.getElementById('timeline'), head = document.querySelector('.tlhead');
    const fold = main.getBoundingClientRect().top + (head ? head.getBoundingClientRect().height : 0) + 4;
    const posOf = (s)=>{ if(s.tr.style.display !== 'none') return s.tr.getBoundingClientRect().top;
      const h = turnHeadByKey.get(s.tr._turnKey); return h ? h.getBoundingClientRect().top : Infinity; };   // folded row → its header's position
    const seed = cands.findIndex(s => posOf(s) > fold);
    flagCursor = seed < 0 ? 0 : seed;
  } else {
    flagCursor = (flagCursor + 1) % cands.length;   // advance; wrap past the last
  }
  const target = cands[flagCursor];
  if(target.tr._turnKey != null && collapsedTurns.has(target.tr._turnKey)){
    collapsedTurns.delete(target.tr._turnKey);
    const h = turnHeadByKey.get(target.tr._turnKey); if(h) h.setAttribute('aria-expanded','true');
    applyFilter();   // reveal the row's turn before scrolling to it
  }
  target.tr.scrollIntoView({block:'center', behavior:'smooth'});
  flashRow(target.tr);
}
function flashRow(tr){ tr.classList.remove('flash'); void tr.offsetWidth; tr.classList.add('flash'); }

// 'n' jumps to the next flagged row — unless focus sits in the filter's own inputs.
document.addEventListener('keydown', (e)=>{
  if(e.key !== 'n' || e.metaKey || e.ctrlKey || e.altKey) return;
  const tn = document.activeElement && document.activeElement.tagName;
  if(tn === 'INPUT' || tn === 'SELECT' || tn === 'TEXTAREA') return;
  e.preventDefault(); jumpNext();
});

// '[' / ']' step through the turn outline (prev / next section). Timeline-only, same input guard.
document.addEventListener('keydown', (e)=>{
  if((e.key !== '[' && e.key !== ']') || e.metaKey || e.ctrlKey || e.altKey) return;
  if(viewMode !== 'timeline' || !turns.length) return;
  const tn = document.activeElement && document.activeElement.tagName;
  if(tn === 'INPUT' || tn === 'SELECT' || tn === 'TEXTAREA') return;
  e.preventDefault(); gotoTurn(e.key === ']' ? 1 : -1);
});
// Scroll the previous/next turn header to the pin line. Reads layout, writes no DOM → poll-safe.
function gotoTurn(dir){
  const main = document.getElementById('timeline');
  if(!main) return;
  const vis = turns.filter(t=> t.hdr.style.display !== 'none');   // skip filtered-out headers
  if(!vis.length){ turnCursor = -1; return; }
  const top = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--turntop')) || 38;
  if(turnCursor < 0 || turnCursor >= vis.length){
    // cold press: seed from the turn currently pinned at the fold so the first press moves from the view;
    // then step via the cursor (immune to smooth-scroll timing, unlike re-deriving position each press)
    const fold = main.getBoundingClientRect().top + top + 6;
    let idx = -1; for(let i=0;i<vis.length;i++){ if(vis[i].hdr.getBoundingClientRect().top <= fold) idx = i; else break; }
    turnCursor = idx;
  }
  turnCursor = Math.max(0, Math.min(vis.length-1, turnCursor + dir));
  // scroll by layout offset, NOT scrollIntoView (which mishandles a stacked sticky header scrolling up)
  main.scrollTo({ top: Math.max(0, vis[turnCursor].hdr.offsetTop - top - 4), behavior:'smooth' });
}
window.addEventListener('resize', ()=>{ cancelAnimationFrame(_rz); _rz = requestAnimationFrame(measureTurnTop); });

/* ── summary ─────────────────────────────────────────────────────── */
function updateVerdict(actions){
  const v = document.getElementById('verdict');
  if(!v) return;
  const card = cardsById.get(current) || null;
  const flagN = actions.reduce((n,a)=>n+a.signals.filter(s=>ALERT.has(s)).length,0);
  const turnsN = new Set(actions.map(a=>a.prompt_id).filter(Boolean)).size;   // the total the turn outline indexes into
  const fp = JSON.stringify([current, actions.length, turnsN, flagN, card]);
  if(fp === fpVerdict) return;
  fpVerdict = fp;
  v.textContent = '';
  if(card && card.name) v.append(el('div',{className:'sname',textContent:card.name}));
  v.append(el('div',{className:'sid'}, el('samp',{textContent:current})));

  const line = el('div',{className:'sline'});
  line.append(el('span',{className:'n',textContent:String(actions.length)}), ' actions');
  if(turnsN){ line.append(el('span',{className:'sep',textContent:'·'}),
    el('span',{className:'n',textContent:String(turnsN)}), ' turns'); }
  if(flagN){ line.append(el('span',{className:'sep',textContent:'·'}),
    el('span',{className:'flag jump',role:'button',tabIndex:0,title:'jump to the next flagged action',
      textContent:flagN+' flagged',onclick:jumpNext,
      onkeydown:(e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); jumpNext(); }}})); }
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

  // Changes: the actual before/after evidence, reconstructed from the stored patch
  // (or the full body for a write). Missing/pruned/skipped content states are explicit.
  const mut = d.mutation;
  if(mut){
    box.append(secLabel(mut.kind === 'body' ? 'file contents' : 'changes'));
    const ds = mut.diffstat;
    if(ds){
      box.append(el('div',{className:'diffstat'},
        el('span',{className:'ins',textContent:'+'+(ds.insertions||0)}), ' ',
        el('span',{className:'del',textContent:'-'+(ds.deletions||0)}),
        ' \\u00B7 '+(ds.files||1)+' file'+(((ds.files||1)===1)?'':'s')+(mut.redacted?' \\u00B7 secrets redacted':'')));
    }
    if(mut.status === 'available' && mut.content != null){
      const pre = el('pre',{className:'diff'});
      const lines = String(mut.content).split(String.fromCharCode(10));
      const cap = 400;
      lines.slice(0, cap).forEach(function(ln){
        const c = ln.charAt(0);
        const cls = (mut.kind === 'body') ? 'add' : (c === '+' ? 'add' : (c === '-' ? 'rem' : 'ctx'));
        pre.append(el('span',{className:cls,textContent:(ln.length?ln:' ')}));
      });
      box.append(pre);
      if(lines.length > cap) box.append(el('div',{className:'mnote',textContent:'\\u2026 '+(lines.length-cap)+' more line(s) not shown'}));
    } else if(mut.status === 'pruned'){
      box.append(el('div',{className:'mnote',textContent:
        'Content aged out'+(mut.pruned_at?(' on '+String(mut.pruned_at).slice(0,10)):'')+'. The record is retained: '+
        mut.bytes+' bytes, sha-256 committed in the chain.'}));
    } else if(mut.status === 'skipped'){
      box.append(el('div',{className:'mnote',textContent:
        'Content not stored ('+(mut.skip_reason||'skipped')+'). The commitment (size + sha-256) is recorded \\u00B7 '+mut.bytes+' bytes.'}));
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

/* ── story view — the re-traceable narrative ─────────────────────── */
// A calm, causal read of a session: each user turn as a card — the prompt (intent),
// an outcome band, the files it changed, its commits, and a collapsible step list.
// Every file / commit / step expands the SAME dossier the timeline uses (via toggle),
// so the diff + chain hashes are one click away. Full-rebuild on data change (fp-gated
// so idle polls cost nothing); per-turn expansion persists across rebuilds.
function shortPath(p){ const parts=(p||'').split('/').filter(Boolean); return parts.length<=2 ? (p||'') : parts.slice(-2).join('/'); }
function stripTicks(s){ return (s||'').split(String.fromCharCode(96)).join(''); }
function fmtTokens(n){ return n>=1000 ? (n/1000).toFixed(1)+'k' : String(n); }
// A labelled block of outcome rows (changed files / commits) — one shared shell.
function group(label, rows){ const g = el('div',{className:'fgroup'});
  if(label) g.append(el('div',{className:'glabel',textContent:label}));
  rows.forEach(r=> g.append(r)); return g; }

async function loadStory(){
  const main = document.getElementById('timeline');
  if(!current){
    const key = haveSessions ? 'sel' : 'armed';
    if(fpStory !== 'e:'+key){ fpStory = 'e:'+key; main.textContent=''; main.append(viewBar(), emptyState(key)); }
    return;
  }
  const sid = current;
  const story = await api('/api/session/'+encodeURIComponent(sid)+'/story');
  if(current !== sid) return;   // selection changed mid-fetch
  const fp = JSON.stringify([sid, story]);
  if(fp === fpStory) return;    // idle poll → zero DOM work
  renderStory(main, story);
  fpStory = fp;                 // commit only after a successful render
}

function renderStory(main, story){
  main.textContent='';
  main.append(viewBar());

  const sum = el('section',{className:'summary'});
  if(story.name) sum.append(el('div',{className:'sname',textContent:story.name}));
  sum.append(el('div',{className:'sid'}, el('samp',{textContent:story.session_id})));
  const c = story.counts || {turns:0,steps:0,files:0,commits:0};
  const line = el('div',{className:'sline'});
  line.append(el('span',{className:'n',textContent:String(c.turns)}), ' turns');
  line.append(el('span',{className:'sep',textContent:'·'}), el('span',{className:'n',textContent:String(c.steps)}), ' steps');
  if(c.files) line.append(el('span',{className:'sep',textContent:'·'}), el('span',{className:'n',textContent:String(c.files)}), ' files changed');
  if(c.commits) line.append(el('span',{className:'sep',textContent:'·'}), el('span',{className:'n',textContent:String(c.commits)}), ' commits');
  if(RISKWORD[story.verdict]){ const hot = story.verdict==='medium'||story.verdict==='high';
    line.append(el('span',{className:'sep',textContent:'·'}), el('span',{className:'risk'+(hot?' hot':''),textContent:RISKWORD[story.verdict]})); }
  sum.append(line);
  if(story.files_changed && story.files_changed.length) sum.append(group('files changed', story.files_changed.map(fileRow)));
  main.append(sum);

  if(story.reconciliation) main.append(coverageStrip(story.reconciliation));

  const turns = story.turns || [];
  if(!turns.length){ main.append(el('div',{className:'empty'}, el('p',{textContent:'No actions recorded in this session yet.'}))); return; }
  const wrap = el('div',{className:'turns'});
  turns.forEach((t,i)=> wrap.append(turnCard(t, i)));
  main.append(wrap);
}

// R2: the git-corroboration strip — did what happened on disk match the hook stream?
const COVLABEL = { ghost_mutation:'ghost', phantom_mutation:'phantom', content_mismatch:'mismatch' };
function coverageStrip(r){
  const box = el('div',{className:'covstrip'});
  const cov = r.coverage || {};
  if(!r.corroborated){
    box.classList.add('cov-none');
    box.append(el('span',{className:'covlabel',textContent:'uncorroborated'}),
      ' — '+(cov.reason||'no git anchor')+'. blackbox corroborates file mutations against git ground truth; this session has no baseline.');
    return box;
  }
  if(!r.finding_count){
    box.classList.add('cov-ok');
    box.append(el('span',{className:'covlabel',textContent:'✓ git-corroborated'}),
      ' — every on-disk change matches the hook stream ('+(cov.files_on_disk||0)+' file'+((cov.files_on_disk||0)===1?'':'s')+').');
    return box;
  }
  box.classList.add('cov-warn');
  box.append(el('div',{className:'covhead'}, el('span',{className:'covlabel',textContent:'⚠ '+r.finding_count+' discrepanc'+(r.finding_count===1?'y':'ies')+' vs git ground truth'})));
  const list = el('div',{className:'covlist'});
  (r.findings||[]).slice(0,25).forEach(f=>{
    list.append(el('div',{className:'covrow'},
      el('span',{className:'covtype',textContent:COVLABEL[f.type]||f.type}),
      el('span',{className:'covpath',textContent:shortPath(f.path)}),
      el('span',{className:'covnote',textContent:f.note})));
  });
  box.append(list);
  return box;
}

function turnCard(t, i){
  const key = t.prompt_id || ('#'+i);
  const steps = t.steps || [];
  const card = el('div',{className:'turncard'});

  // header: turn number (left) · a compact meta line (right) — one row, not a pill band
  const meta = el('span',{className:'tmeta'});
  meta.append(steps.length+' step'+(steps.length===1?'':'s'));
  const span = fmtSpan(t.started_at, t.ended_at);
  if(span) meta.append(el('span',{className:'sep',textContent:'·'}), span);
  if(t.flagged) meta.append(el('span',{className:'sep',textContent:'·'}), el('span',{className:'tflag',textContent:t.flagged+' flagged'}));
  // R1: model + token cost for the turn, when the transcript reasoning was captured
  if(t.turn_meta){
    if(t.turn_meta.model) meta.append(el('span',{className:'sep',textContent:'·'}), t.turn_meta.model);
    const u = t.turn_meta.usage || {};
    const tok = (u.output_tokens||0) + (u.input_tokens||0);
    if(tok) meta.append(el('span',{className:'sep',textContent:'·'}), fmtTokens(tok)+' tok');
  }
  card.append(el('div',{className:'thd'}, el('span',{className:'tnum',textContent:'turn '+(i+1)}), meta));

  // the intent (or an honest, quiet note when it predates prompt capture)
  const hasPrompt = !!t.prompt;
  const text = hasPrompt ? t.prompt : (t.prompt_id ? 'no prompt recorded' : 'session activity');
  card.append(el('div',{className:'tprompt'+(hasPrompt?'':' muted'),textContent:text}));

  // R1: the agent's reasoning (the "why"), collapsible, redacted
  if(t.reasoning){
    const rk = key+':why';
    const rbody = el('div',{className:'treason'});
    const rtog = el('div',{className:'tsteps-toggle',tabIndex:0});
    const rpaint = (o)=>{ rtog.textContent = o ? '▾ hide reasoning' : '▸ why — agent reasoning'; };
    const rfill = ()=>{ rbody.textContent=''; rbody.append(redactedPre(t.reasoning)); };
    if(storyOpen.has(rk)) rfill();
    rpaint(storyOpen.has(rk));
    const rflip = ()=>{ if(storyOpen.has(rk)){ storyOpen.delete(rk); rbody.textContent=''; rpaint(false); } else { storyOpen.add(rk); rfill(); rpaint(true); } };
    rtog.onclick = rflip;
    rtog.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); rflip(); } };
    card.append(rtog, rbody);
  }

  // outcomes, each in a labelled group
  if(t.files_changed && t.files_changed.length) card.append(group('changed', t.files_changed.map(fileRow)));
  if((t.commits||[]).length) card.append(group('commits', t.commits.map(commitRow)));

  if(steps.length){
    const open = storyOpen.has(key);
    const body = el('div',{className:'tsteps'});
    const tog = el('div',{className:'tsteps-toggle',tabIndex:0});
    const paint = (isOpen)=>{ tog.textContent = isOpen ? '▾ hide steps' : ('▸ show '+steps.length+' step'+(steps.length===1?'':'s')); };
    const fill = ()=>{ body.textContent=''; steps.forEach(s=> body.append(stepRow(s))); };
    if(open) fill();
    paint(open);
    const flip = ()=>{ if(storyOpen.has(key)){ storyOpen.delete(key); body.textContent=''; paint(false); }
      else { storyOpen.add(key); fill(); paint(true); } };
    tog.onclick = flip;
    tog.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); flip(); } };
    card.append(tog, body);
  }
  return card;
}

function fileRow(f){
  const seq = f.seq;
  const row = el('div',{className:'frow',tabIndex:0,title:f.path});
  row.append(el('span',{className:'fname',textContent:shortPath(f.path)}));
  row.append(el('span',{className:'fstat'},
    el('span',{className:'ins',textContent:'+'+(f.insertions||0)}),
    el('span',{className:'del',textContent:'−'+(f.deletions||0)})));
  if(f.status==='skipped') row.append(el('span',{className:'fskip',textContent:f.skip_reason||'not stored'}));
  row.onclick = ()=> toggle(seq, row);
  row.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(seq,row); } };
  return row;
}

function commitRow(cm){
  const seq = cm.seq;
  const row = el('div',{className:'crow',tabIndex:0,title:cm.ref||''});
  row.append(el('span',{className:'csha',textContent:cm.sha ? String(cm.sha).slice(0,7) : (cm.kind||'ref')}));
  row.append(el('span',{className:'csub',textContent:cm.subject || (cm.kind ? cm.kind+' '+(cm.ref||'') : 'commit')}));
  if(cm.insertions || cm.deletions) row.append(el('span',{className:'cstat',textContent:'+'+(cm.insertions||0)+' −'+(cm.deletions||0)}));
  row.onclick = ()=> toggle(seq, row);
  row.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(seq,row); } };
  return row;
}

function stepRow(s){
  const seq = s.post_seq || s.seq;
  const fail = s.success === 0;
  const flagged = (s.signals||[]).some(x=>ALERT.has(x));
  const row = el('div',{className:'srow'+(fail?' fail':flagged?' flag':''),tabIndex:0});
  row.append(el('span',{className:'stime',textContent:hhmmss(s.ts)}));
  row.append(el('span',{className:'stool',textContent:(s.tool||s.type||'')}));
  row.append(el('span',{className:'ssum',textContent:stripTicks(s.summary||s.target||'')}));
  if(s.is_subagent) row.append(el('span',{className:'sub',textContent:s.agent_type||'subagent'}));
  (s.signals||[]).forEach(x=> row.append(tag(x)));
  row.onclick = ()=> toggle(seq, row);
  row.onkeydown = (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); toggle(seq,row); } };
  return row;
}

/* ── graph view (R4) — a hand-rolled force-directed canvas, zero deps ─ */
// A read-only projection of the session (prompt · step · file · commit · risk nodes;
// caused/changed/committed/spawned/read/sent/combo edges). The exfil combo is a red
// path. Pan/zoom, hover-highlight a node's neighbourhood, click a node → its dossier.
function stopGraph(){ if(graphState){ if(graphState.raf) cancelAnimationFrame(graphState.raf); if(graphState.cleanup) graphState.cleanup(); graphState=null; } }

async function loadGraph(){
  const main = document.getElementById('timeline');
  if(!current){
    const key = haveSessions ? 'sel' : 'armed';
    if(fpGraph !== 'e:'+key){ fpGraph='e:'+key; stopGraph(); main.textContent=''; main.append(viewBar(), emptyState(key)); }
    return;
  }
  const sid = current;
  const q = graphPrompt ? ('?prompt='+encodeURIComponent(graphPrompt)) : '';
  const g = await api('/api/session/'+encodeURIComponent(sid)+'/graph'+q);
  if(current !== sid || viewMode !== 'graph') return;
  const fp = JSON.stringify([sid, graphPrompt, g.counts]);
  if(fp === fpGraph) return;   // stable graph → let the running sim keep going
  renderGraph(main, g);
  fpGraph = fp;
}

function graphLegend(){
  const box = el('div',{className:'glegend'});
  const items = [['prompt','prompt'],['step','step'],['file','file'],['commit','commit'],['secret','risk']];
  for(const [type,label] of items){ box.append(el('span',{className:'gleg'},
    el('span',{className:'gdot',style:'background:'+(NODE_COLOR[type]||'#8a919c')}), label)); }
  return box;
}
function graphControls(g){
  const bar = el('div',{className:'graphctl'});
  const sel = el('select',{className:'fb-tool',title:'focus one turn',
    onchange:()=>{ graphPrompt = sel.value; fpGraph = null; loadGraph().catch(()=>{}); }});
  sel.append(el('option',{value:'',textContent:'whole session'}));
  for(const t of graphTurns) sel.append(el('option',{value:t.id,textContent:(t.label||t.id).slice(0,44)}));
  sel.value = graphPrompt;
  bar.append(sel, el('span',{className:'gcount',textContent:g.counts.nodes+' nodes · '+g.counts.edges+' links'}), graphLegend());
  return bar;
}

function renderGraph(main, g){
  stopGraph();
  main.textContent='';
  main.append(viewBar());
  if(!g.detailed) graphTurns = g.nodes.filter(n=>n.type==='prompt').map((n)=>({ id:String(n.id||'').slice(2), label:n.label }));
  main.append(graphControls(g));
  if((g.counts.nodes||0) <= 1){
    main.append(el('div',{className:'empty'}, el('p',{textContent:'Not enough recorded relationships to graph — try the Story view, or pick a busier turn.'})));
    return;
  }

  const hostEl = el('div',{className:'graphhost'});
  const canvas = el('canvas',{className:'graphcanvas'});
  hostEl.append(canvas);
  const panel = el('div',{className:'gpanel'});
  main.append(hostEl, panel);
  const ctx = canvas.getContext('2d');

  const nodes = g.nodes.map(n=>Object.assign({}, n));
  const byId = {}; nodes.forEach(n=> byId[n.id]=n);
  const edges = (g.edges||[]).filter(e=> byId[e.from] && byId[e.to]);
  const N = nodes.length;
  nodes.forEach((n,i)=>{ const a=i/N*6.2832; n.x=Math.cos(a)*200+(Math.random()-0.5)*50; n.y=Math.sin(a)*200+(Math.random()-0.5)*50; n.vx=0; n.vy=0; });
  const adj = {}; nodes.forEach(n=> adj[n.id]=Object.create(null));
  edges.forEach(e=>{ adj[e.from][e.to]=1; adj[e.to][e.from]=1; });

  let view = { x:0, y:0, z:1 };
  let hover = null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const radius = (n)=> 4 + Math.min(9,(n.degree||0)*1.4) + (n.type==='prompt'?2:0);

  function step(){
    const REP = 1100, SPRING = 0.02, LEN = 72, GRAV = 0.004, DAMP = 0.86, CAP = 22;
    for(let i=0;i<N;i++){ const a=nodes[i]; for(let j=i+1;j<N;j++){ const b=nodes[j];
      let dx=a.x-b.x, dy=a.y-b.y; let d2=dx*dx+dy*dy+0.01; const d=Math.sqrt(d2); const f=REP/d2/d;
      const fx=dx*f, fy=dy*f; a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy; } }
    for(const e of edges){ const a=byId[e.from], b=byId[e.to]; let dx=b.x-a.x, dy=b.y-a.y;
      const d=Math.sqrt(dx*dx+dy*dy)+0.01; const f=(d-LEN)*SPRING/d; const fx=dx*f, fy=dy*f;
      a.vx+=fx;a.vy+=fy;b.vx-=fx;b.vy-=fy; }
    for(const n of nodes){ n.vx-=n.x*GRAV; n.vy-=n.y*GRAV; n.vx*=DAMP; n.vy*=DAMP;
      n.x+=Math.max(-CAP,Math.min(CAP,n.vx)); n.y+=Math.max(-CAP,Math.min(CAP,n.vy)); }
  }
  function draw(){
    const w=canvas.width, h=canvas.height;
    ctx.setTransform(1,0,0,1,0,0); ctx.clearRect(0,0,w,h);
    ctx.translate(w/2+view.x, h/2+view.y); ctx.scale(view.z, view.z);
    for(const e of edges){ const a=byId[e.from], b=byId[e.to]; const hl = hover && (e.from===hover||e.to===hover);
      ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y);
      ctx.strokeStyle = e.risk ? ('rgba(229,89,90,'+(hl?0.95:0.6)+')') : (hl?'rgba(255,255,255,0.4)':'rgba(255,255,255,0.11)');
      ctx.lineWidth = e.risk?1.7:1; if(e.type==='combo') ctx.setLineDash([5,3]);
      ctx.stroke(); ctx.setLineDash([]); }
    for(const n of nodes){ const r=radius(n); const dim = hover && n.id!==hover && !adj[hover][n.id];
      ctx.globalAlpha = dim?0.22:1;
      ctx.beginPath(); ctx.arc(n.x,n.y,r,0,6.2832);
      ctx.fillStyle = n.risk ? '#e5595a' : (NODE_COLOR[n.type]||'#8a919c'); ctx.fill();
      if(n.id===hover){ ctx.lineWidth=2; ctx.strokeStyle='#f2f4f7'; ctx.stroke(); }
      if(n.type!=='step' || n.id===hover){ ctx.globalAlpha = dim?0.28:0.85;
        ctx.fillStyle = n.risk?'#e5595a':'#c6c6cd'; ctx.font='10px ui-sans-serif,system-ui,sans-serif';
        ctx.fillText(String(n.label||'').slice(0,26), n.x+r+3, n.y+3); } }
    ctx.globalAlpha=1;
  }
  function resize(){ const rect=hostEl.getBoundingClientRect(); canvas.width=Math.max(320,rect.width); canvas.height=560; draw(); }

  function toWorld(sx,sy){ return { x:(sx-canvas.width/2-view.x)/view.z, y:(sy-canvas.height/2-view.y)/view.z }; }
  function nodeAt(sx,sy){ const p=toWorld(sx,sy); let best=null, bd=1e9;
    for(const n of nodes){ const dx=n.x-p.x, dy=n.y-p.y; const d=dx*dx+dy*dy; const r=radius(n)+4; if(d<r*r && d<bd){ bd=d; best=n; } }
    return best; }
  function localXY(e){ const rect=canvas.getBoundingClientRect(); return [e.clientX-rect.left, e.clientY-rect.top]; }

  let drag=null;
  canvas.onmousedown = (e)=>{ const [sx,sy]=localXY(e); drag={ sx, sy, px:view.x, py:view.y, moved:false }; };
  canvas.onmousemove = (e)=>{ const [sx,sy]=localXY(e);
    if(drag){ const dx=sx-drag.sx, dy=sy-drag.sy; if(Math.abs(dx)+Math.abs(dy)>3) drag.moved=true; view.x=drag.px+dx; view.y=drag.py+dy; if(!graphState.raf) draw(); return; }
    const n=nodeAt(sx,sy); const id=n?n.id:null; if(id!==hover){ hover=id; canvas.style.cursor = n?'pointer':'grab'; if(!graphState.raf) draw(); } };
  const endDrag = (e)=>{ if(drag && !drag.moved){ const [sx,sy]=localXY(e); const n=nodeAt(sx,sy); if(n && n.seq!=null) openGraphDossier(n.seq, panel); } drag=null; };
  canvas.onmouseup = endDrag;
  canvas.onmouseleave = ()=>{ drag=null; if(hover){ hover=null; if(!graphState.raf) draw(); } };
  canvas.onwheel = (e)=>{ e.preventDefault(); const [sx,sy]=localXY(e); const before=toWorld(sx,sy);
    view.z = Math.max(0.25, Math.min(3, view.z * (e.deltaY<0?1.1:0.9)));
    const after=toWorld(sx,sy); view.x += (after.x-before.x)*view.z; view.y += (after.y-before.y)*view.z; if(!graphState.raf) draw(); };

  const onResize = ()=> resize();
  window.addEventListener('resize', onResize);
  graphState = { raf:null, frames:0, cleanup:()=> window.removeEventListener('resize', onResize) };
  resize();
  function tickSim(){ if(!graphState) return; step(); step(); draw(); graphState.frames++;
    graphState.raf = graphState.frames < 240 ? requestAnimationFrame(tickSim) : null; }
  if(reduced){ const iters=Math.min(260,Math.max(60,Math.round(40000/N))); for(let k=0;k<iters;k++) step(); draw(); } else tickSim();
}

// Open one node's dossier below the canvas (reuses the timeline's insertDetail).
function openGraphDossier(seq, panel){
  panel.textContent='';
  const anchor = el('div',{className:'ganchor'});
  panel.append(anchor);
  expanded.add(seq);
  insertDetail(seq, anchor);
  panel.scrollIntoView({ block:'nearest', behavior:'smooth' });
}

/* ── poll loop ───────────────────────────────────────────────────── */
async function render(){
  let linkOk = true;
  try { updateHud(await api('/health')); } catch { linkOk = false; }
  try { await loadSessions(); } catch {}
  try { await loadView(); } catch {}
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
