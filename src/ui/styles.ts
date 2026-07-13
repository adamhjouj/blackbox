export const UI_CSS = `
:root {
  color-scheme: dark;
  --bg: #0a0a0a;
  --bg-raised: #0f0f10;
  --surface: #141415;
  --surface-2: #19191b;
  --surface-3: #202022;
  --line: #29292c;
  --line-strong: #3b3b3f;
  --text: #f1f1f2;
  --text-2: #c5c5c8;
  --muted: #8a8a90;
  --quiet: #5d5d63;
  --danger: #d95454;
  --danger-soft: rgba(217, 84, 84, .11);
  --danger-line: rgba(217, 84, 84, .42);
  --mono: ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
  --header: 64px;
  --content: 1280px;
  --ease: cubic-bezier(.2,.75,.25,1);
  --z-header: 30;
  --z-popover: 50;
  --z-drawer: 60;
}
* { box-sizing: border-box; }
html { min-height: 100%; scroll-behavior: smooth; background: var(--bg); }
body { min-width: 320px; min-height: 100dvh; margin: 0; overflow-x: hidden; background:
  radial-gradient(900px 500px at 20% -12%, rgba(255,255,255,.045), transparent 64%), var(--bg);
  color: var(--text); font: 14px/1.55 var(--sans); -webkit-font-smoothing: antialiased; }
button, input, select { font: inherit; }
button, a { -webkit-tap-highlight-color: transparent; }
button { color: inherit; }
a { color: inherit; text-decoration: none; }
::selection { background: rgba(217,84,84,.25); }
:focus-visible { outline: 2px solid #dedee1; outline-offset: 3px; }
.skip-link { position: fixed; top: 8px; left: 8px; z-index: 100; transform: translateY(-150%); background: var(--text); color: #111; padding: 9px 12px; border-radius: 8px; }
.skip-link:focus { transform: none; }
.topbar { position: sticky; top: 0; z-index: var(--z-header); height: var(--header); display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 20px; padding: 0 24px; border-bottom: 1px solid var(--line); background: rgba(10,10,10,.88); backdrop-filter: blur(18px); }
.brand { justify-self: start; display: inline-flex; align-items: center; gap: 10px; min-height: 44px; font-size: 15px; font-weight: 650; letter-spacing: -.02em; }
.brand-mark { width: 13px; height: 13px; border: 2px solid var(--text); border-radius: 3px; box-shadow: inset 0 0 0 2px var(--bg); background: var(--text); }
.topnav { display: flex; align-items: center; gap: 4px; padding: 3px; border: 1px solid var(--line); border-radius: 12px; background: var(--bg-raised); }
.nav-home, .nav-search { min-height: 38px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 0 13px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); cursor: pointer; transition: color .18s var(--ease), background .18s var(--ease), transform .18s var(--ease); }
.nav-home:hover, .nav-search:hover, .nav-home.active { color: var(--text); background: var(--surface-2); }
.nav-home:active, .nav-search:active { transform: scale(.98); }
kbd { padding: 1px 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--quiet); font: 10px var(--sans); }
.topmeta { justify-self: end; display: flex; align-items: center; gap: 14px; min-width: 0; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.connection { display: inline-flex; align-items: center; gap: 7px; white-space: nowrap; }
.status-dot { width: 7px; height: 7px; border: 1px solid var(--muted); border-radius: 50%; background: var(--quiet); }
.connection.offline { color: var(--danger); }
.connection.offline .status-dot { border-color: var(--danger); background: var(--danger); }
.event-total { white-space: nowrap; }
.profile-button { width: 38px; height: 38px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); color: var(--text-2); cursor: pointer; font-weight: 650; text-transform: uppercase; transition: border-color .18s, background .18s, transform .18s; }
.profile-button:hover { border-color: var(--line-strong); background: var(--surface-2); }
.profile-button:active { transform: scale(.96); }
.profile-popover { position: fixed; z-index: var(--z-popover); top: 58px; right: 24px; width: min(320px, calc(100vw - 32px)); padding: 18px; border: 1px solid var(--line-strong); border-radius: 14px; background: var(--surface); box-shadow: 0 22px 70px rgba(0,0,0,.5); }
.profile-popover h2 { margin: 0 0 5px; font-size: 16px; }
.profile-popover p { margin: 0 0 14px; color: var(--muted); font-size: 12px; }
.field-label { display: block; margin-bottom: 6px; color: var(--text-2); font-size: 12px; }
.text-field { width: 100%; min-height: 44px; padding: 0 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg); color: var(--text); }
.text-field:focus { border-color: var(--line-strong); outline: none; }
.popover-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.connection-alert { position: sticky; top: var(--header); z-index: 20; padding: 9px 24px; border-bottom: 1px solid var(--danger-line); background: #1a1010; color: #e9b5b5; text-align: center; font-size: 12px; }
main { min-height: calc(100dvh - var(--header)); }
.app-shell { width: min(var(--content), calc(100% - 48px)); margin: 0 auto; padding: 38px 0 88px; }
.app-shell.graph-shell { padding-top: 30px; }
.eyebrow { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; color: var(--muted); font-size: 12px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; }
.eyebrow::before { content: ""; width: 18px; height: 1px; background: var(--line-strong); }
.hero { max-width: 900px; padding: 4px 0 0; }
.hero h1 { max-width: 760px; margin: 0; font-size: clamp(34px, 4vw, 48px); line-height: 1.04; letter-spacing: -.047em; text-wrap: balance; }
.hero h1 span { color: var(--muted); }
.hero p { max-width: 620px; margin: 8px 0 0; color: var(--muted); font-size: 14px; line-height: 1.55; text-wrap: pretty; }
.search-wrap { position: relative; max-width: 780px; margin-top: 18px; }
.search-icon { position: absolute; left: 19px; top: 50%; transform: translateY(-50%); color: var(--muted); font-size: 22px; pointer-events: none; }
.home-search { width: 100%; height: 58px; padding: 0 52px; border: 1px solid var(--line-strong); border-radius: 16px; background: var(--surface); color: var(--text); box-shadow: 0 18px 50px rgba(0,0,0,.18); font-size: 16px; transition: border-color .18s, background .18s, box-shadow .18s; }
.home-search::placeholder { color: var(--quiet); }
.home-search:focus { outline: none; border-color: #606066; background: var(--surface-2); box-shadow: 0 20px 70px rgba(0,0,0,.32); }
.search-clear { position: absolute; right: 10px; top: 7px; width: 44px; height: 44px; border: 0; border-radius: 11px; background: transparent; color: var(--muted); cursor: pointer; }
.search-clear:hover { background: var(--surface-3); color: var(--text); }
.section-block { margin-top: 28px; }
.section-head { display: flex; align-items: end; justify-content: space-between; gap: 18px; margin-bottom: 20px; }
.section-head h2 { margin: 0; font-size: 24px; line-height: 1.2; letter-spacing: -.035em; }
.section-head p { margin: 5px 0 0; color: var(--muted); font-size: 13px; }
.section-actions { display: flex; gap: 8px; }
.fleet-strip { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-top: 12px; color: var(--muted); font-size: 11px; }
.fleet-strip span { white-space: nowrap; }
.fleet-strip strong { color: var(--text-2); font: 600 12px var(--mono); }
.sort-switch { display: flex; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg-raised); }
.sort-switch button { min-height: 36px; padding: 0 11px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; }
.sort-switch button.active { background: var(--surface-3); color: var(--text); }
.icon-button, .secondary-button, .quiet-button, .danger-button { min-height: 44px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--text-2); cursor: pointer; transition: background .18s var(--ease), border-color .18s var(--ease), color .18s var(--ease), transform .18s var(--ease); }
.icon-button { width: 44px; padding: 0; font-size: 18px; }
.secondary-button, .quiet-button, .danger-button { padding: 0 14px; }
.quiet-button { border-color: transparent; background: transparent; color: var(--muted); }
.danger-button { border-color: var(--danger-line); background: var(--danger-soft); color: #e89c9c; }
.icon-button:hover, .secondary-button:hover, .quiet-button:hover { background: var(--surface-2); border-color: var(--line-strong); color: var(--text); }
.icon-button:active, .secondary-button:active, .quiet-button:active, .danger-button:active { transform: scale(.98); }
.session-shelf { display: grid; grid-auto-flow: column; grid-auto-columns: 264px; gap: 16px; overflow-x: auto; overscroll-behavior-inline: contain; scroll-snap-type: inline mandatory; scrollbar-width: none; padding: 2px 2px 18px; }
.session-shelf::-webkit-scrollbar { display: none; }
.session-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.session-card { position: relative; display: flex; flex-direction: column; aspect-ratio: 1; min-width: 0; padding: 22px; overflow: hidden; border: 1px solid var(--line); border-radius: 16px; background: linear-gradient(145deg, var(--surface-2), var(--surface)); scroll-snap-align: start; cursor: pointer; transition: transform .2s var(--ease), border-color .2s var(--ease), background .2s var(--ease); }
.session-card::after { content: ""; position: absolute; inset: auto -20% -50% 20%; height: 70%; border-radius: 50%; background: radial-gradient(circle, rgba(255,255,255,.035), transparent 70%); pointer-events: none; }
.session-card:hover { transform: translateY(-4px); border-color: var(--line-strong); background: linear-gradient(145deg, #1e1e20, #151516); }
.session-card:active { transform: translateY(-1px) scale(.99); }
.session-card.risk { border-color: var(--danger-line); }
.card-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.card-project { min-width: 0; overflow: hidden; color: var(--muted); font: 12px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.card-state { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; white-space: nowrap; }
.card-state::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--quiet); }
.card-state.danger { color: #e59191; }
.card-state.danger::before { background: var(--danger); }
.session-card h3 { position: relative; z-index: 1; margin: 28px 0 0; overflow: hidden; font-size: 23px; line-height: 1.15; letter-spacing: -.035em; text-wrap: balance; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; }
.card-footer { position: relative; z-index: 1; display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 12px; margin-top: auto; }
.card-stats { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.card-stats strong { display: block; margin-bottom: 2px; color: var(--text-2); font-size: 13px; font-weight: 550; }
.card-arrow { display: grid; place-items: center; width: 38px; height: 38px; border-radius: 10px; background: rgba(255,255,255,.05); color: var(--text-2); font-size: 19px; }
.search-groups { max-width: 920px; margin-top: 28px; }
.result-group { margin-top: 30px; }
.result-label { margin-bottom: 10px; color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.result-row { width: 100%; min-height: 68px; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 18px; padding: 13px 16px; border: 0; border-bottom: 1px solid var(--line); background: transparent; color: var(--text); text-align: left; cursor: pointer; transition: background .16s; }
.result-row:first-of-type { border-top: 1px solid var(--line); }
.result-row:hover { background: rgba(255,255,255,.025); }
.result-title { overflow: hidden; font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.result-sub { margin-top: 3px; overflow: hidden; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.result-kind { color: var(--quiet); font: 11px var(--mono); text-transform: uppercase; }
.empty-state { max-width: 560px; margin: 72px auto; padding: 44px; border: 1px solid var(--line); border-radius: 16px; background: var(--surface); text-align: center; }
.empty-symbol { display: grid; place-items: center; width: 52px; height: 52px; margin: 0 auto 18px; border: 1px solid var(--line-strong); border-radius: 14px; color: var(--muted); font-size: 23px; }
.empty-state h2 { margin: 0; font-size: 22px; }
.empty-state p { max-width: 420px; margin: 10px auto 0; color: var(--muted); }
.skeleton-card { aspect-ratio: 1; border-radius: 16px; background: var(--surface); overflow: hidden; }
.skeleton-card::after { content: ""; display: block; width: 50%; height: 100%; background: linear-gradient(90deg, transparent, rgba(255,255,255,.035), transparent); animation: shimmer 1.3s infinite; }
@keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(300%); } }
.session-page { max-width: 1160px; margin: 0 auto; }
.graph-page { max-width: 1240px; }
.graph-page > .back-link { min-height: 34px; }
.graph-page .session-hero { align-items: center; padding: 6px 0 12px; }
.graph-page .session-hero h1 { font-size: 29px; }
.graph-page .session-id { display: none; }
.graph-page .session-facts { margin-top: 9px; }
.graph-page .tabs { margin-bottom: 20px; }
.back-link { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; color: var(--muted); transition: color .18s; }
.back-link:hover { color: var(--text); }
.session-hero { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 24px; align-items: center; padding: 7px 0 14px; }
.session-hero h1 { max-width: 820px; margin: 0; font-size: clamp(27px, 3vw, 35px); line-height: 1.08; letter-spacing: -.04em; text-wrap: balance; }
.session-id { margin-top: 13px; overflow-wrap: anywhere; color: var(--quiet); font: 11px/1.5 var(--mono); }
.session-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 15px; margin-top: 7px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
.session-facts strong { color: var(--text-2); font-weight: 550; }
.risk-badge { min-width: 104px; padding: 10px 13px; border: 1px solid var(--line); border-radius: 10px; color: var(--muted); text-align: center; font-size: 12px; }
.risk-badge.danger { border-color: var(--danger-line); background: var(--danger-soft); color: #e99a9a; }
.session-details { position: relative; }
.session-details summary { min-height: 32px; display: inline-flex; align-items: center; cursor: pointer; color: var(--muted); list-style: none; }
.session-details summary::-webkit-details-marker { display: none; }
.session-detail-pop { position: absolute; z-index: 18; top: 34px; left: 0; width: min(440px, calc(100vw - 40px)); padding: 12px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface-2); box-shadow: 0 18px 55px rgba(0,0,0,.42); }
.session-detail-pop > div { display: grid; grid-template-columns: 80px minmax(0,1fr); gap: 10px; padding: 5px 0; }
.session-detail-pop span { color: var(--muted); }
.session-detail-pop samp { overflow-wrap: anywhere; color: var(--text-2); font: 11px/1.5 var(--mono); }
.tabs { position: sticky; top: var(--header); z-index: 15; display: flex; gap: 4px; margin: 0 -6px 18px; padding: 6px; border-bottom: 1px solid var(--line); background: rgba(10,10,10,.94); backdrop-filter: blur(14px); }
.tab { min-height: 44px; display: inline-flex; align-items: center; padding: 0 15px; border-radius: 10px; color: var(--muted); font-weight: 550; transition: background .18s, color .18s; }
.tab:hover { color: var(--text-2); }
.tab.active { background: var(--surface-2); color: var(--text); }
.overview-grid { display: grid; grid-template-columns: minmax(0,1.6fr) minmax(280px,.8fr); gap: 18px; }
.panel { min-width: 0; padding: 24px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.panel.flush { padding: 0; overflow: hidden; }
.panel.wide { grid-column: 1 / -1; }
.panel-label { margin-bottom: 12px; color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.summary-copy { max-width: 65ch; margin: 0; color: var(--text-2); font-size: 17px; line-height: 1.65; text-wrap: pretty; }
.summary-copy.small { font-size: 14px; line-height: 1.6; }
.metric-grid { display: grid; grid-template-columns: repeat(2,1fr); gap: 1px; overflow: hidden; border: 1px solid var(--line); border-radius: 12px; background: var(--line); }
.metric { min-height: 100px; padding: 18px; background: var(--surface); }
.metric strong { display: block; color: var(--text); font: 600 25px/1.1 var(--mono); letter-spacing: -.04em; }
.metric span { display: block; margin-top: 7px; color: var(--muted); font-size: 12px; }
.finding-list, .action-list, .evidence-list { display: flex; flex-direction: column; }
.finding-row, .action-row, .evidence-row { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: start; gap: 13px; padding: 15px 0; border-top: 1px solid var(--line); }
.finding-row:first-child, .action-row:first-child, .evidence-row:first-child { border-top: 0; }
.severity-mark { width: 7px; height: 7px; margin-top: 7px; border-radius: 50%; background: var(--quiet); }
.severity-mark.danger { background: var(--danger); box-shadow: 0 0 0 4px var(--danger-soft); }
.row-title { color: var(--text-2); font-weight: 550; }
.row-sub { margin-top: 3px; color: var(--muted); font-size: 12px; }
.row-count { color: var(--muted); font: 12px var(--mono); }
.panel-links { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 12px; }
.coverage { padding: 15px 17px; border: 1px solid var(--line); border-radius: 11px; color: var(--muted); font-size: 13px; }
.coverage.danger { border-color: var(--danger-line); color: #dca1a1; }
.overview-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 19px; }
.overview-actions a { display: inline-flex; align-items: center; justify-content: center; }
.compact-panel { display: grid; grid-template-columns: repeat(2,1fr); align-content: start; gap: 1px; overflow: hidden; padding: 0; border-color: var(--line); background: var(--line); }
.compact-panel .panel-label { grid-column: 1 / -1; margin: 0; padding: 15px 17px; background: var(--surface); }
.compact-fact { min-height: 76px; padding: 14px 17px; background: var(--surface); }
.compact-fact strong { display: block; font: 600 20px var(--mono); }
.compact-fact span { color: var(--muted); font-size: 11px; }
.finding-button, .action-button { width: 100%; border-right: 0; border-bottom: 0; border-left: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.finding-button:hover, .action-button:hover { background: rgba(255,255,255,.025); }
.finding-button > span:nth-child(2), .action-button > span:nth-child(2) { min-width: 0; }
.finding-button .row-title, .finding-button .row-sub, .action-button .row-title, .action-button .row-sub { display: block; }
.integrity-brief { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.integrity-brief .quiet-button { flex: 0 0 auto; display: inline-flex; align-items: center; }
.toolbar { display: grid; grid-template-columns: auto minmax(180px,1fr) auto; gap: 9px; margin-bottom: 18px; }
.activity-toolbar { position: sticky; top: calc(var(--header) + 57px); z-index: 13; grid-template-columns: auto minmax(220px,1fr) minmax(130px,auto) auto auto; align-items: center; margin: 0 0 12px; padding: 8px; border: 1px solid var(--line); border-radius: 12px; background: rgba(14,14,15,.95); backdrop-filter: blur(14px); }
.toolbar-count { padding: 0 5px; color: var(--muted); font: 10px var(--mono); white-space: nowrap; }
.toolbar .text-field, .toolbar select { min-height: 44px; }
.select-field { padding: 0 36px 0 12px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); color: var(--text-2); }
.activity-list { display: flex; flex-direction: column; gap: 10px; }
.turn-card { overflow: hidden; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); }
.turn-card.flagged { border-color: var(--danger-line); }
.turn-head { width: 100%; min-height: 72px; display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 15px; padding: 13px 17px; border: 0; background: transparent; text-align: left; cursor: pointer; }
.turn-head:hover { background: rgba(255,255,255,.025); }
.turn-index { color: var(--quiet); font: 11px var(--mono); white-space: nowrap; }
.turn-gist { overflow: hidden; color: var(--text-2); font-weight: 550; text-overflow: ellipsis; white-space: nowrap; }
.turn-title-stack { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.turn-badges { overflow: hidden; color: var(--quiet); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.turn-meta { color: var(--muted); font-size: 11px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.turn-body { padding: 4px 17px 18px 54px; border-top: 1px solid var(--line); }
.turn-actions { display: flex; justify-content: flex-end; margin: 8px 0 2px; }
.turn-section { margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
.turn-section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; color: var(--muted); font-size: 10px; font-weight: 650; letter-spacing: .055em; text-transform: uppercase; }
.turn-section-head span:last-child { color: var(--quiet); font-weight: 500; }
.prompt-text, .reasoning { max-height: 360px; margin: 0; overflow: auto; padding: 14px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg-raised); color: var(--text-2); font: 13px/1.65 var(--sans); white-space: pre-wrap; word-break: break-word; }
.reasoning { border-left: 2px solid var(--line-strong); }
.reasoning-label { display: block; margin-bottom: 8px; color: var(--muted); font-size: 11px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; }
.redaction-mark { border-radius: 3px; background: var(--danger-soft); color: #eba1a1; }
.unavailable-copy { margin: 0; color: var(--muted); font-size: 13px; }
.disclosure-button { width: 100%; min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 0; border: 0; background: transparent; color: var(--text-2); text-align: left; cursor: pointer; }
.disclosure-button span:last-child { color: var(--muted); font-size: 11px; }
.outcome-list { display: flex; flex-direction: column; }
.commit-list { margin-top: 8px; }
.outcome-row { width: 100%; min-height: 52px; display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 14px; padding: 8px 10px; border: 0; border-top: 1px solid var(--line); background: transparent; color: var(--text-2); text-align: left; cursor: pointer; }
.outcome-row:hover { background: var(--surface-3); }
.outcome-title, .outcome-sub { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.outcome-title { font-weight: 550; }
.outcome-sub { margin-top: 2px; color: var(--muted); font: 10px var(--mono); }
.outcome-stat { color: var(--muted); font: 11px var(--mono); white-space: nowrap; }
.step-list { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; }
.step-row { width: 100%; display: grid; grid-template-columns: 70px 100px minmax(0,1fr) auto; align-items: center; gap: 10px; min-height: 50px; padding: 8px 10px; border: 0; border-radius: 8px; background: transparent; color: var(--text-2); text-align: left; cursor: pointer; }
.step-row:hover { background: var(--surface-3); }
.step-row.danger { background: var(--danger-soft); }
.step-time, .step-tool, .step-duration { color: var(--muted); font: 11px var(--mono); }
.step-content { min-width: 0; display: flex; flex-direction: column; }
.step-summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.step-labels { margin-top: 3px; overflow: hidden; color: #c98282; font: 9px var(--mono); text-overflow: ellipsis; white-space: nowrap; text-transform: uppercase; }
.evidence-priority .result-row.danger { background: var(--danger-soft); }
.evidence-entity .result-title, .evidence-entity .result-sub { display: block; }
.evidence-section-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-bottom: 10px; }
.evidence-section-head .panel-label { margin-bottom: 1px; }
.evidence-search { max-width: 320px; }
.containment-list { margin: 0; padding: 0; list-style: none; }
.containment-item { width: 100%; min-height: 58px; display: grid; grid-template-columns: 58px minmax(0,1fr) auto; align-items: center; gap: 10px; padding: 10px 0; border: 0; border-top: 1px solid var(--line); background: transparent; color: var(--text-2); text-align: left; cursor: pointer; }
.containment-item:first-child { border-top: 0; }
.containment-item:hover { background: rgba(255,255,255,.025); }
.containment-severity { color: var(--muted); font: 10px var(--mono); text-transform: uppercase; }
.containment-item.danger .containment-severity { color: #df8f8f; }
.load-more { display: block; margin: 16px auto 0; }
.integrity-metrics { margin-bottom: 16px; grid-template-columns: repeat(4,1fr); }
.integrity-alert { margin: 12px 0; padding: 12px 14px; border: 1px solid var(--danger-line); border-radius: 9px; background: var(--danger-soft); color: #eaa3a3; }
.reconciliation-summary { display: grid; grid-template-columns: 180px minmax(0,1fr); gap: 14px; padding: 11px 0; border-top: 1px solid var(--line); }
.reconciliation-summary strong { color: var(--text-2); font-weight: 550; }
.reconciliation-summary span { color: var(--muted); }
.forensic-disclosure { margin-top: 14px; }
.forensic-disclosure summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--text-2); }
.drawer-section.first { margin-top: 0; }
.explanation-steps { margin: 12px 0 0; padding-left: 22px; color: var(--text-2); }
.explanation-steps li { margin-top: 6px; }
.explanation-section h4 { margin: 20px 0 8px; color: #df9696; font-size: 11px; text-transform: uppercase; }
.danger-explanation { margin-top: 8px; padding: 12px; border: 1px solid var(--danger-line); border-radius: 9px; background: var(--danger-soft); }
.danger-explanation strong, .danger-explanation span { display: block; }
.danger-explanation span { margin-top: 3px; color: #d5abab; }
.risk-line { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.signal-chip { padding: 4px 7px; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font: 10px var(--mono); }
.signal-chip.danger { border-color: var(--danger-line); color: #e39a9a; }
.diffstat-line { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-bottom: 10px; color: var(--muted); font: 11px var(--mono); }
.diff-view span { display: block; min-height: 1.5em; }
.diff-add { color: #d8d8da; background: rgba(255,255,255,.035); }
.diff-remove { color: #d98787; background: rgba(217,84,84,.08); }
.diff-context { color: var(--muted); }
.mutation-state { padding: 13px; border: 1px solid var(--line); border-radius: 9px; color: var(--muted); }
.redaction-row { display: grid; grid-template-columns: 140px minmax(0,1fr); gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
.redaction-row span { color: var(--muted); font-family: var(--mono); overflow-wrap: anywhere; }
.snippet-title mark { border-radius: 3px; background: rgba(255,255,255,.12); color: var(--text); }
.evidence-layout { display: grid; grid-template-columns: minmax(0,1fr) minmax(280px,360px); gap: 18px; }
.chip-list { display: flex; flex-wrap: wrap; gap: 7px; }
.chip { max-width: 100%; padding: 5px 8px; overflow: hidden; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); font: 11px var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.chip.danger { border-color: var(--danger-line); color: #db9292; }
.graph-entry { display: flex; align-items: center; justify-content: space-between; gap: 28px; }
.graph-entry h2 { margin: 0; font-size: 21px; letter-spacing: -.025em; }
.graph-entry p { max-width: 67ch; margin: 7px 0 0; color: var(--muted); }
.graph-entry-action { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; }
.graph-workspace { min-width: 0; }
.graph-view-head { display: flex; align-items: end; justify-content: space-between; gap: 28px; margin-bottom: 24px; }
.graph-view-head .eyebrow { margin-bottom: 9px; }
.graph-view-head h2 { max-width: 760px; margin: 0; font-size: clamp(27px, 3vw, 38px); line-height: 1.08; letter-spacing: -.04em; text-wrap: balance; }
.graph-view-head p { max-width: 700px; margin: 11px 0 0; color: var(--muted); font-size: 14px; text-wrap: pretty; }
.graph-controls { display: grid; grid-template-columns: minmax(230px,1.3fr) 120px 160px 230px minmax(220px,1fr); gap: 10px; margin-bottom: 12px; padding: 14px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.graph-control-field { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.graph-control-field .select-field { width: 100%; min-height: 44px; }
.control-label { color: var(--muted); font-size: 10px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; }
.scope-switch { display: grid; grid-template-columns: 1fr 1fr; min-height: 44px; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
.scope-button { min-width: 106px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; transition: color .18s var(--ease), background .18s var(--ease), transform .18s var(--ease); }
.scope-button:hover { color: var(--text-2); }
.scope-button.active { background: var(--surface-3); color: var(--text); }
.scope-button:active { transform: scale(.98); }
.graph-search-field { position: relative; align-self: end; }
.graph-search { padding-right: 90px; background: var(--bg-raised); }
.graph-match-count { position: absolute; right: 13px; top: 50%; transform: translateY(-50%); color: var(--quiet); font: 10px var(--mono); pointer-events: none; }
.graph-layout { display: grid; grid-template-columns: minmax(0,1fr) 320px; gap: 12px; align-items: stretch; }
.graph-canvas, .graph-inspector { min-width: 0; overflow: hidden; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.graph-canvas { display: flex; flex-direction: column; }
.graph-canvas-bar { min-height: 68px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 11px 13px 11px 16px; border-bottom: 1px solid var(--line); }
.graph-canvas-bar strong { display: block; overflow: hidden; color: var(--text-2); font-size: 13px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.graph-canvas-bar span { display: block; margin-top: 2px; color: var(--muted); font: 10px var(--mono); }
.graph-canvas-actions { display: flex; align-items: center; gap: 6px; }
.graph-canvas-actions .secondary-button, .graph-canvas-actions .quiet-button { min-height: 38px; padding-inline: 11px; font-size: 12px; }
.graph-canvas-actions .icon-button { width: 38px; min-height: 38px; }
.graph-canvas-fullscreen { display: inline-block; }
.graph-stage { position: relative; height: clamp(520px, 65vh, 720px); min-height: 520px; overflow: hidden; touch-action: none; background: radial-gradient(circle at 33% 12%, rgba(255,255,255,.038), transparent 38%), linear-gradient(rgba(255,255,255,.012) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.012) 1px, transparent 1px), var(--bg-raised); background-size: auto, 24px 24px, 24px 24px, auto; }
.graph-svg { display: block; width: 100%; height: 100%; cursor: grab; }
.graph-svg.panning { cursor: grabbing; }
.graph-edge { fill: none; stroke: #66666d; stroke-width: 1.45; stroke-linecap: round; opacity: .72; transition: opacity .16s, stroke-width .16s; }
.graph-edge.rel-wrote { stroke-dasharray: 2 2; }
.graph-edge.rel-committed { stroke-width: 1.8; }
.graph-edge.danger { stroke: var(--danger); stroke-width: 1.9; opacity: .9; }
.graph-edge.active { opacity: 1; stroke-width: 2.2; }
.graph-edge.dimmed { opacity: .08; }
.graph-node { cursor: pointer; opacity: 1; transition: opacity .16s; }
.graph-node rect { fill: #18181a; stroke: #45454a; stroke-width: 1.15; transition: fill .16s, stroke .16s, stroke-width .16s; }
.graph-node:hover rect { fill: #222225; stroke: #77777d; }
.graph-node.root rect { stroke: #96969c; stroke-width: 1.8; }
.graph-node.selected rect { fill: #242426; stroke: #f0f0f1; stroke-width: 2.2; }
.graph-node.danger rect { fill: #1b1112; stroke: var(--danger); stroke-width: 1.6; }
.graph-node.danger.selected rect { stroke: #f0b0b0; stroke-width: 2.2; }
.graph-node.dimmed { opacity: .13; }
.graph-node .node-kind-dot { fill: #29292d; stroke: #5f5f65; stroke-width: 1; }
.graph-node.kind-prompt .node-kind-dot { fill: #e5e5e7; stroke: #e5e5e7; }
.graph-node.kind-prompt .node-kind-mark { fill: #171718; }
.graph-node.kind-step .node-kind-dot { fill: #75757b; }
.graph-node.kind-file .node-kind-dot, .graph-node.kind-dir .node-kind-dot { fill: #3d3d42; }
.graph-node.kind-commit .node-kind-dot { fill: #a4a4aa; }
.graph-node.kind-finding .node-kind-dot, .graph-node.kind-host.danger .node-kind-dot { fill: var(--danger); stroke: var(--danger); }
.graph-node text { fill: var(--text-2); font: 11.5px var(--sans); pointer-events: none; }
.graph-node .node-kind-mark { fill: var(--text-2); font: 650 8px var(--mono); }
.graph-node .node-label { font-weight: 600; }
.graph-node .node-sub { fill: var(--muted); font-size: 9.5px; }
.graph-node .node-expand { fill: var(--muted); font-size: 15px; }
.graph-help { padding: 9px 14px; border-top: 1px solid var(--line); color: var(--quiet); font-size: 10px; }
.graph-legend { display: flex; flex-wrap: wrap; gap: 8px 14px; padding: 10px 14px 13px; border-top: 1px solid var(--line); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; }
.legend-dot { width: 8px; height: 8px; border: 1px solid #69696f; border-radius: 50%; background: #3b3b40; }
.legend-dot.kind-prompt { background: #e5e5e7; border-color: #e5e5e7; }
.legend-dot.kind-step { background: #75757b; }
.legend-dot.kind-commit { background: #a4a4aa; }
.legend-dot.kind-file, .legend-dot.kind-dir { border-radius: 2px; }
.legend-item.danger { color: #dc9696; }
.legend-item.danger .legend-dot { border-color: var(--danger); background: var(--danger); }
.graph-inspector { min-height: 100%; padding: 20px; overflow: auto; }
.inspector-empty { padding: 28px 4px 20px; }
.inspector-symbol { display: grid; place-items: center; width: 42px; height: 42px; margin-bottom: 18px; border: 1px solid var(--line-strong); border-radius: 11px; color: var(--muted); font-size: 20px; }
.inspector-empty h3, .inspector-top h3 { margin: 0; font-size: 19px; line-height: 1.25; letter-spacing: -.025em; overflow-wrap: anywhere; }
.inspector-empty p, .inspector-top p, .inspector-note { margin: 9px 0 0; color: var(--muted); font-size: 12px; line-height: 1.65; }
.inspector-kicker { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 12px; }
.kind-label, .root-label, .risk-label { padding: 3px 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--muted); font: 9px var(--mono); text-transform: uppercase; }
.root-label { border-color: var(--line-strong); color: var(--text-2); }
.risk-label { border-color: var(--danger-line); color: #df9797; }
.inspector-facts { display: grid; grid-template-columns: 86px minmax(0,1fr); gap: 6px 10px; margin: 19px 0 0; padding: 14px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); font-size: 11px; }
.inspector-facts dt { color: var(--muted); }
.inspector-facts dd { min-width: 0; margin: 0; overflow-wrap: anywhere; color: var(--text-2); font-family: var(--mono); }
.inspector-actions { display: flex; flex-wrap: wrap; gap: 6px; padding: 15px 0; border-bottom: 1px solid var(--line); }
.inspector-actions .secondary-button, .inspector-actions .quiet-button { min-height: 38px; padding-inline: 10px; font-size: 11px; }
.inspector-action-note { align-self: center; color: var(--quiet); font-size: 11px; }
.inspector-relations, .relation-guide { margin-top: 20px; }
.inspector-relations h4, .relation-guide h4 { margin: 0 0 8px; color: var(--muted); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.relation-row { width: 100%; min-height: 44px; display: grid; grid-template-columns: 76px minmax(0,1fr); align-items: center; gap: 8px; padding: 7px 5px; border: 0; border-top: 1px solid var(--line); background: transparent; color: var(--text-2); text-align: left; cursor: pointer; }
.relation-row:hover { background: rgba(255,255,255,.025); }
.relation-type { color: var(--quiet); font: 9px var(--mono); text-transform: uppercase; }
.relation-type.danger { color: #d98d8d; }
.relation-node { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.relation-guide-grid { display: grid; gap: 8px; }
.relation-guide-grid span { display: flex; align-items: center; gap: 9px; color: var(--muted); font-size: 10px; }
.edge-sample { width: 25px; height: 0; border-top: 1px solid #727278; }
.edge-sample.wrote { border-top-style: dashed; }
.edge-sample.committed { border-top-width: 2px; }
.edge-sample.danger { border-top: 2px solid var(--danger); }
.graph-empty { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px; color: var(--muted); text-align: center; }
.graph-empty h3 { margin: 0; color: var(--text-2); font-size: 17px; }
.graph-empty p { max-width: 420px; margin: 8px 0 16px; }
.graph-loading-line { width: 180px; height: 2px; overflow: hidden; background: var(--line); }
.graph-loading-line::after { content: ""; display: block; width: 45%; height: 100%; background: var(--text-2); animation: graphLoad 1.1s var(--ease) infinite; }
@keyframes graphLoad { from { transform: translateX(-110%); } to { transform: translateX(330%); } }
.graph-workspace:fullscreen { padding: 24px; overflow: auto; background: var(--bg); }
.graph-workspace:fullscreen .graph-stage { height: calc(100dvh - 294px); min-height: 460px; }
.drawer-backdrop { position: fixed; inset: 0; z-index: var(--z-drawer); background: rgba(0,0,0,.58); backdrop-filter: blur(3px); }
.evidence-drawer { position: fixed; z-index: calc(var(--z-drawer) + 1); top: 0; right: 0; width: min(620px, 92vw); height: 100dvh; overflow: auto; padding: 24px; border-left: 1px solid var(--line-strong); background: var(--surface); box-shadow: -28px 0 80px rgba(0,0,0,.45); animation: drawerIn .22s var(--ease) both; }
@keyframes drawerIn { from { opacity: 0; transform: translateX(24px); } }
.drawer-head { position: sticky; top: -24px; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: -24px -24px 22px; padding: 18px 24px; border-bottom: 1px solid var(--line); background: rgba(20,20,21,.94); backdrop-filter: blur(14px); }
.drawer-head h2 { margin: 0; font-size: 18px; }
.drawer-head-actions { display: flex; align-items: center; gap: 6px; }
.drawer-head-actions .quiet-button { min-height: 40px; font-size: 11px; }
.drawer-section { margin-top: 25px; }
.drawer-section h3 { margin: 0 0 9px; color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.drawer-section pre { max-height: 420px; margin: 0; overflow: auto; padding: 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--text-2); font: 12px/1.6 var(--mono); white-space: pre-wrap; word-break: break-word; }
.kv-grid { display: grid; grid-template-columns: 120px minmax(0,1fr); gap: 8px 14px; color: var(--text-2); }
.kv-grid dt { color: var(--muted); }
.kv-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-family: var(--mono); }
.toast { position: fixed; z-index: 80; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 11px 15px; border: 1px solid var(--line-strong); border-radius: 10px; background: var(--surface-2); color: var(--text-2); box-shadow: 0 16px 50px rgba(0,0,0,.4); }
@media (max-width: 1100px) {
  .graph-controls { grid-template-columns: minmax(230px,1fr) 140px minmax(190px,auto); }
  .graph-scope-field { grid-column: 1 / -1; }
  .graph-search-field { grid-column: 1 / -1; }
  .graph-layout { grid-template-columns: minmax(0,1fr) 280px; }
}
@media (max-width: 900px) {
  .topbar { grid-template-columns: 1fr auto auto; padding: 0 18px; }
  .topnav { display: flex; border: 0; padding: 0; background: transparent; }
  .nav-home, .nav-search span:nth-child(2), .nav-search kbd { display: none; }
  .nav-search { width: 42px; padding: 0; }
  .app-shell { width: min(100% - 32px, var(--content)); padding-top: 42px; }
  .overview-grid, .evidence-layout { grid-template-columns: 1fr; }
  .panel.wide { grid-column: auto; }
  .session-hero { grid-template-columns: 1fr; gap: 16px; }
  .risk-badge { justify-self: start; }
  .graph-layout { grid-template-columns: 1fr; }
  .graph-inspector { min-height: 320px; }
  .activity-toolbar { grid-template-columns: auto minmax(180px,1fr) auto; }
  .activity-toolbar .select-field { grid-column: 1; grid-row: 2; }
  .activity-toolbar .quiet-button { grid-column: 2; grid-row: 2; justify-self: start; }
  .activity-toolbar .toolbar-count { grid-column: 3; grid-row: 2; }
  .integrity-metrics { grid-template-columns: repeat(2,1fr); }
}
@media (max-width: 767px) {
  :root { --header: 56px; }
  .topbar { height: var(--header); gap: 10px; padding: 0 12px; }
  .brand { font-size: 14px; }
  .connection span:last-child, .event-total { display: none; }
  .topmeta { gap: 9px; }
  .profile-button { width: 36px; height: 36px; }
  .profile-popover { top: 52px; right: 12px; }
  .app-shell { width: calc(100% - 24px); padding: 17px 0 64px; }
  .hero { padding: 3px 0 0; }
  .hero h1 { font-size: clamp(31px, 10vw, 39px); }
  .hero p { font-size: 14px; }
  .home-search { height: 54px; padding-left: 46px; font-size: 14px; }
  .fleet-strip { flex-wrap: nowrap; margin-right: -12px; padding: 0 12px 6px 0; overflow-x: auto; }
  .section-block { margin-top: 24px; }
  .section-head { align-items: center; }
  .section-actions .icon-button { display: none; }
  .session-shelf { grid-auto-columns: min(78vw, 280px); margin-right: -12px; }
  .session-grid { grid-template-columns: 1fr; }
  .session-card { min-height: 250px; }
  .session-page > .back-link { min-height: 30px; }
  .session-hero { grid-template-columns: minmax(0,1fr) auto; gap: 10px; padding: 3px 0 10px; }
  .session-hero h1 { font-size: 25px; }
  .session-facts { gap: 3px 10px; margin-top: 5px; font-size: 11px; }
  .session-facts > span:nth-of-type(n+3) { display: none; }
  .risk-badge { align-self: center; justify-self: end; min-width: 0; padding: 7px 9px; font-size: 9px; }
  .session-detail-pop { right: 0; left: auto; }
  .graph-page .session-hero { grid-template-columns: minmax(0,1fr) auto; gap: 10px; padding: 8px 0 14px; }
  .graph-page .session-hero h1 { font-size: 27px; }
  .graph-page .session-facts { display: none; }
  .graph-page .risk-badge { align-self: center; justify-self: end; min-width: 0; padding: 8px 10px; font-size: 10px; }
  .tabs { top: var(--header); overflow-x: auto; margin-bottom: 12px; }
  .tab { flex: 1; justify-content: center; min-width: 84px; padding-inline: 10px; font-size: 13px; }
  .panel { padding: 18px; }
  .overview-grid, .evidence-layout { gap: 12px; }
  .overview-actions { margin-top: 14px; }
  .compact-fact { min-height: 68px; }
  .integrity-brief { align-items: flex-start; flex-direction: column; gap: 8px; }
  .metric { min-height: 86px; padding: 14px; }
  .toolbar { grid-template-columns: 1fr 1fr; }
  .toolbar .text-field { grid-column: 1 / -1; grid-row: 1; }
  .activity-toolbar { top: calc(var(--header) + 55px); }
  .activity-toolbar .secondary-button, .activity-toolbar .danger-button { grid-column: 1; grid-row: 2; }
  .activity-toolbar .select-field { grid-column: 2; grid-row: 2; min-width: 0; }
  .activity-toolbar .quiet-button { grid-column: 1; grid-row: 3; justify-self: stretch; }
  .activity-toolbar .toolbar-count { grid-column: 2; grid-row: 3; justify-self: end; }
  .turn-head { grid-template-columns: auto minmax(0,1fr); min-height: 68px; }
  .turn-meta { grid-column: 2; white-space: normal; }
  .turn-body { padding-left: 17px; }
  .turn-actions { justify-content: flex-start; }
  .step-row { grid-template-columns: 60px minmax(0,1fr); }
  .step-tool, .step-duration { display: none; }
  .graph-entry { align-items: flex-start; flex-direction: column; gap: 18px; }
  .graph-view-head { align-items: flex-start; flex-direction: column; gap: 16px; }
  .graph-view-head p, .graph-head-fullscreen { display: none; }
  .graph-controls { grid-template-columns: 1fr 1fr; padding: 11px; }
  .graph-controls > .graph-control-field:first-child, .graph-scope-field, .graph-search-field { grid-column: 1 / -1; }
  .scope-button { min-width: 0; }
  .graph-canvas-bar { align-items: flex-start; flex-direction: column; }
  .graph-canvas-actions { width: 100%; overflow-x: auto; padding-bottom: 2px; }
  .graph-canvas-actions .quiet-button { white-space: nowrap; }
  .graph-canvas-actions .graph-canvas-fullscreen { display: inline-block; }
  .graph-stage { height: 470px; min-height: 470px; }
  .graph-help { line-height: 1.5; }
  .graph-inspector { min-height: 0; padding: 18px; }
  .graph-workspace:fullscreen { padding: 12px; }
  .graph-workspace:fullscreen .graph-view-head { display: none; }
  .graph-workspace:fullscreen .graph-stage { height: 56dvh; min-height: 420px; }
  .evidence-drawer { top: auto; bottom: 0; width: 100%; height: min(88dvh, 760px); border-top: 1px solid var(--line-strong); border-left: 0; border-radius: 18px 18px 0 0; animation-name: sheetIn; }
  @keyframes sheetIn { from { opacity: 0; transform: translateY(28px); } }
  .kv-grid { grid-template-columns: 1fr; gap: 2px; }
  .kv-grid dd { margin-bottom: 10px; }
  .evidence-section-head { align-items: stretch; flex-direction: column; }
  .evidence-search { max-width: none; }
  .containment-item { grid-template-columns: 48px minmax(0,1fr); }
  .containment-item .row-count { grid-column: 2; }
  .integrity-metrics { grid-template-columns: repeat(2,1fr); }
  .reconciliation-summary, .redaction-row { grid-template-columns: 1fr; gap: 3px; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; }
}
`;
