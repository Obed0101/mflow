/**
 * Dashboard HTML template for the mflow signaling server.
 * Pure HTML + CSS + vanilla JS — no frameworks, no build step.
 */
export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mflow dashboard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #09090b;
      --bg-card: rgba(24, 24, 27, 0.4);
      --border: rgba(255, 255, 255, 0.1);
      --border-hover: rgba(255, 255, 255, 0.2);
      --text: #f8fafc;
      --text-muted: #a1a1aa;
      --green: #10b981;
      --green-glow: rgba(16, 185, 129, 0.15);
      --red: #ef4444;
      --blue: #3b82f6;
      --mono: 'JetBrains Mono', monospace;
      --sans: 'Inter', sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background:
        radial-gradient(circle at 20% -10%, rgba(52,211,153,.12), transparent 32%),
        var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
      display: block;
    }
    .app-shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 236px 1fr;
    }
    .sidebar {
      position: sticky;
      top: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      padding: 28px 18px;
      border-right: 1px solid var(--border);
      background: rgba(8, 9, 13, .74);
    }
    .side-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      color: var(--text);
      text-decoration: none;
      font-size: 20px;
      font-weight: 800;
      letter-spacing: -.045em;
      margin: 0 10px 32px;
    }
    .side-brand::before {
      content: '';
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--green);
      box-shadow: 0 0 18px rgba(52,211,153,.9);
    }
    .side-nav {
      display: grid;
      gap: 8px;
    }
    .side-link {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 42px;
      padding: 0 12px;
      border: 1px solid transparent;
      border-radius: 12px;
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 750;
      transition: background .16s ease, border-color .16s ease, color .16s ease;
    }
    .side-link svg { width: 18px; height: 18px; fill: currentColor; }
    .side-link:hover,
    .side-link[aria-current="page"] {
      color: var(--text);
      border-color: var(--border);
      background: rgba(255,255,255,.045);
    }
    .side-spacer { flex: 1; }
    .side-user {
      display: grid;
      gap: 10px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .side-user-card {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px;
      border: 1px solid var(--border);
      border-radius: 14px;
      background: rgba(255,255,255,.035);
    }
    .side-user-card img {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      border: 1px solid var(--border);
    }
    .side-user-card span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 800;
    }
    .side-actions {
      display: flex;
      gap: 8px;
    }
    .side-actions a {
      flex: 1;
      min-height: 38px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--border);
      border-radius: 11px;
      background: rgba(255,255,255,.035);
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 800;
      transition: color .16s, border-color .16s, background .16s;
    }
    .side-actions a:hover {
      color: var(--text);
      border-color: var(--border-hover);
      background: rgba(255,255,255,.06);
    }
    .github-link svg { width: 18px; height: 18px; fill: currentColor; }

    /* ── Top Navigation ────────────────────────── */
    .topnav {
      height: 64px;
      border-bottom: 1px solid var(--border);
      background: rgba(8, 9, 13, 0.78);
      backdrop-filter: blur(18px);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .topnav-inner {
      max-width: 1120px;
      height: 100%;
      margin: 0 auto;
      padding: 0 24px;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      gap: 16px;
    }
    .topnav-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 800;
      font-size: 17px;
      letter-spacing: -.04em;
      color: var(--text);
      text-decoration: none;
    }
    .topnav-brand::before {
      content: '';
      display: block;
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 18px rgba(52,211,153,.9);
    }
    .topnav-status {
      justify-self: center;
      color: var(--text-muted);
      font: 600 12px var(--mono);
      letter-spacing: .02em;
    }
    .topnav-links {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    .topnav-links a {
      color: var(--text);
      text-decoration: none;
      font-size: 13px;
      font-weight: 700;
      transition: transform .16s ease, border-color .16s ease, background .16s ease;
    }
    .topnav-links a:hover { transform: translateY(-1px); }
    .topnav-cta {
      color: #050607 !important;
      background: #f6f7f4;
      border-radius: 10px;
      padding: 9px 14px;
      font-weight: 800 !important;
    }
    .icon-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255,255,255,.04);
    }
    .icon-link svg { width: 18px; height: 18px; fill: currentColor; }
    .nav-link {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: rgba(255,255,255,.04);
    }
    .nav-link svg { width: 18px; height: 18px; fill: currentColor; }
    .user-menu {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 6px 4px 4px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(255,255,255,0.03);
    }
    .user-menu img {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      border: 1px solid var(--border);
    }
    .user-login {
      max-width: 120px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
    }
    .signout-link {
      color: var(--text-muted) !important;
      font-size: 12px !important;
      padding: 0 6px;
    }
    .settings-toggle {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 8px;
      padding: 7px 10px;
      font-weight: 700;
      cursor: pointer;
    }

    /* ── Main Content ──────────────────────────── */
    .main {
      flex: 1;
      padding: 56px 48px;
      max-width: 1000px;
      width: 100%;
      margin: 0;
    }

    /* ── Stats Header ──────────────────────────── */
    .stats-header {
      display: flex;
      gap: 24px;
      margin-bottom: 32px;
      flex-wrap: wrap;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 120px;
      padding: 16px 20px;
      background: rgba(255,255,255,0.02);
      border: 1px solid var(--border);
      border-radius: 12px;
    }
    .stat-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      font-size: 20px;
      font-weight: 700;
      font-family: var(--mono);
      color: #fff;
    }

    /* ── Cards ─────────────────────────────────── */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 32px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 16px;
      font-weight: 600;
      color: #fff;
      margin-bottom: 16px;
    }

    /* ── Forms & Inputs ────────────────────────── */
    .input-group {
      display: flex;
      gap: 12px;
      max-width: 500px;
    }
    input {
      flex: 1;
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 16px;
      color: #fff;
      font-family: var(--sans);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus { border-color: var(--green); }
    .btn {
      background: #fff;
      color: #000;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: opacity 0.2s;
      white-space: nowrap;
    }
    .btn:hover { opacity: 0.9; }
    .btn-outline {
      background: transparent;
      color: #fff;
      border: 1px solid var(--border);
    }
    .btn-outline:hover { background: rgba(255,255,255,0.05); }

    /* ── Room Data ─────────────────────────────── */
    .room-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
      margin-bottom: 24px;
    }
    .room-id {
      font-family: var(--mono);
      font-size: 15px;
      font-weight: 700;
      color: var(--green);
    }
    .peers-list {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 32px;
    }
    .peer-chip {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(0,0,0,0.3);
      border: 1px solid var(--border);
      padding: 6px 12px;
      border-radius: 100px;
      font-size: 13px;
      font-family: var(--mono);
    }
    .peer-type {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .peer-type.agent { background: rgba(59,130,246,0.15); color: var(--blue); }
    .peer-type.human { background: rgba(16,185,129,0.15); color: var(--green); }

    /* ── Activity Feed ─────────────────────────── */
    .activity-feed {
      display: flex;
      flex-direction: column;
    }
    .activity-row {
      display: grid;
      grid-template-columns: 80px 1fr auto 200px;
      gap: 16px;
      align-items: center;
      padding: 12px 0;
      border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .activity-row:last-child { border-bottom: none; }
    .activity-time { font-size: 12px; color: var(--text-muted); font-family: var(--mono); }
    .activity-peer { font-weight: 500; color: #fff; }
    .activity-action { font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .action-synced { color: var(--green); }
    .action-created { color: var(--blue); }
    .action-deleted { color: var(--red); }
    .activity-file { font-family: var(--mono); font-size: 12px; color: var(--text-muted); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .hidden { display: none !important; }
    .error-msg { color: var(--red); font-size: 13px; margin-top: 12px; }

    @media (max-width: 640px) {
      .app-shell { grid-template-columns: 1fr; }
      .sidebar {
        position: static;
        height: auto;
        padding: 16px;
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }
      .side-brand { margin-bottom: 14px; }
      .side-nav { grid-template-columns: 1fr 1fr; }
      .side-spacer { display: none; }
      .side-user { margin-top: 12px; }
      .main { padding: 28px 16px; }
      .topnav-inner { grid-template-columns: 1fr auto; }
      .topnav-status { display: none; }
      .user-login, .signout-link { display: none; }
      .activity-row { grid-template-columns: 60px 1fr auto; }
      .activity-file { display: none; }
      .input-group { flex-direction: column; }
    }
  </style>
</head>
<body>

  <div class="app-shell">
    <aside class="sidebar">
      <a href="/" class="side-brand">mflow</a>
      <nav class="side-nav" aria-label="Dashboard navigation">
        <a class="side-link" href="/dashboard" aria-current="page">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z"/></svg>
          Dashboard
        </a>
        <a class="side-link" href="/settings">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.4h-4L9.6 5a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8 8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
          Settings
        </a>
      </nav>
      <div class="side-spacer"></div>
      <div class="side-user">
        <div id="user-info" class="side-user-card hidden">
          <img id="user-avatar" src="" alt="">
          <span id="user-login"></span>
        </div>
        <div class="side-actions">
          <a href="#" id="auth-logout-btn">Sign out</a>
          <a class="github-link" href="https://github.com/Obed0101/mflow" target="_blank" rel="noreferrer" aria-label="Open mflow on GitHub">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg>
          </a>
        </div>
      </div>
    </aside>

  <main class="main">

    <div class="stats-header">
      <div class="stat-item">
        <span class="stat-label">Relay Status</span>
        <span class="stat-value" style="color: var(--green)" id="status-text">Online</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Active Rooms</span>
        <span class="stat-value" id="room-count">-</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Total Peers</span>
        <span class="stat-value" id="peer-count">-</span>
      </div>
      <div class="stat-item">
        <span class="stat-label">Uptime</span>
        <span class="stat-value" id="uptime">--</span>
      </div>
    </div>

    <!-- Auth Gate -->
    <div id="github-gate" class="card hidden" style="text-align: center; padding: 64px 24px;">
      <h2 style="font-size: 20px; font-weight: 600; color: #fff; margin-bottom: 12px;">GitHub Authentication Required</h2>
      <p style="color: var(--text-muted); margin-bottom: 32px;">This relay requires you to sign in before accessing the dashboard.</p>
      <button class="btn" id="github-login-btn">Sign in with GitHub</button>
      <div id="device-box" class="hidden" style="margin-top: 32px; padding: 24px; background: rgba(0,0,0,0.5); border-radius: 12px; border: 1px solid var(--border);"></div>
    </div>

    <!-- Room Gate -->
    <div id="room-gate" class="card">
      <h2 class="card-title">Monitor Room</h2>
      <p style="color: var(--text-muted); font-size: 13px; margin-bottom: 20px;">Enter your room secret to view live peers and file activity.</p>

      <div id="login-row" class="input-group">
        <input type="password" id="secret-input" placeholder="Room Secret..." autocomplete="off">
        <button class="btn" id="login-btn">Connect</button>
      </div>

      <div id="room-badge-row" class="hidden" style="display:flex; align-items:center; justify-content:space-between;">
        <span class="room-id" id="active-room-id">--</span>
        <button class="btn btn-outline" id="logout-btn" style="padding: 6px 12px; font-size: 12px;">Disconnect</button>
      </div>

      <div id="error-banner" class="error-msg hidden"></div>
    </div>

    <!-- Room Data -->
    <div id="room-data" class="hidden">
      <div class="card">
        <h3 style="font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 16px;">Connected Peers</h3>
        <div id="peers-container" class="peers-list"></div>

        <h3 style="font-size: 13px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 16px; margin-top: 16px;">Recent Activity</h3>
        <div id="activity-feed" class="activity-feed"></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:28px;">
          <div style="border:1px solid var(--border);border-radius:10px;padding:18px;background:rgba(0,0,0,0.18);">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">File tree</div>
            <div id="file-tree" style="font-size:13px;color:var(--text-muted);display:grid;gap:6px;"></div>
          </div>
          <div style="border:1px solid var(--border);border-radius:10px;padding:18px;background:rgba(0,0,0,0.18);">
            <div style="font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Changed files</div>
            <div id="changed-files" style="font-size:13px;color:var(--text-muted);display:grid;gap:8px;"></div>
          </div>
        </div>
      </div>
    </div>

  </main>
  </div>

  <script>
    (function() {
      var lastFetch = 0;
      var consecutiveErrors = 0;
      var mode = 'public';
      var roomParam = null;
      var secretHash = null;
      var hadActiveRoom = false;
      var knownActivityIds = {};
      var authRequired = false;
      var authenticated = false;
      var authPollTimer = null;

      function sha256(str) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function(buf) {
          var arr = new Uint8Array(buf);
          var hex = '';
          for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
          return hex;
        });
      }

      function getUrlRoom() {
        try {
          return new URL(window.location.href).searchParams.get('room');
        } catch (_) {
          return null;
        }
      }

      function setUrlRoom(room) {
        try {
          var url = new URL(window.location.href);
          if (room) {
            url.searchParams.set('room', room);
          } else {
            url.searchParams.delete('room');
          }
          history.replaceState({}, '', url.toString());
        } catch (_) {}
      }

      function storageKey(room) {
        return room ? 'mflow_dash:' + room : 'mflow_dash';
      }

      function loadSession() {
        try {
          roomParam = getUrlRoom();
          var raw = sessionStorage.getItem(storageKey(roomParam));
          if (!raw) return;
          var saved = JSON.parse(raw);
          if (saved && saved.mode === 'room' && typeof saved.secretHash === 'string' && saved.secretHash.length === 64) {
            mode = 'room';
            secretHash = saved.secretHash;
            if (saved.room) roomParam = saved.room;
          }
        } catch (_) {}
      }

      function saveSession() {
        try {
          if (mode === 'room' && secretHash) {
            sessionStorage.setItem(storageKey(roomParam), JSON.stringify({ mode: mode, room: roomParam, secretHash: secretHash }));
          } else {
            sessionStorage.removeItem(storageKey(roomParam));
          }
        } catch (_) {}
      }

      function esc(str) {
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
      }

      function formatUptime(sec) {
        if (sec < 60) return sec + 's';
        if (sec < 3600) return Math.floor(sec / 60) + 'm';
        return Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
      }

      function relativeTime(ts) {
        var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diff < 60) return diff + 's';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        return Math.floor(diff / 3600) + 'h';
      }

      function buildChangedFiles(entries) {
        var latest = {};
        entries.forEach(function(entry) {
          var existing = latest[entry.file];
          if (!existing || existing.timestamp < entry.timestamp) latest[entry.file] = entry;
        });
        return Object.values(latest).sort(function(a, b) { return b.timestamp - a.timestamp; });
      }

      function buildTreeLines(files) {
        var root = {};
        files.forEach(function(file) {
          var parts = file.split('/').filter(Boolean);
          var node = root;
          for (var i = 0; i < parts.length; i++) {
            var part = parts[i];
            if (!node[part]) node[part] = { __children: {}, __leaf: i === parts.length - 1 };
            if (i === parts.length - 1) {
              node[part].__leaf = true;
            } else {
              node = node[part].__children;
            }
          }
        });

        var lines = [];
        function walk(children, depth) {
          Object.keys(children).sort().forEach(function(key) {
            var item = children[key];
            var indent = new Array(depth + 1).join('&nbsp;&nbsp;&nbsp;');
            var icon = item.__leaf ? '•' : '▾';
            lines.push('<div style="font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + indent + icon + ' ' + esc(key) + '</div>');
            if (!item.__leaf) walk(item.__children, depth + 1);
          });
        }
        walk(root, 0);
        return lines;
      }

      function updateUI() {
        var githubGate = document.getElementById('github-gate');
        var roomGate = document.getElementById('room-gate');
        var loginRow = document.getElementById('login-row');
        var badgeRow = document.getElementById('room-badge-row');
        var roomData = document.getElementById('room-data');
        var userInfo = document.getElementById('user-info');
        if (authenticated) { userInfo.classList.remove('hidden'); } else { userInfo.classList.add('hidden'); }

        if (authRequired && !authenticated) {
          githubGate.classList.remove('hidden');
          roomGate.classList.add('hidden');
          roomData.classList.add('hidden');
          return;
        }

        githubGate.classList.add('hidden');
        roomGate.classList.remove('hidden');

        if (mode === 'room') {
          loginRow.classList.add('hidden');
          badgeRow.classList.remove('hidden');
          roomData.classList.remove('hidden');
        } else {
          loginRow.classList.remove('hidden');
          badgeRow.classList.add('hidden');
          roomData.classList.add('hidden');
        }
      }

      function refresh() {
        var globalRequest = fetch('/api/rooms')
          .then(function(res) {
            if (res.status === 401) { authenticated = false; updateUI(); return null; }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          });

        var roomRequest = (mode === 'room' && secretHash)
          ? fetch('/api/rooms', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ secretHash: secretHash })
            }).then(function(res) {
              if (res.status === 401) { authenticated = false; updateUI(); return null; }
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.json();
            })
          : Promise.resolve(null);

        Promise.all([globalRequest, roomRequest])
          .then(function(results) {
            var globalData = results[0];
            var roomData = results[1];
            if (!globalData) return;
            consecutiveErrors = 0;
            document.getElementById('status-text').textContent = 'Online';
            document.getElementById('status-text').style.color = 'var(--green)';
            document.getElementById('uptime').textContent = formatUptime(globalData.uptime);
            document.getElementById('room-count').textContent = globalData.totalRooms;
            document.getElementById('peer-count').textContent = globalData.totalPeers;
            document.getElementById('error-banner').classList.add('hidden');

            if (mode === 'room' && roomData && roomData.rooms && roomData.rooms.length > 0) {
              var room = roomData.rooms[0];
              hadActiveRoom = true;
              roomParam = room.id;
              setUrlRoom(room.id);
              saveSession();
              document.getElementById('active-room-id').textContent = 'Room: ' + room.id.substring(0, 16) + '...';

              var pCont = document.getElementById('peers-container');
              var pHtml = '';
              room.peers.forEach(function(p) {
                var tc = p.peerType === 'agent' ? 'agent' : 'human';
                pHtml += '<div class="peer-chip"><span class="peer-type ' + tc + '">' + p.peerType + '</span>' + esc(p.peerName) + '</div>';
              });
              pCont.innerHTML = pHtml || '<span style="color:var(--text-muted)">No peers connected</span>';

              var aCont = document.getElementById('activity-feed');
              var aHtml = '';
              var entries = room.activity || [];
              entries.sort((a,b) => b.timestamp - a.timestamp).slice(0, 20).forEach(function(e) {
                aHtml += '<div class="activity-row">';
                aHtml += '<span class="activity-time">' + relativeTime(e.timestamp) + ' ago</span>';
                aHtml += '<span class="activity-peer">' + esc(e.peerName) + '</span>';
                aHtml += '<div><span class="activity-action action-' + e.action + '">' + e.action + '</span></div>';
                aHtml += '<span class="activity-file" title="' + esc(e.file) + '">' + esc(e.file) + '</span>';
                aHtml += '</div>';
              });
              aCont.innerHTML = aHtml || '<div style="color:var(--text-muted); padding: 20px 0;">No recent activity</div>';

              var changedFiles = buildChangedFiles(entries);
              var changedCont = document.getElementById('changed-files');
              changedCont.innerHTML = changedFiles.length
                ? changedFiles.slice(0, 12).map(function(entry) {
                    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;font-family:var(--mono);"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(entry.file) + '</span><span class="activity-action action-' + entry.action + '">' + entry.action + '</span></div>';
                  }).join('')
                : '<div style="color:var(--text-muted);">No changed files yet</div>';

              var treeCont = document.getElementById('file-tree');
              var treeLines = buildTreeLines(changedFiles.map(function(entry) { return entry.file; }));
              treeCont.innerHTML = treeLines.length ? treeLines.join('') : '<div style="color:var(--text-muted);">No file tree yet</div>';
            } else if (mode === 'room') {
               if (hadActiveRoom) {
                 hadActiveRoom = false;
                 mode = 'public';
                 secretHash = null;
                 setUrlRoom(null);
                 saveSession();
                 document.getElementById('error-banner').textContent = 'Room disconnected';
                 document.getElementById('error-banner').classList.remove('hidden');
                 updateUI();
                 return;
               }
               // Room empty or secret invalid
               document.getElementById('active-room-id').textContent = 'Room empty or invalid secret';
               document.getElementById('peers-container').innerHTML = '<span style="color:var(--text-muted)">No peers connected</span>';
               document.getElementById('activity-feed').innerHTML = '<div style="color:var(--text-muted); padding: 20px 0;">No recent activity</div>';
               document.getElementById('changed-files').innerHTML = '<div style="color:var(--text-muted);">No changed files yet</div>';
               document.getElementById('file-tree').innerHTML = '<div style="color:var(--text-muted);">No file tree yet</div>';
            }
          })
          .catch(function(err) {
            consecutiveErrors++;
            document.getElementById('status-text').textContent = 'Error';
            document.getElementById('status-text').style.color = 'var(--red)';
          });
      }

      function loadAuthConfig() {
        return fetch('/api/auth/config')
          .then(function(res) { return res.json(); })
          .then(function(config) {
            authRequired = !!config.required;
            authenticated = !!config.authenticated;
            if (authenticated && config.user) {
                document.getElementById('user-avatar').src = config.user.avatarUrl;
                document.getElementById('user-login').textContent = config.user.login;
            }
          });
      }

      document.getElementById('login-btn').onclick = function() {
        var val = document.getElementById('secret-input').value.trim();
        if (!val) return;
        sha256(val).then(function(hash) {
          secretHash = hash;
          fetch('/api/rooms', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secretHash: secretHash })
          })
            .then(function(res) {
              if (!res.ok) throw new Error('invalid');
              return res.json();
            })
            .then(function(data) {
              if (!data || !data.rooms || data.rooms.length === 0) {
                throw new Error('invalid');
              }
              roomParam = data.rooms[0].id;
              setUrlRoom(roomParam);
              hadActiveRoom = true;
              mode = 'room';
              saveSession();
              updateUI();
              refresh();
            })
            .catch(function() {
              mode = 'public';
              secretHash = null;
              document.getElementById('error-banner').textContent = 'Invalid secret or empty room';
              document.getElementById('error-banner').classList.remove('hidden');
              updateUI();
            });
        });
      };

      document.getElementById('secret-input').onkeydown = function(e) {
        if (e.key === 'Enter') document.getElementById('login-btn').click();
      };

      document.getElementById('logout-btn').onclick = function() {
        mode = 'public'; secretHash = null;
        setUrlRoom(null);
        saveSession(); updateUI();
        document.getElementById('secret-input').value = '';
        refresh();
      };

      document.getElementById('github-login-btn').onclick = function() {
        window.location.href = '/auth/github/start';
      };

      document.getElementById('auth-logout-btn').onclick = function(e) {
        e.preventDefault();
        fetch('/api/auth/logout', { method: 'POST' }).then(() => location.reload());
      };


      loadSession();
      loadAuthConfig().then(function() {
        updateUI();
        refresh();
        setInterval(refresh, 2000);
      });
    })();
  </script>
