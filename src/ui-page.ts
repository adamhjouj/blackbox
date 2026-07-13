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
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="A local forensic record of AI coding sessions">
<meta name="theme-color" content="#0a0a0a">
<title>Blackbox</title>
<style>${UI_CSS}</style>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>
<header class="topbar">
  <a class="brand" href="#/" aria-label="Blackbox home"><span class="brand-mark" aria-hidden="true"></span><span>blackbox</span></a>
  <nav class="topnav" aria-label="Primary">
    <a class="nav-home" href="#/">Home</a>
    <button class="nav-search" id="globalSearch" type="button" aria-label="Search sessions"><span aria-hidden="true">⌕</span><span>Search</span><kbd>⌘ K</kbd></button>
  </nav>
  <div class="topmeta">
    <span class="connection" id="connection"><span class="status-dot" aria-hidden="true"></span><span id="connectionLabel">Connecting</span></span>
    <span class="event-total"><span id="eventCount">—</span> events</span>
    <button class="profile-button" id="profileButton" type="button" aria-label="Edit display name"><span id="profileInitial">?</span></button>
  </div>
</header>
<div id="profilePopover" class="profile-popover" hidden></div>
<div id="connectionAlert" class="connection-alert" role="status" aria-live="polite" hidden></div>
<main id="main-content" tabindex="-1"><div id="app" class="app-shell"></div></main>
<div id="drawerRoot"></div>
<div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
<script>${CORE_JS}${DASHBOARD_JS}${SESSION_JS}${EVIDENCE_JS}${GRAPH_JS}${BOOT_JS}</script>
</body>
</html>`;
}
