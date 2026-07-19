import { UI_CSS } from './ui/styles';
import { CORE_JS, BOOT_JS } from './ui/state-router';
import { DASHBOARD_JS } from './ui/dashboard';
import { SESSION_JS } from './ui/session';
import { EVIDENCE_JS } from './ui/evidence';
import { GRAPH_JS } from './ui/graph';

/**
 * The Blackbox viewer is still shipped as one self-contained document. Source is
 * split by responsibility so navigation, dashboard, session, evidence, and graph
 * work can evolve independently without weakening the page's hostile-data rules.
 * Every recorded value is rendered by the client through textContent/DOM nodes.
 *
 * The chrome is a persistent left console rail: brand, global search, Dashboard,
 * a NEEDS REVIEW queue, and RECENT sessions. Its static shell lives here so the
 * search input never loses focus to a re-render; only the lists are re-drawn.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="A local forensic record of AI coding sessions">
<meta name="theme-color" content="#070708">
<title>Blackbox</title>
<style>${UI_CSS}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<div id="profilePopover" class="profile-popover" hidden></div>
<aside class="sidebar" aria-label="Blackbox console">
  <a class="sb-brand" href="#/" aria-label="Blackbox home"><span class="sb-logo" aria-hidden="true"></span><span class="sb-word">BLACKBOX</span></a>
  <div class="sb-search"><input id="sbSearch" class="text-field" type="search" placeholder="Search sessions, prompts, evidence…" autocomplete="off" spellcheck="false" aria-label="Search sessions, prompts, and evidence"></div>
  <nav class="sb-nav"><a id="navDash" class="sb-dash nav-home" href="#/"><span class="sb-glyph" aria-hidden="true">◈</span>Dashboard</a></nav>
  <div class="sb-scroll"><div id="sbReview"></div><div id="sbRecent"></div></div>
  <div class="sb-status"><span id="connection" class="sb-dot" aria-hidden="true"></span><span id="connectionLabel">Connecting</span><span aria-hidden="true">·</span><span id="eventCount">—</span><span>events</span></div>
</aside>
<main id="main-content" tabindex="-1">
<div id="connectionAlert" class="connection-alert" role="status" aria-live="polite" hidden></div>
<div id="app" class="app-shell"></div>
</main>
<div id="drawerRoot"></div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<script>${CORE_JS}${DASHBOARD_JS}${SESSION_JS}${EVIDENCE_JS}${GRAPH_JS}${BOOT_JS}</script>
</body>
</html>`;
}