</body>
</html>`;
}

export function getDashboardAuthHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mflow dashboard sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      color-scheme: dark;
      --bg: #08090d;
      --panel: #111318;
      --line: #252a33;
      --text: #f5f7f2;
      --muted: #9ca3af;
      --green: #10b981;
      --red: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      background:
        radial-gradient(circle at 50% 4%, rgba(16,185,129,.11), transparent 28%),
        radial-gradient(rgba(148,163,184,.12) 1px, transparent 1px),
        var(--bg);
      background-size: auto, 24px 24px;
      color: var(--text);
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { width: min(440px, 100%); }
    .brand {
      display: block;
      width: fit-content;
      margin: 0 auto 22px;
      color: var(--text);
      font-size: 30px;
      font-weight: 800;
      letter-spacing: -.04em;
      text-decoration: none;
    }
    .card {
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--panel);
      box-shadow: 0 24px 80px rgba(0,0,0,.42);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 23px;
      line-height: 1.1;
      letter-spacing: -.035em;
    }
    p {
      margin: 0 0 24px;
      max-width: 46ch;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
    }
    .button {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 12px 16px;
      border: 1px solid #303746;
      border-radius: 10px;
      background: #0c1016;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-weight: 750;
      transition: transform .15s ease, border-color .15s ease, background .15s ease;
    }
    .button:hover {
      transform: translateY(-1px);
      border-color: var(--green);
      background: #141922;
    }
    .button svg { width: 18px; height: 18px; fill: currentColor; }
    .device {
      margin-top: 18px;
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: #080a0f;
      color: var(--muted);
      line-height: 1.55;
    }
    .device a { color: var(--text); text-decoration: underline; text-decoration-color: rgba(245,247,242,.35); text-underline-offset: 3px; }
    .device a:hover { text-decoration-color: var(--green); }
    .error-title { color: var(--red); font-weight: 800; margin-bottom: 6px; }
    .note {
      margin: 16px 0 0;
      color: #6b7280;
      font-size: 12px;
      text-align: center;
    }
    .home {
      display: block;
      width: fit-content;
      margin: 18px auto 0;
      color: var(--muted);
      font-size: 13px;
      text-decoration: none;
    }
    .home:hover { color: var(--text); }
  </style>
</head>
<body>
  <main>
    <a class="brand" href="/">mflow</a>
    <section class="card">
      <h1>Dashboard sign in</h1>
      <p>Sign in with GitHub, then enter your room secret to view room-scoped relay status.</p>
      <a class="button" href="/auth/github/start" aria-label="Sign in with GitHub">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg>
        Sign in with GitHub
      </a>
      <p class="note">Self-hosted relays can keep dashboard auth disabled.</p>
    </section>
    <a class="home" href="/" rel="noreferrer">Back to home</a>
  </main>
</body>
</html>`;
}

