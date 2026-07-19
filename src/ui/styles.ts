export const UI_CSS = `
:root {
  color-scheme: dark;
  --bg: #070708;
  --bg-raised: #0e0e11;
  --surface: #0c0c0f;
  --surface-2: #101014;
  --surface-3: #1a1a1f;
  --line: #1f1f24;
  --line-2: #17171b;
  --line-3: #232328;
  --line-strong: #2c2c32;
  --text: #f2f2f0;
  --text-2: #c8c8cc;
  --muted: #8b8b93;
  --quiet: #5c5c64;
  --ghost: #3f3f45;
  --danger: #e5484d;
  --danger-text: #e89c9c;
  --danger-mid: #e07377;
  --danger-mark: #b3585c;
  --danger-soft: rgba(229, 72, 77, .1);
  --danger-line: rgba(229, 72, 77, .4);
  --live: #59b783;
  --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  --sans: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --sidebar: 276px;
  --ease: cubic-bezier(.2,.75,.25,1);
  --z-popover: 50;
  --z-drawer: 60;
}
* { box-sizing: border-box; }
html { min-height: 100%; scroll-behavior: smooth; background: var(--bg); }
body { min-width: 320px; min-height: 100dvh; margin: 0; overflow-x: hidden; background: var(--bg); color: var(--text); font: 13px/1.5 var(--sans); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
button, input, select { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button { color: inherit; }
a { color: inherit; text-decoration: none; }
::selection { background: rgba(255,255,255,.2); }
:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb { background: var(--line-3); border-radius: 6px; border: 2px solid var(--bg); }
@keyframes bbFade { from { opacity: 0; } }
@keyframes bbUp { from { transform: translateY(8px); opacity: 0; } }
@keyframes bbDrawer { from { transform: translateX(40px); opacity: 0; } }
@keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
.skip-link { position: fixed; top: 8px; left: 8px; z-index: 100; transform: translateY(-150%); background: var(--text); color: #111; padding: 9px 12px; border-radius: 8px; }
.skip-link:focus { transform: none; }

/* ── shared microtype ─────────────────────────────────────────────────────── */
.mlabel { color: var(--muted); font: 600 9.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.mlabel .num { color: var(--quiet); }
.seg { display: flex; gap: 2px; padding: 3px; border: 1px solid var(--line-3); border-radius: 8px; background: var(--bg-raised); }
.seg button { min-height: 30px; padding: 0 13px; border: 0; border-radius: 6px; background: transparent; color: var(--muted); font: 600 11.5px var(--sans); cursor: pointer; transition: color .15s, background .15s; }
.seg button:hover { color: var(--text); }
.seg button.active { background: #1f1f26; color: var(--text); }
.seg button.icon { min-width: 32px; padding: 0; font: 600 14px var(--mono); }
.icon-button, .secondary-button, .quiet-button, .danger-button { min-height: 38px; border: 1px solid var(--line-strong); border-radius: 8px; background: #141418; color: var(--text); cursor: pointer; font: 600 12px var(--sans); transition: background .15s var(--ease), border-color .15s var(--ease), color .15s var(--ease), transform .15s var(--ease); }
.icon-button { width: 38px; padding: 0; font-size: 15px; color: var(--text-2); }
.secondary-button, .quiet-button, .danger-button { padding: 0 15px; }
.quiet-button { border-color: transparent; background: transparent; color: var(--muted); }
.danger-button { border-color: var(--danger-line); background: var(--danger-soft); color: var(--danger-text); }
.icon-button:hover, .secondary-button:hover { border-color: #3d3d44; }
.quiet-button:hover { color: var(--text); }
.danger-button:hover { background: rgba(229,72,77,.16); }
.icon-button:active, .secondary-button:active, .quiet-button:active, .danger-button:active { transform: scale(.98); }
.text-field { width: 100%; min-height: 38px; padding: 0 12px; border: 1px solid var(--line-3); border-radius: 8px; background: var(--bg-raised); color: var(--text); font-size: 12px; }
.text-field::placeholder { color: var(--quiet); }
.text-field:focus { border-color: var(--line-strong); outline: none; }
.select-field { min-height: 38px; padding: 0 30px 0 12px; border: 1px solid var(--line-3); border-radius: 8px; background: var(--bg-raised); color: var(--text-2); }
.empty-state { max-width: 440px; margin: 60px auto 0; padding: 40px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); text-align: center; }
.empty-symbol { margin: 0 auto; color: var(--quiet); font-size: 22px; }
.empty-state h2 { margin: 12px 0 0; font-size: 18px; font-weight: 650; }
.empty-state p { max-width: 340px; margin: 6px auto 0; color: var(--muted); font-size: 12.5px; }
.skeleton-card { height: 180px; border-radius: 12px; border: 1px solid var(--line); background: var(--surface); overflow: hidden; }
.skeleton-card::after { content: ""; display: block; width: 50%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.03), transparent); animation: shimmer 1.3s infinite; }

/* ── app shell: fixed sidebar + scrolling main ────────────────────────────── */
.sidebar { position: fixed; inset: 0 auto 0 0; z-index: 40; width: var(--sidebar); display: flex; flex-direction: column; border-right: 1px solid #1d1d21; background: #0a0a0c; }
.sb-brand { display: flex; align-items: center; gap: 10px; padding: 20px 18px 16px; border-bottom: 1px solid #1a1a1e; }
.sb-logo { width: 22px; height: 22px; flex: none; display: grid; place-items: center; background: var(--text); border-radius: 5px; }
.sb-logo::after { content: ""; width: 8px; height: 8px; background: var(--bg); border-radius: 2px; }
.sb-word { font-weight: 800; font-size: 14px; letter-spacing: .22em; }
.sb-search { padding: 14px 14px 10px; }
.sb-nav { padding: 0 14px; }
.sb-dash { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 38px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--muted); font: 600 12.5px var(--sans); cursor: pointer; text-align: left; }
.sb-dash:hover { color: var(--text); }
.sb-dash.active { background: var(--surface-3); color: var(--text); }
.sb-glyph { font: 11px var(--mono); }
.sb-scroll { flex: 1; overflow-y: auto; padding: 16px 14px 10px; display: flex; flex-direction: column; gap: 18px; }
.sb-group-head { display: flex; align-items: baseline; justify-content: space-between; padding: 0 10px 8px; }
.sb-count { font: 600 10px var(--mono); color: var(--danger); }
.sb-list { display: flex; flex-direction: column; gap: 2px; }
.sb-item { display: grid; grid-template-columns: 3px minmax(0,1fr) auto; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 6px 10px 6px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text); cursor: pointer; text-align: left; }
.sb-item:hover { background: var(--line-2); }
.sb-item.active { background: var(--surface-3); }
.sb-bar { width: 3px; height: 22px; border-radius: 2px; background: var(--danger); opacity: .85; }
.sb-item-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12.5px var(--sans); }
.sb-item-sub { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 1px; font: 10px var(--mono); color: var(--quiet); }
.sb-flag { font: 10px var(--mono); color: var(--danger-mark); white-space: nowrap; }
.sb-recent { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 5px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text-2); cursor: pointer; text-align: left; font: 12px var(--sans); }
.sb-recent:hover { background: var(--line-2); color: var(--text); }
.sb-recent.active { background: var(--surface-3); color: var(--text); }
.sb-recent-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-rel { font: 9.5px var(--mono); color: var(--quiet); }
.sb-status { display: flex; align-items: center; gap: 7px; padding: 13px 18px; border-top: 1px solid #1a1a1e; color: var(--quiet); font: 10px var(--mono); }
.sb-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--quiet); }
.sb-dot.live { background: var(--live); }
.sb-dot.offline { background: var(--danger); }
main { min-height: 100dvh; margin-left: var(--sidebar); }
.connection-alert { position: sticky; top: 0; z-index: 20; padding: 9px 24px; border-bottom: 1px solid var(--danger-line); background: #1a1010; color: var(--danger-text); text-align: center; font-size: 12px; }
.app-shell { max-width: 1180px; margin: 0 auto; padding: 46px 44px 90px; }

/* ── dashboard ────────────────────────────────────────────────────────────── */
.dash-hero h1 { margin: 0; font-size: clamp(34px, 4vw, 46px); font-weight: 700; letter-spacing: -.035em; line-height: 1.02; }
.dash-hero h1 span { color: var(--muted); }
.dash-title-row { display: flex; align-items: end; gap: 14px; }
.edit-name-button { min-height: 30px; margin-bottom: 6px; padding: 0 2px; border: 0; background: transparent; color: var(--quiet); cursor: pointer; font-size: 11px; text-decoration: underline; text-underline-offset: 3px; transition: color .15s; }
.edit-name-button:hover { color: var(--text-2); }
.stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 30px; }
.stat-tile { padding: 18px 20px; border: 1px solid var(--line); border-radius: 10px; background: linear-gradient(180deg, #121216, var(--bg-raised)); }
.stat-v { font: 600 26px var(--mono); letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
.stat-v.red { color: var(--danger); }
.stat-k { margin-top: 5px; font: 600 10px var(--mono); letter-spacing: .12em; color: var(--muted); text-transform: uppercase; }
.sec-head { display: flex; align-items: baseline; gap: 12px; margin: 44px 0 14px; }
.sec-num { font: 600 11px var(--mono); color: var(--muted); }
.sec-head h2 { margin: 0; font-size: 20px; font-weight: 700; letter-spacing: -.02em; }
.sec-note { font: 11px var(--mono); color: var(--quiet); }
.sec-tools { margin-left: auto; }
.review-list { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }
.review-row { display: grid; grid-template-columns: 4px minmax(0,1.3fr) auto auto auto 20px; align-items: center; gap: 22px; width: 100%; min-height: 66px; padding: 12px 20px 12px 14px; border: 0; border-bottom: 1px solid var(--line-2); background: transparent; color: var(--text); cursor: pointer; text-align: left; transition: background .15s; }
.review-row:last-child { border-bottom: 0; }
.review-row:hover { background: var(--surface-2); }
.review-bar { width: 4px; height: 38px; border-radius: 2px; background: linear-gradient(180deg, #ff5a5f, #7d2a2e); }
.review-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16.5px; font-weight: 650; letter-spacing: -.015em; }
.review-sub { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10.5px var(--mono); color: var(--muted); }
.spark { display: flex; align-items: flex-end; gap: 2px; height: 26px; }
.spark i { width: 3px; border-radius: 1px; background: #3a3a41; }
.spark i.hot { background: var(--danger); }
.review-nums { min-width: 120px; text-align: right; font: 11px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.review-nums .ev { display: block; color: var(--text-2); }
.review-nums .fl { display: block; margin-top: 2px; color: var(--danger-mid); }
.review-rel { min-width: 64px; text-align: right; font: 10.5px var(--mono); color: var(--quiet); }
.review-arrow { color: var(--muted); font-size: 15px; }
.table-card { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; background: var(--surface); }
.thead, .trow { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(0,1fr) 90px 70px 90px 70px; gap: 18px; align-items: center; padding: 8px 20px; }
.thead { padding: 10px 20px; border-bottom: 1px solid var(--line); font: 600 9.5px var(--mono); letter-spacing: .12em; color: var(--quiet); text-transform: uppercase; }
.thead .r, .trow .r { text-align: right; }
.trow { width: 100%; min-height: 46px; border: 0; border-bottom: 1px solid var(--line-2); background: transparent; color: var(--text); cursor: pointer; text-align: left; transition: background .12s; }
.trow:last-child { border-bottom: 0; }
.trow:hover { background: #121216; }
.t-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 600; }
.t-proj { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10.5px var(--mono); color: var(--muted); }
.t-num { font: 11.5px var(--mono); color: var(--text-2); font-variant-numeric: tabular-nums; }
.t-num.red { color: var(--danger-mid); }
.t-num.dim { color: var(--quiet); }
.t-last { font: 10.5px var(--mono); color: var(--quiet); }
.chip-verdict { justify-self: end; padding: 3px 8px; border: 1px solid #26262b; border-radius: 5px; background: transparent; color: var(--muted); font: 600 9.5px var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.chip-verdict.danger { border-color: var(--danger-line); background: var(--danger-soft); color: var(--danger-text); }

/* ── search results ───────────────────────────────────────────────────────── */
.search-view { max-width: 980px; animation: bbFade .25s ease; }
.search-eyebrow { display: flex; align-items: center; gap: 10px; font: 600 10px var(--mono); letter-spacing: .18em; color: var(--muted); }
.search-eyebrow::before { content: ""; width: 20px; height: 1px; background: #333339; }
.search-q { margin: 14px 0 4px; font-size: 32px; font-weight: 700; letter-spacing: -.03em; overflow-wrap: anywhere; }
.search-sum { font: 11px var(--mono); color: var(--quiet); }
.sr-label { margin-top: 34px; }
.sr-list { margin-top: 10px; border-top: 1px solid var(--line); }
.sr-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 18px; align-items: center; width: 100%; min-height: 60px; padding: 12px 8px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--text); cursor: pointer; text-align: left; }
.sr-row:hover { background: var(--surface-2); }
.sr-row.hit { grid-template-columns: 34px minmax(0,1fr) auto; min-height: 52px; padding: 10px 8px; }
.sr-title { display: block; font-size: 15px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sr-sub { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10.5px var(--mono); color: var(--muted); }
.sr-kind { font: 600 9.5px var(--mono); letter-spacing: .1em; color: var(--quiet); text-transform: uppercase; white-space: nowrap; }
.sr-kind.danger { color: var(--danger-text); }
.sr-num { font: 10.5px var(--mono); color: var(--quiet); }
.sr-snippet { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text-2); }
.sr-snippet mark { border-radius: 3px; background: rgba(255,255,255,.12); color: var(--text); }

/* ── session shell ────────────────────────────────────────────────────────── */
.session-page { animation: bbFade .25s ease; }
.back-link { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; color: var(--muted); font: 600 12px var(--sans); transition: color .15s; }
.back-link:hover { color: var(--text); }
.session-hero { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 24px; align-items: center; margin-top: 10px; }
.session-crumb { font: 10.5px var(--mono); color: var(--quiet); }
.session-hero h1 { margin: 4px 0 0; font-size: clamp(28px, 3vw, 38px); font-weight: 700; letter-spacing: -.035em; line-height: 1.05; overflow-wrap: anywhere; }
.session-facts { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px; font: 11px var(--mono); color: var(--muted); font-variant-numeric: tabular-nums; }
.session-facts strong { color: var(--text); font-weight: 600; }
.session-id-inline { color: var(--ghost); overflow-wrap: anywhere; user-select: all; }
.risk-badge { padding: 10px 16px; border: 1px solid #26262b; border-radius: 8px; color: var(--muted); font: 600 12px var(--sans); letter-spacing: .02em; white-space: nowrap; }
.risk-badge.danger { border-color: rgba(229,72,77,.45); background: rgba(229,72,77,.08); color: var(--danger-text); }
.tabs { position: sticky; top: 0; z-index: 12; display: flex; gap: 4px; margin: 22px -6px 20px; padding: 8px 6px; border-bottom: 1px solid var(--line); background: rgba(7,7,8,.92); backdrop-filter: blur(12px); }
.tab { display: inline-flex; align-items: center; min-height: 36px; padding: 0 15px; border-radius: 8px; color: var(--muted); font: 600 12.5px var(--sans); transition: color .15s, background .15s; }
.tab:hover { color: var(--text); }
.tab.active { background: #1c1c22; color: var(--text); }

/* ── overview: the numbered flow ──────────────────────────────────────────── */
.ov-stack { display: flex; flex-direction: column; gap: 14px; animation: bbUp .3s ease; }
.panel { min-width: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.panel-pad { padding: 22px 24px; }
.ov-hero-top { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 24px; align-items: center; padding: 22px 24px; }
.ov-outcome { max-width: 70ch; margin: 10px 0 0; font-size: 16.5px; line-height: 1.55; color: #e4e4e6; text-wrap: pretty; }
.ov-cta { display: flex; gap: 8px; flex: none; }
.blast-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1px; border-top: 1px solid var(--line-2); background: var(--line-2); }
.blast-cell { display: flex; align-items: baseline; gap: 10px; padding: 13px 18px; background: var(--surface); min-width: 0; }
.blast-v { font: 600 18px var(--mono); font-variant-numeric: tabular-nums; }
.blast-v.zero { color: var(--quiet); }
.blast-k { font: 10px var(--mono); color: var(--muted); }
.ov-cols { display: grid; grid-template-columns: minmax(0,1.4fr) minmax(300px,1fr); gap: 14px; align-items: start; }
.head-row { display: flex; align-items: baseline; gap: 10px; }
.head-row .note { font: 10px var(--mono); color: var(--quiet); }
.head-row .note.end { margin-left: auto; }
.find-list, .chk-list { display: flex; flex-direction: column; }
.find-row { display: grid; grid-template-columns: 26px 8px minmax(0,1fr) auto; gap: 12px; align-items: center; width: 100%; padding: 13px 4px; border: 0; border-bottom: 1px solid var(--line-2); background: transparent; color: var(--text); cursor: pointer; text-align: left; }
.find-row:last-child { border-bottom: 0; }
.find-row:hover { background: var(--surface-2); }
.find-num { font: 10.5px var(--mono); color: var(--quiet); }
.find-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--danger); }
.find-title { display: block; font-size: 14px; font-weight: 650; }
.find-sub { display: block; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px var(--mono); color: var(--muted); }
.find-count { font: 600 11px var(--mono); color: var(--danger-mid); }
.progress { height: 3px; margin: 10px 0 4px; border-radius: 2px; background: #1c1c21; overflow: hidden; }
.progress i { display: block; height: 100%; background: var(--text); transition: width .25s; }
.chk-row { display: grid; grid-template-columns: 26px minmax(0,1fr); gap: 12px; align-items: start; padding: 11px 0; border-bottom: 1px solid var(--line-2); }
.chk-row:last-child { border-bottom: 0; }
.chk-box { width: 20px; height: 20px; margin-top: 1px; padding: 0; display: grid; place-items: center; border: 1px solid #3a3a41; border-radius: 5px; background: transparent; color: var(--bg); font: 700 12px var(--mono); cursor: pointer; }
.chk-row.done .chk-box { border-color: var(--text); background: var(--text); }
.chk-body { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: start; width: 100%; padding: 0; border: 0; background: transparent; color: var(--text); cursor: pointer; text-align: left; }
.chk-title { display: block; font-size: 12.5px; font-weight: 600; line-height: 1.45; }
.chk-row.done .chk-title { color: var(--quiet); text-decoration: line-through; }
.chk-sub { display: block; margin-top: 2px; font: 10px var(--mono); color: var(--quiet); }
.chk-view { padding-top: 2px; font: 10px var(--mono); color: var(--muted); white-space: nowrap; }
.trust-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 28px; padding: 16px 24px; }
.trust-pair { display: flex; align-items: baseline; gap: 7px; }
.trust-v { font: 600 12.5px var(--mono); font-variant-numeric: tabular-nums; }
.trust-v.bad { color: var(--danger-text); }
.trust-k { font: 10px var(--mono); color: var(--quiet); }
.capture-wrap { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.capture-label { font: 10px var(--mono); color: var(--muted); white-space: nowrap; }
.capture-bar { width: 90px; height: 3px; border-radius: 2px; background: #1c1c21; overflow: hidden; }
.capture-bar i { display: block; height: 100%; background: var(--text-2); }
.trust-note { flex-basis: 100%; font: 10px var(--mono); color: var(--quiet); overflow-wrap: anywhere; }
.trust-findings { margin: 0 24px 16px; }
.trust-findings summary { min-height: 32px; display: flex; align-items: center; cursor: pointer; color: var(--muted); font: 11px var(--sans); list-style: none; }
.trust-findings summary::-webkit-details-marker { display: none; }
.trust-findings summary::after { content: " +"; margin-left: 5px; color: var(--quiet); }
.trust-findings[open] summary::after { content: " −"; }

/* ── activity: merged prompts + evidence ──────────────────────────────────── */
.act-layout { display: grid; grid-template-columns: minmax(0,1fr) 288px; gap: 14px; align-items: start; animation: bbUp .3s ease; }
.act-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.act-count { margin-left: auto; font: 10.5px var(--mono); color: var(--quiet); }
.activity-list { display: flex; flex-direction: column; gap: 6px; }
.turn-card { border: 1px solid #1c1c21; border-left: 3px solid #26262b; border-radius: 10px; background: var(--surface); overflow: hidden; }
.turn-card.flagged { border-color: rgba(229,72,77,.28); border-left-color: var(--danger); background: rgba(229,72,77,.04); }
.turn-head { display: grid; grid-template-columns: 30px 16px minmax(160px,1fr) fit-content(45%); gap: 12px; align-items: center; width: 100%; min-height: 50px; padding: 10px 16px; border: 0; background: transparent; color: var(--text); cursor: pointer; text-align: left; }
.turn-head:hover { background: rgba(255,255,255,.02); }
.turn-index { font: 10.5px var(--mono); color: var(--quiet); white-space: nowrap; }
.turn-glyph { font: 11px var(--mono); color: var(--quiet); }
.turn-glyph.user { color: var(--text); }
.turn-gist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13.5px; font-weight: 450; color: #a9a9af; }
.turn-gist.user { font-weight: 650; color: var(--text); }
.turn-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 10px var(--mono); color: var(--quiet); text-align: right; }
.turn-body { padding: 4px 16px 16px 58px; animation: bbFade .2s ease; }
.turn-text { margin: 0; max-width: 78ch; font: 13.5px/1.6 var(--sans); color: var(--text-2); white-space: pre-wrap; word-break: break-word; text-wrap: pretty; }
.turn-chips { display: flex; flex-wrap: wrap; gap: 6px 20px; margin-top: 12px; font: 10.5px var(--mono); color: var(--muted); }
.turn-ev-head { margin: 14px 0 8px; font-size: 9px; }
.ev-list { display: flex; flex-direction: column; gap: 6px; }
.ev-row { display: grid; grid-template-columns: 46px minmax(0,1fr) auto; gap: 12px; align-items: center; width: 100%; min-height: 42px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--surface-2); color: var(--text); text-align: left; cursor: pointer; }
.ev-row.danger { border-color: rgba(229,72,77,.25); background: rgba(229,72,77,.05); }
.ev-kind { font: 600 8.5px var(--mono); letter-spacing: .1em; color: var(--muted); }
.ev-row.danger .ev-kind { color: var(--danger-mark); }
.ev-label { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 12px var(--mono); }
.ev-sub { display: block; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 9.5px var(--mono); color: var(--muted); }
.ev-act { font: 10px var(--mono); color: var(--muted); white-space: nowrap; }
.turn-more { margin-top: 12px; }
.turn-more summary { min-height: 32px; display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--muted); font-size: 11px; list-style: none; }
.turn-more summary::-webkit-details-marker { display: none; }
.turn-more summary::after { content: "+"; color: var(--quiet); }
.turn-more[open] summary::after { content: "−"; }
.turn-more summary:hover { color: var(--text-2); }
.prompt-text, .reasoning { max-height: 360px; margin: 8px 0 0; overflow: auto; padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg-raised); color: var(--text-2); font: 12.5px/1.65 var(--sans); white-space: pre-wrap; word-break: break-word; }
.redaction-mark { border-radius: 3px; background: var(--danger-soft); color: #eba1a1; }
.unavailable-copy { margin: 8px 0 0; color: var(--muted); font-size: 12px; }
.step-list { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.step-row { display: grid; grid-template-columns: 58px 92px minmax(0,1fr) auto; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 6px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text-2); text-align: left; cursor: pointer; }
.step-row:hover { background: var(--surface-3); }
.step-row.danger { background: var(--danger-soft); }
.step-time, .step-tool, .step-duration { font: 10.5px var(--mono); color: var(--muted); }
.step-content { min-width: 0; display: flex; flex-direction: column; }
.step-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.step-labels { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 9px var(--mono); color: #c98282; text-transform: uppercase; }
.rail { position: sticky; top: 66px; display: flex; flex-direction: column; gap: 14px; }
.rail-panel { padding: 18px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.rail-head { margin-bottom: 4px; }
.rail-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 10px; align-items: center; width: 100%; min-height: 36px; padding: 7px 2px; border: 0; border-bottom: 1px solid var(--line-2); background: transparent; color: var(--text); cursor: pointer; text-align: left; }
.rail-row:last-child { border-bottom: 0; }
.rail-row:hover { background: var(--surface-2); }
.rail-host { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px var(--mono); color: var(--danger-mid); }
.rail-turn { font: 9.5px var(--mono); color: var(--quiet); white-space: nowrap; }
.rail-file { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 11.5px var(--mono); }
.rail-diff { display: block; font: 9.5px var(--mono); color: var(--quiet); }
.rail-note { margin: 10px 0 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.rail-more { padding: 7px 2px 0; font: 9.5px var(--mono); color: var(--quiet); }

/* ── graph ────────────────────────────────────────────────────────────────── */
.graph-view { animation: bbUp .3s ease; }
.graph-toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.graph-count { font: 10.5px var(--mono); color: var(--quiet); }
.graph-hint { margin-left: auto; font: 10.5px var(--mono); color: var(--quiet); }
.graph-layout { display: grid; grid-template-columns: minmax(0,1fr) 300px; gap: 14px; align-items: start; }
.graph-canvas { position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: linear-gradient(rgba(255,255,255,.015) 1px, transparent 1px) 0 0/100% 40px, linear-gradient(90deg, rgba(255,255,255,.015) 1px, transparent 1px) 0 0/40px 100%, #0a0a0d; }
.graph-stage { height: clamp(480px, 64vh, 700px); }
.graph-svg { display: block; width: 100%; height: 100%; cursor: grab; }
.graph-svg.panning { cursor: grabbing; }
.graph-edge { fill: none; stroke: #33333a; stroke-width: 1.4; transition: stroke .15s; }
.graph-edge.danger { stroke: rgba(229,72,77,.45); }
.graph-edge.active { stroke: #55555e; }
.graph-edge.danger.active { stroke: rgba(229,72,77,.75); }
.gnode { cursor: pointer; }
.gnode rect.card { fill: #111115; stroke: #2a2a30; stroke-width: 1; transition: fill .15s, stroke .15s; }
.gnode:hover rect.card { fill: #17171a; }
.gnode.danger rect.card { stroke: var(--danger-line); }
.gnode.selected rect.card { fill: #17171a; stroke: var(--text); stroke-width: 1.5; }
.gnode .gdot { fill: var(--muted); }
.gnode.kind-prompt .gdot { fill: var(--text); }
.gnode.kind-file .gdot, .gnode.kind-dir .gdot { fill: var(--text-2); }
.gnode.kind-commit .gdot { fill: var(--quiet); }
.gnode.kind-finding .gdot, .gnode.kind-host .gdot { fill: var(--danger); }
.gnode .glabel { fill: var(--text); font: 600 12.5px var(--sans); pointer-events: none; }
.gnode .gsub { fill: var(--muted); font: 9.5px var(--mono); pointer-events: none; }
.graph-legendbar { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; padding: 10px 16px; border-top: 1px solid #1c1c21; background: rgba(10,10,13,.9); backdrop-filter: blur(8px); font: 9.5px var(--mono); color: var(--muted); }
.graph-legendbar .k { margin-right: 5px; }
.graph-legendbar .k.prompt { color: var(--text); }
.graph-legendbar .k.action { color: var(--muted); }
.graph-legendbar .k.file { color: var(--text-2); }
.graph-legendbar .k.commit { color: var(--quiet); }
.graph-legendbar .k.danger { color: var(--danger); }
.gdetail { padding: 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); align-self: start; }
.gd-title { font-size: 17px; font-weight: 700; letter-spacing: -.02em; overflow-wrap: anywhere; }
.gd-sub { margin-top: 4px; font: 10.5px var(--mono); color: var(--muted); line-height: 1.5; overflow-wrap: anywhere; }
.gd-facts { display: grid; grid-template-columns: 86px minmax(0,1fr); gap: 8px 10px; margin: 16px 0 0; padding-top: 14px; border-top: 1px solid #1c1c21; font: 11px var(--mono); }
.gd-facts dt { color: var(--quiet); }
.gd-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.gd-facts dd.danger { color: var(--danger-text); }
.gd-sec { margin-top: 16px; font-size: 9px; }
.gd-rel { display: grid; grid-template-columns: auto minmax(0,1fr); gap: 10px; align-items: baseline; width: 100%; margin-top: 8px; padding: 0; border: 0; background: transparent; color: var(--text); font: 11px var(--mono); cursor: pointer; text-align: left; }
.gd-rel:hover .gd-rel-label { color: var(--text-2); }
.gd-via { font: 600 9px var(--mono); letter-spacing: .08em; color: var(--quiet); text-transform: uppercase; }
.gd-via.danger { color: var(--danger-mark); }
.gd-rel-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gd-open { width: 100%; margin-top: 18px; min-height: 36px; border: 1px solid var(--danger-line); border-radius: 7px; background: var(--danger-soft); color: var(--danger-text); font: 600 11.5px var(--sans); cursor: pointer; }
.gd-open:hover { background: rgba(229,72,77,.16); }
.gd-open.plain { border-color: var(--line-strong); background: #141418; color: var(--text); }
.gd-open.plain:hover { border-color: #3d3d44; }
.gd-actions { display: flex; gap: 6px; margin-top: 8px; }
.gd-actions .quiet-button { min-height: 32px; padding: 0 10px; font-size: 11px; }
.graph-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; color: var(--muted); text-align: center; }
.graph-empty h3 { margin: 0; color: var(--text-2); font-size: 16px; }
.graph-empty p { max-width: 380px; margin: 8px 0 16px; font-size: 12.5px; }
.graph-loading-line { width: 180px; height: 2px; overflow: hidden; background: var(--line); }
.graph-loading-line::after { content: ""; display: block; width: 45%; height: 100%; background: var(--text-2); animation: shimmer 1.1s var(--ease) infinite; }

/* ── evidence drawer ──────────────────────────────────────────────────────── */
.drawer-backdrop { position: fixed; inset: 0; z-index: var(--z-drawer); background: rgba(4,4,5,.6); backdrop-filter: blur(3px); animation: bbFade .2s ease; }
.evidence-drawer { position: fixed; z-index: calc(var(--z-drawer) + 1); top: 0; right: 0; width: min(560px, 94vw); height: 100dvh; overflow-y: auto; border-left: 1px solid #26262b; background: #0d0d10; box-shadow: -30px 0 80px rgba(0,0,0,.5); animation: bbDrawer .25s var(--ease) both; }
.drawer-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 12px; padding: 18px 22px; border-bottom: 1px solid #1c1c21; background: rgba(13,13,16,.95); backdrop-filter: blur(10px); }
.drawer-head h2 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 15px var(--mono); }
.drawer-head-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.drawer-head-actions .quiet-button { min-height: 32px; padding: 0 12px; font-size: 11.5px; }
.drawer-head-actions .icon-button { width: 32px; min-height: 32px; font-size: 14px; }
.tag-chip { flex: none; padding: 3px 9px; border: 1px solid var(--danger-line); border-radius: 5px; background: var(--danger-soft); color: var(--danger-text); font: 600 10px var(--mono); letter-spacing: .04em; }
.tag-chip.plain { border-color: #26262b; background: transparent; color: var(--muted); }
.drawer-body { padding: 22px; }
.drawer-section { margin-top: 26px; }
.drawer-section.first { margin-top: 0; }
.drawer-section h3 { margin: 0 0 12px; color: var(--muted); font: 600 9.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.drawer-section pre { max-height: 420px; margin: 0; overflow: auto; padding: 16px; border: 1px solid #1c1c21; border-radius: 9px; background: #09090b; color: var(--text-2); font: 10.5px/1.7 var(--mono); white-space: pre-wrap; word-break: break-word; }
.kv-grid { display: grid; grid-template-columns: 100px minmax(0,1fr); gap: 9px 14px; margin: 0; font: 11px/1.6 var(--mono); color: var(--text); }
.kv-grid dt { color: var(--quiet); }
.kv-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.summary-copy { margin: 0; color: var(--text-2); font-size: 13.5px; line-height: 1.6; text-wrap: pretty; }
.summary-copy.small { font-size: 12.5px; }
.explain-title { margin: 0 0 10px; font-size: 13.5px; font-weight: 600; }
.explanation-steps { margin: 0; padding-left: 20px; color: var(--text-2); font-size: 12.5px; line-height: 1.7; }
.explanation-steps li { margin-bottom: 4px; }
.explanation-section h4 { margin: 20px 0 8px; color: #df9696; font: 600 9.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.danger-explanation { margin-top: 8px; padding: 12px; border: 1px solid var(--danger-line); border-radius: 8px; background: var(--danger-soft); }
.danger-explanation strong, .danger-explanation span { display: block; font-size: 12px; }
.danger-explanation span { margin-top: 3px; color: #d5abab; }
.risk-line { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.risk-line strong { font: 600 14px var(--sans); }
.risk-line .who { margin-left: auto; font: 10.5px var(--mono); color: var(--quiet); }
.risk-score-bar { height: 4px; margin-top: 10px; border-radius: 2px; background: #1c1c21; overflow: hidden; }
.risk-score-bar i { display: block; height: 100%; border-radius: 2px; background: linear-gradient(90deg, #7d2a2e, var(--danger)); }
.diffstat-line { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 10px; color: var(--muted); font: 11px var(--mono); }
.diff-view span { display: block; min-height: 1.5em; }
.diff-add { color: #d8d8da; background: rgba(255,255,255,.035); }
.diff-remove { color: #d98787; background: rgba(229,72,77,.08); }
.diff-context { color: var(--muted); }
.mutation-state { padding: 13px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); font-size: 12px; }
.redaction-row { display: grid; grid-template-columns: 140px minmax(0,1fr); gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); font-size: 12px; }
.redaction-row span { color: var(--muted); font-family: var(--mono); overflow-wrap: anywhere; }
.forensic-disclosure summary { min-height: 38px; display: flex; align-items: center; cursor: pointer; color: var(--text-2); font-size: 12px; }
.danger-text { color: var(--danger-mid); }

/* ── profile popover, toast, settings ─────────────────────────────────────── */
.profile-popover { position: fixed; z-index: var(--z-popover); top: 24px; right: 24px; width: min(320px, calc(100vw - 32px)); padding: 18px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface-2); box-shadow: 0 22px 70px rgba(0,0,0,.5); }
.profile-popover h2 { margin: 0 0 5px; font-size: 15px; }
.profile-popover p { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.profile-settings-link { width: 100%; justify-content: space-between; margin-top: 12px; padding: 14px 0 2px; border: 0; border-top: 1px solid var(--line); border-radius: 0; display: flex; align-items: center; }
.field-label { display: block; margin-bottom: 6px; color: var(--text-2); font-size: 12px; }
.popover-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.toast { position: fixed; z-index: 80; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 11px 15px; border: 1px solid var(--line-strong); border-radius: 9px; background: var(--surface-2); color: var(--text-2); font-size: 12.5px; box-shadow: 0 16px 50px rgba(0,0,0,.4); }
.settings-page { animation: bbFade .25s ease; }
.settings-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 32px; padding: 24px 0 30px; }
.settings-hero h1 { margin: 7px 0 10px; font-size: clamp(30px, 4vw, 44px); font-weight: 700; letter-spacing: -.035em; }
.settings-hero p { max-width: 680px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.settings-panel { padding: 22px 24px; }
.settings-panel h2 { margin: 7px 0 18px; font-size: 18px; font-weight: 700; letter-spacing: -.02em; }
.panel-label { margin-bottom: 12px; color: var(--muted); font: 600 9.5px var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.settings-fact { display: grid; grid-template-columns: minmax(110px, .45fr) minmax(0, 1fr); gap: 18px; align-items: start; padding: 11px 0; border-top: 1px solid var(--line-2); }
.settings-fact > span { color: var(--muted); font-size: 12px; }
.settings-fact strong, .settings-fact samp { min-width: 0; overflow-wrap: anywhere; color: var(--text); font-size: 12.5px; text-align: right; }
.settings-fact samp { font: 11px var(--mono); }
.settings-copy { margin: 6px 0 0; color: var(--muted); font-size: 12.5px; line-height: 1.65; }
.privacy-list { display: grid; gap: 12px; margin: 0; padding: 0; list-style: none; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
.privacy-list li { position: relative; padding-left: 20px; }
.privacy-list li::before { content: '·'; position: absolute; left: 4px; color: var(--quiet); }
.settings-wide { grid-column: 1 / -1; }
.privacy-commands { display: grid; margin-top: 16px; border-top: 1px solid var(--line-2); }
.privacy-command { display: grid; grid-template-columns: minmax(270px, .8fr) minmax(0, 1fr); gap: 24px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--line-2); }
.privacy-command code { color: var(--text); font: 11.5px var(--mono); overflow-wrap: anywhere; }
.privacy-command span { color: var(--muted); font-size: 12px; }
.settings-loading { min-height: 180px; }

/* ── responsive ───────────────────────────────────────────────────────────── */
@media (max-width: 1100px) {
  .ov-cols, .act-layout, .graph-layout { grid-template-columns: 1fr; }
  .rail { position: static; }
  .stat-grid { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 900px) {
  .sidebar { position: static; width: auto; height: auto; flex-direction: row; align-items: center; gap: 4px; padding: 8px 10px; border-right: 0; border-bottom: 1px solid #1d1d21; }
  .sb-brand { padding: 4px 8px; border-bottom: 0; }
  .sb-word { display: none; }
  .sb-search { flex: 1; padding: 0 6px; }
  .sb-nav { padding: 0; }
  .sb-dash { width: auto; padding: 0 10px; }
  .sb-scroll, .sb-status { display: none; }
  main { margin-left: 0; min-height: 0; }
  .app-shell { padding: 24px 18px 64px; }
  .review-row { grid-template-columns: 4px minmax(0,1fr) auto; }
  .review-row .spark, .review-rel, .review-arrow { display: none; }
  .thead, .trow { grid-template-columns: minmax(0,1.4fr) 70px 90px; }
  .t-proj, .thead .h-proj, .t-num.ev-col, .thead .h-ev, .t-last, .thead .h-last { display: none; }
  .session-hero { grid-template-columns: 1fr; gap: 14px; }
  .risk-badge { justify-self: start; }
  .ov-hero-top { grid-template-columns: 1fr; gap: 16px; }
  .turn-head { grid-template-columns: 30px 16px minmax(0,1fr); }
  .turn-meta { display: none; }
  .turn-body { padding-left: 16px; }
  .settings-grid { grid-template-columns: 1fr; }
  .settings-wide { grid-column: auto; }
  .privacy-command { grid-template-columns: 1fr; gap: 7px; }
  .evidence-drawer { top: auto; bottom: 0; width: 100%; height: min(88dvh, 760px); border-top: 1px solid var(--line-strong); border-left: 0; border-radius: 16px 16px 0 0; animation-name: bbSheet; }
  .kv-grid { grid-template-columns: 1fr; gap: 2px; }
  .kv-grid dd { margin-bottom: 10px; }
}
@keyframes bbSheet { from { opacity: 0; transform: translateY(28px); } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
`;