export function getSettingsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>mflow settings</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{color-scheme:dark;--bg:#08090b;--panel:rgba(24,24,27,.42);--line:rgba(255,255,255,.1);--line2:rgba(255,255,255,.18);--text:#f6f7f4;--muted:#9ca3af;--green:#34d399;--red:#f87171;--mono:'JetBrains Mono',monospace;--sans:'Inter',system-ui,sans-serif}*{box-sizing:border-box;margin:0;padding:0}body{min-height:100vh;background:radial-gradient(circle at 20% -10%,rgba(52,211,153,.12),transparent 32%),var(--bg);color:var(--text);font-family:var(--sans);-webkit-font-smoothing:antialiased}a{color:inherit;text-decoration:none}.app-shell{min-height:100vh;display:grid;grid-template-columns:236px 1fr}.sidebar{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;padding:28px 18px;border-right:1px solid var(--line);background:rgba(8,9,13,.74)}.side-brand{display:flex;align-items:center;gap:10px;color:var(--text);font-size:20px;font-weight:800;letter-spacing:-.045em;margin:0 10px 32px}.side-brand:before{content:'';width:9px;height:9px;border-radius:999px;background:var(--green);box-shadow:0 0 18px rgba(52,211,153,.9)}.side-nav{display:grid;gap:8px}.side-link{display:flex;align-items:center;gap:10px;min-height:42px;padding:0 12px;border:1px solid transparent;border-radius:12px;color:var(--muted);font-weight:750;transition:background .16s,border-color .16s,color .16s}.side-link svg{width:18px;height:18px;fill:currentColor}.side-link:hover,.side-link[aria-current=page]{color:var(--text);border-color:var(--line);background:rgba(255,255,255,.045)}.side-spacer{flex:1}.side-user{display:grid;gap:10px;padding-top:16px;border-top:1px solid var(--line)}.side-user-card{display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--line);border-radius:14px;background:rgba(255,255,255,.035)}.side-user-card img{width:30px;height:30px;border-radius:10px;border:1px solid var(--line)}.side-user-card span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:800}.side-actions{display:flex;gap:8px}.side-actions a,.side-actions button{flex:1;min-height:38px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);border-radius:11px;background:rgba(255,255,255,.035);color:var(--muted);font:inherit;font-weight:800;cursor:pointer}.side-actions a:hover,.side-actions button:hover{color:var(--text);border-color:var(--line2);background:rgba(255,255,255,.06)}.github-link svg{width:18px;height:18px;fill:currentColor}main{max-width:1180px;padding:46px 54px 80px}.back{display:inline-flex;align-items:center;gap:8px;width:fit-content;margin-bottom:30px;color:var(--muted);font-size:13px;font-weight:800}.back svg{width:17px;height:17px}.back:hover{color:var(--text)}.eyebrow{color:var(--green);font:700 12px var(--mono);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}h1{font-size:clamp(38px,5vw,70px);line-height:1;letter-spacing:-.06em;margin-bottom:22px}p{color:var(--muted);font-size:16px;line-height:1.6}.hero{margin-bottom:48px;animation:rise .32s ease both}.grid{display:grid;grid-template-columns:.85fr 1.15fr;gap:18px}.card{border:1px solid var(--line);border-radius:18px;background:var(--panel);box-shadow:0 20px 70px rgba(0,0,0,.28);padding:24px;animation:rise .38s ease both}.card h2{font-size:17px;margin-bottom:20px;letter-spacing:-.02em}.account{display:flex;align-items:center;gap:16px;margin-bottom:26px}.account img{width:58px;height:58px;border-radius:16px;border:1px solid var(--line2)}.account strong{display:block;font-size:20px}.form{display:grid;grid-template-columns:1fr auto auto;gap:10px;margin-bottom:20px}input,select{width:100%;background:#0b0d12;border:1px solid var(--line);border-radius:12px;color:var(--text);padding:12px 14px;font:inherit;outline:0}input:focus,select:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(52,211,153,.12)}.btn{border:0;border-radius:12px;background:#f6f7f4;color:#050607;padding:12px 16px;font:inherit;font-weight:850;cursor:pointer}.btn.ghost{background:transparent;color:var(--text);border:1px solid var(--line)}.btn.danger{background:rgba(248,113,113,.12);color:#fecaca;border:1px solid rgba(248,113,113,.22)}.key-once{display:none;margin:10px 0 18px;padding:14px;border:1px solid rgba(52,211,153,.28);background:rgba(52,211,153,.08);border-radius:14px}.key-once code{display:block;overflow:auto;font-family:var(--mono);font-size:13px;margin:8px 0}.row{display:grid;grid-template-columns:1fr 110px 110px 110px auto;gap:12px;align-items:center;padding:12px 0;border-top:1px solid rgba(255,255,255,.07);font-size:13px}.row .name{font-weight:750}.muted{color:var(--muted)}.suffix{font-family:var(--mono);color:var(--text)}.note{display:grid;gap:12px;color:var(--muted);font-size:14px}.note div{padding-left:14px;border-left:2px solid rgba(52,211,153,.4)}.error{color:var(--red);font-size:13px;margin-top:10px}.empty{padding:22px 0;color:var(--muted);font-size:16px}@keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}@media(max-width:820px){.app-shell{grid-template-columns:1fr}.sidebar{position:static;height:auto;padding:16px;border-right:0;border-bottom:1px solid var(--line)}.side-brand{margin-bottom:14px}.side-nav{grid-template-columns:1fr 1fr}.side-spacer{display:none}.side-user{margin-top:12px}main{padding:28px 16px}.grid{grid-template-columns:1fr}.form{grid-template-columns:1fr}.row{grid-template-columns:1fr;gap:5px}}
</style>
</head>
<body>
<div class="app-shell">
  <aside class="sidebar">
    <a href="/" class="side-brand">mflow</a>
    <nav class="side-nav" aria-label="Settings navigation">
      <a class="side-link" href="/dashboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 13h7V4H4v9Zm0 7h7v-5H4v5Zm9 0h7v-9h-7v9Zm0-16v5h7V4h-7Z"/></svg>Dashboard</a>
      <a class="side-link" href="/settings" aria-current="page"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.5-2-3.5-2.4 1a8 8 0 0 0-2.6-1.5L14 2.4h-4L9.6 5a8 8 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.8 7.8 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a8 8 0 0 0 2.6 1.5l.4 2.6h4l.4-2.6a8 8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>Settings</a>
    </nav>
    <div class="side-spacer"></div>
    <div class="side-user">
      <div class="side-user-card" id="user-chip" hidden><img id="avatar" alt=""><span id="login"></span></div>
      <div class="side-actions"><button id="logout">Sign out</button><a class="github-link" href="https://github.com/Obed0101/mflow" target="_blank" rel="noreferrer" aria-label="Open mflow on GitHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.02c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.33-1.76-1.33-1.76-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.24 1.84 1.24 1.07 1.83 2.8 1.3 3.49.99.11-.78.42-1.3.76-1.6-2.67-.3-5.47-1.33-5.47-5.92 0-1.31.47-2.38 1.24-3.22-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.6-2.81 5.61-5.49 5.91.43.37.81 1.1.81 2.22v3.29c0 .32.22.69.83.57A12 12 0 0 0 12 .5Z"/></svg></a></div>
    </div>
  </aside>
  <main>
    <a class="back" href="/dashboard"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M15.8 5.3 9.1 12l6.7 6.7-1.4 1.4L6.3 12l8.1-8.1 1.4 1.4Z"></path></svg>Back to dashboard</a>
    <section class="hero"><div class="eyebrow">Hosted settings</div><h1>Account and API keys.</h1><p>Create scoped hosted relay keys for CLI/admin room operations. Plaintext keys are shown once and never stored.</p></section>
    <div class="grid"><section class="card"><h2>Account</h2><div class="account"><img id="account-avatar" alt=""><div><strong id="account-name">Loading…</strong><p id="account-login">GitHub-authenticated dashboard session.</p></div></div><div class="note"><div>Session cookie is HttpOnly, SameSite=Lax, and Secure on HTTPS.</div><div>Room secrets stay separate from hosted dashboard keys.</div><div>Revoke keys you no longer use. Expired keys are rejected server-side.</div></div></section><section class="card"><h2>API keys</h2><div class="form"><input id="key-name" placeholder="Key name, e.g. Work laptop"><select id="key-exp"><option value="7d">7 days</option><option value="1d">1 day</option><option value="3d">3 days</option><option value="1m">1 month</option><option value="6m">6 months</option><option value="1y">1 year</option><option value="never">Never</option></select><button class="btn" id="create">Create key</button></div><div class="key-once" id="key-once"><strong>Copy this key now. It will not be shown again.</strong><code id="key-plain"></code><button class="btn ghost" id="copy">Copy</button></div><div id="error" class="error"></div><div id="keys"></div></section></div>
  </main>
</div>
<script>
(function(){var user=null;function esc(v){var d=document.createElement('div');d.textContent=v==null?'':String(v);return d.innerHTML}function fmt(ts){return ts?new Date(ts).toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'}):'Never'}function rel(ts){return ts?new Date(ts).toLocaleString():'Never'}function auth(){return fetch('/api/auth/config').then(r=>r.json()).then(c=>{if(c.required&&!c.authenticated){location.href='/dashboard';return}user=c.user||{login:'self-hosted',name:'Self-hosted admin',avatarUrl:''};document.getElementById('login').textContent=user.login;document.getElementById('account-name').textContent=user.name||user.login;document.getElementById('account-login').textContent='@'+user.login;['avatar','account-avatar'].forEach(id=>{var img=document.getElementById(id);if(user.avatarUrl)img.src=user.avatarUrl;else img.style.display='none'});document.getElementById('user-chip').hidden=false})}function load(){return fetch('/api/api-keys').then(r=>r.json()).then(d=>{var keys=d.keys||[];document.getElementById('keys').innerHTML=keys.length?keys.map(k=>'<div class="row"><div><div class="name">'+esc(k.name)+'</div><div class="muted">Created '+rel(k.createdAt)+'</div></div><div><div class="muted">Suffix</div><div class="suffix">••••'+esc(k.suffix)+'</div></div><div><div class="muted">Expires</div>'+fmt(k.expiresAt)+'</div><div><div class="muted">Last used</div>'+fmt(k.lastUsedAt)+'</div><button class="btn danger" data-revoke="'+esc(k.id)+'" '+(k.revokedAt?'disabled':'')+'>'+(k.revokedAt?'Revoked':'Revoke')+'</button></div>').join(''):'<div class="empty">No API keys yet.</div>';document.querySelectorAll('[data-revoke]').forEach(b=>b.onclick=function(){fetch('/api/api-keys/'+this.dataset.revoke+'/revoke',{method:'POST'}).then(load)})})}document.getElementById('create').onclick=function(){document.getElementById('error').textContent='';fetch('/api/api-keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:document.getElementById('key-name').value,expiresIn:document.getElementById('key-exp').value})}).then(async r=>{var d=await r.json();if(!r.ok)throw new Error(d.error||'Failed to create key');document.getElementById('key-plain').textContent=d.plaintext;document.getElementById('key-once').style.display='block';document.getElementById('key-name').value='';return load()}).catch(e=>document.getElementById('error').textContent=e.message)};document.getElementById('copy').onclick=function(){navigator.clipboard.writeText(document.getElementById('key-plain').textContent||'')};document.getElementById('logout').onclick=function(){fetch('/api/auth/logout',{method:'POST'}).then(()=>location.href='/dashboard')};auth().then(load)})();
</script>
</body>
</html>`;
}
