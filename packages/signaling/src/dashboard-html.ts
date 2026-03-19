/**
 * Dashboard HTML template for the mflow signaling server.
 * Pure HTML + CSS + vanilla JS — no frameworks, no build step.
 *
 * Two modes:
 * - Public (default): aggregate stats only, no room IDs or peer names
 * - Room-scoped: enter room secret, client-side SHA-256 hash, show room + activity feed
 */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>mflow signaling server</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0a0a0a;
      color: #fafafa;
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      line-height: 1.5;
      min-height: 100vh;
      padding: 24px;
    }

    .mono { font-family: 'JetBrains Mono', 'Fira Code', monospace; }

    .container { max-width: 760px; margin: 0 auto; }

    /* ─── Header ────────────────────────────────── */

    .header {
      background: #141414;
      border: 1px solid #1e1e1e;
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .header h1 {
      font-size: 15px;
      font-weight: 600;
      color: #fafafa;
      letter-spacing: -0.01em;
    }

    .status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 8px #10b98166;
      flex-shrink: 0;
    }
    .status-dot.warning { background: #eab308; box-shadow: 0 0 8px #eab30866; }
    .status-dot.error { background: #ef4444; box-shadow: 0 0 8px #ef444466; }

    .uptime-badge {
      font-size: 12px;
      color: #737373;
      font-family: 'JetBrains Mono', monospace;
    }

    /* ─── Stats Cards ───────────────────────────── */

    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
    }

    .stat-card {
      text-align: center;
      padding: 12px 8px;
      background: #0a0a0a;
      border: 1px solid #1e1e1e;
      border-radius: 6px;
    }

    .stat-value {
      font-size: 24px;
      font-weight: 700;
      color: #fafafa;
      font-family: 'JetBrains Mono', monospace;
      line-height: 1.2;
    }

    .stat-label {
      font-size: 11px;
      color: #737373;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-top: 2px;
    }

    /* ─── Access (inline) ───────────────────────── */

    .access-bar {
      margin-bottom: 12px;
    }

    .login-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .login-row input {
      flex: 1;
      background: #141414;
      border: 1px solid #1e1e1e;
      border-radius: 6px;
      padding: 8px 12px;
      color: #fafafa;
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s;
    }

    .login-row input:focus {
      border-color: #10b981;
      box-shadow: 0 0 0 2px #10b98120;
    }

    .login-row input::placeholder { color: #404040; }

    .btn {
      background: #1e1e1e;
      border: 1px solid #2a2a2a;
      border-radius: 6px;
      padding: 8px 16px;
      color: #fafafa;
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s, border-color 0.15s;
    }

    .btn:hover { background: #2a2a2a; border-color: #333; }

    .btn-primary {
      background: #065f46;
      border-color: #10b981;
      color: #10b981;
    }

    .btn-primary:hover { background: #047857; }

    .room-badge {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 12px;
      background: #141414;
      border: 1px solid #1e1e1e;
      border-radius: 6px;
      font-size: 13px;
    }

    .room-badge-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: #10b981;
      flex-shrink: 0;
    }

    .room-badge-name {
      color: #fafafa;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }

    .room-badge-close {
      background: none;
      border: none;
      color: #737373;
      font-size: 16px;
      cursor: pointer;
      padding: 0 0 0 4px;
      line-height: 1;
      font-family: 'Inter', sans-serif;
    }

    .room-badge-close:hover { color: #ef4444; }

    /* ─── Room Card ──────────────────────────────── */

    .card {
      background: #141414;
      border: 1px solid #1e1e1e;
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 12px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    }

    .card-title {
      font-size: 11px;
      font-weight: 600;
      color: #737373;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 14px;
    }

    .room-info {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 16px;
      margin-bottom: 14px;
      font-size: 13px;
    }

    .room-name {
      font-weight: 600;
      color: #fafafa;
      font-family: 'JetBrains Mono', monospace;
    }

    .room-meta {
      color: #737373;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
    }

    .peers-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .peer-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: #0a0a0a;
      border: 1px solid #1e1e1e;
      border-radius: 16px;
      font-size: 12px;
      color: #fafafa;
    }

    .peer-pill-dot {
      width: 6px; height: 6px; border-radius: 50%;
      flex-shrink: 0;
    }

    .peer-pill-dot.agent { background: #06b6d4; }
    .peer-pill-dot.human { background: #10b981; }

    .peer-pill-type {
      color: #737373;
      font-size: 11px;
    }

    .peer-pill-type.agent { color: #06b6d4; }
    .peer-pill-type.human { color: #10b981; }

    /* ─── Activity Feed ──────────────────────────── */

    .activity-feed {
      max-height: 440px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #1e1e1e transparent;
    }

    .activity-feed::-webkit-scrollbar { width: 4px; }
    .activity-feed::-webkit-scrollbar-track { background: transparent; }
    .activity-feed::-webkit-scrollbar-thumb { background: #1e1e1e; border-radius: 2px; }

    .activity-row {
      display: grid;
      grid-template-columns: 60px 1fr auto auto;
      gap: 12px;
      align-items: center;
      padding: 8px 0;
      border-bottom: 1px solid #1a1a1a;
      font-size: 13px;
      opacity: 1;
      transition: opacity 0.3s, border-color 0.5s;
    }

    .activity-row:last-child { border-bottom: none; }

    .activity-row.new-entry {
      border-left: 2px solid #10b981;
      padding-left: 8px;
      animation: flash-green 1s ease-out;
    }

    @keyframes flash-green {
      0% { background: #10b98115; border-left-color: #10b981; }
      100% { background: transparent; border-left-color: transparent; }
    }

    @keyframes fade-in {
      from { opacity: 0; transform: translateY(-4px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .activity-row.entering {
      animation: fade-in 0.3s ease-out;
    }

    .activity-time {
      color: #404040;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      text-align: right;
    }

    .activity-peer {
      color: #fafafa;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .activity-action {
      font-size: 12px;
      font-weight: 500;
    }

    .activity-action.synced { color: #10b981; }
    .activity-action.created { color: #3b82f6; }
    .activity-action.deleted { color: #ef4444; }

    .activity-file {
      color: #737373;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 200px;
      direction: rtl;
    }

    .empty-activity {
      color: #404040;
      font-size: 13px;
      text-align: center;
      padding: 32px 0;
    }

    .public-msg {
      color: #404040;
      font-size: 13px;
      text-align: center;
      padding: 32px 0;
    }

    /* ─── Error Banner ───────────────────────────── */

    .error-banner {
      display: none;
      background: #1a0a0a;
      border: 1px solid #3d1f1f;
      border-radius: 8px;
      padding: 10px 16px;
      margin-bottom: 12px;
      color: #ef4444;
      font-size: 13px;
    }

    /* ─── Footer ─────────────────────────────────── */

    .footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 0;
      font-size: 12px;
      color: #404040;
    }

    .footer-refresh { color: #10b981; }

    /* ─── Utilities ──────────────────────────────── */

    .hidden { display: none !important; }

    /* ─── Responsive ─────────────────────────────── */

    @media (max-width: 600px) {
      body { padding: 12px; }
      .stats-row { grid-template-columns: repeat(2, 1fr); }
      .header, .card { padding: 16px; }
      .login-row { flex-direction: column; }
      .activity-row { grid-template-columns: 50px 1fr auto; }
      .activity-file { display: none; }
      .room-info { gap: 10px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Header -->
    <div class="header">
      <div class="header-top">
        <div class="header-title">
          <span class="status-dot" id="status-dot"></span>
          <h1>mflow signaling</h1>
        </div>
        <span class="uptime-badge" id="uptime">--</span>
      </div>
      <div class="stats-row">
        <div class="stat-card">
          <div class="stat-value" id="room-count">-</div>
          <div class="stat-label">Rooms</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="peer-count">-</div>
          <div class="stat-label">Peers</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="memory">-</div>
          <div class="stat-label">Memory</div>
        </div>
        <div class="stat-card">
          <div class="stat-value" id="status-text">OK</div>
          <div class="stat-label">Status</div>
        </div>
      </div>
    </div>

    <!-- Access (inline, not a card) -->
    <div class="access-bar" id="access-bar">
      <div class="login-row" id="login-row">
        <input type="password" id="secret-input" placeholder="Room secret" autocomplete="off" aria-label="Room secret">
        <button class="btn btn-primary" id="login-btn" type="button">Connect</button>
      </div>
      <div class="login-row hidden" id="room-badge-row">
        <div class="room-badge" id="room-badge">
          <span class="room-badge-dot"></span>
          <span class="room-badge-name" id="room-badge-name">--</span>
          <button class="room-badge-close" id="logout-btn" type="button" aria-label="Disconnect">&times;</button>
        </div>
      </div>
    </div>

    <!-- Error -->
    <div class="error-banner" id="error-banner"></div>

    <!-- Room Card (visible when logged in) -->
    <div class="card hidden" id="room-card">
      <div id="rooms-container"></div>
    </div>

    <!-- Activity Feed (visible when logged in) -->
    <div class="card hidden" id="activity-card">
      <div class="card-title">Activity</div>
      <div class="activity-feed" id="activity-feed">
        <div class="empty-activity">Waiting for activity...</div>
      </div>
    </div>

    <!-- Public message (visible when not logged in) -->
    <div class="card" id="public-card">
      <div class="public-msg">Enter a room secret to view peers and activity</div>
    </div>

    <!-- Footer -->
    <div class="footer">
      <span>Updated <span id="last-updated">--</span></span>
      <span>Auto-refresh: <span class="footer-refresh">ON</span> (2s)</span>
    </div>
  </div>

  <script>
    (function() {
      var lastFetch = 0;
      var consecutiveErrors = 0;
      var mode = 'public';
      var secretHash = null;
      var knownActivityIds = {};
      var activityCount = 0;

      // ─── Crypto ─────────────────────────────────────

      function sha256(str) {
        return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function(buf) {
          var arr = new Uint8Array(buf);
          var hex = '';
          for (var i = 0; i < arr.length; i++) hex += ('0' + arr[i].toString(16)).slice(-2);
          return hex;
        });
      }

      // ─── Session ────────────────────────────────────

      function loadSession() {
        try {
          var s = JSON.parse(sessionStorage.getItem('mflow_dash') || '{}');
          if (s.mode === 'room' && s.hash) { mode = 'room'; secretHash = s.hash; }
        } catch (_) {}
      }

      function saveSession() {
        try {
          if (mode === 'room') sessionStorage.setItem('mflow_dash', JSON.stringify({ mode: 'room', hash: secretHash }));
          else sessionStorage.removeItem('mflow_dash');
        } catch (_) {}
      }

      // ─── Formatting ─────────────────────────────────

      function formatUptime(sec) {
        if (sec < 60) return sec + 's';
        if (sec < 3600) return Math.floor(sec / 60) + 'm';
        var h = Math.floor(sec / 3600);
        var m = Math.floor((sec % 3600) / 60);
        return h + 'h ' + m + 'm';
      }

      function formatAge(ts) {
        var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        var h = Math.floor(diff / 3600);
        return h + 'h ago';
      }

      function relativeTime(ts) {
        var diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        return Math.floor(diff / 3600) + 'h ago';
      }

      function esc(str) {
        var d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
      }

      // ─── UI State ───────────────────────────────────

      function updateUI() {
        var loginRow = document.getElementById('login-row');
        var badgeRow = document.getElementById('room-badge-row');
        var roomCard = document.getElementById('room-card');
        var activityCard = document.getElementById('activity-card');
        var publicCard = document.getElementById('public-card');

        if (mode === 'room') {
          loginRow.classList.add('hidden');
          badgeRow.classList.remove('hidden');
          roomCard.classList.remove('hidden');
          activityCard.classList.remove('hidden');
          publicCard.classList.add('hidden');
        } else {
          loginRow.classList.remove('hidden');
          badgeRow.classList.add('hidden');
          roomCard.classList.add('hidden');
          activityCard.classList.add('hidden');
          publicCard.classList.remove('hidden');
        }
      }

      // ─── Render Room ────────────────────────────────

      function renderRooms(data) {
        var container = document.getElementById('rooms-container');

        if (!data.rooms || data.rooms.length === 0) {
          container.innerHTML = '<div class="empty-activity">No active room</div>';
          return;
        }

        var html = '';
        for (var i = 0; i < data.rooms.length; i++) {
          var room = data.rooms[i];

          // Room badge name
          document.getElementById('room-badge-name').textContent = room.id.substring(0, 8);

          html += '<div class="room-info">';
          html += '<span class="room-name">Room: ' + esc(room.id.substring(0, 8)) + '</span>';
          html += '<span class="room-meta">Age: ' + formatAge(room.createdAt) + '</span>';
          html += '<span class="room-meta">Peers: ' + room.peerCount + '</span>';
          html += '</div>';
          html += '<div class="peers-row">';

          for (var j = 0; j < room.peers.length; j++) {
            var p = room.peers[j];
            var tc = p.peerType === 'agent' ? 'agent' : 'human';
            html += '<div class="peer-pill">';
            html += '<span class="peer-pill-dot ' + tc + '"></span>';
            html += '<span class="peer-pill-type ' + tc + '">[' + esc(p.peerType) + ']</span> ';
            html += esc(p.peerName);
            html += '</div>';
          }

          html += '</div>';
        }

        container.innerHTML = html;
      }

      // ─── Render Activity ────────────────────────────

      function renderActivity(data) {
        var feed = document.getElementById('activity-feed');

        // Collect all activity entries from all rooms
        var entries = [];
        if (data.rooms) {
          for (var i = 0; i < data.rooms.length; i++) {
            var act = data.rooms[i].activity;
            if (act) {
              for (var j = 0; j < act.length; j++) entries.push(act[j]);
            }
          }
        }

        if (entries.length === 0) {
          feed.innerHTML = '<div class="empty-activity">Waiting for activity...</div>';
          return;
        }

        // Sort newest first
        entries.sort(function(a, b) { return b.timestamp - a.timestamp; });

        // Cap at 20
        if (entries.length > 20) entries = entries.slice(0, 20);

        var html = '';
        for (var k = 0; k < entries.length; k++) {
          var e = entries[k];
          var entryId = e.timestamp + ':' + e.peerId + ':' + e.file;
          var isNew = !knownActivityIds[entryId];
          if (isNew) knownActivityIds[entryId] = true;

          var cls = 'activity-row';
          if (isNew && activityCount > 0) cls += ' new-entry entering';

          html += '<div class="' + cls + '">';
          html += '<span class="activity-time">' + relativeTime(e.timestamp) + '</span>';
          html += '<span class="activity-peer">' + esc(e.peerName) + '</span>';
          html += '<span class="activity-action ' + esc(e.action) + '">' + esc(e.action) + '</span>';
          html += '<span class="activity-file" title="' + esc(e.file) + '">' + esc(e.file) + '</span>';
          html += '</div>';
        }

        feed.innerHTML = html;
        activityCount++;
      }

      // ─── Fetch ──────────────────────────────────────

      function buildUrl() {
        if (mode === 'room' && secretHash) return '/api/rooms?secretHash=' + encodeURIComponent(secretHash);
        return '/api/rooms';
      }

      function refresh() {
        fetch(buildUrl())
          .then(function(res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function(data) {
            consecutiveErrors = 0;
            lastFetch = Date.now();

            var dot = document.getElementById('status-dot');
            dot.className = 'status-dot';
            document.getElementById('status-text').textContent = 'OK';
            document.getElementById('uptime').textContent = formatUptime(data.uptime);
            document.getElementById('room-count').textContent = data.totalRooms;
            document.getElementById('peer-count').textContent = data.totalPeers;
            document.getElementById('memory').textContent = (data.memoryMB || 0) + 'MB';
            document.getElementById('error-banner').style.display = 'none';

            if (mode === 'room') {
              renderRooms(data);
              renderActivity(data);
            }
          })
          .catch(function(err) {
            consecutiveErrors++;
            var dot = document.getElementById('status-dot');
            dot.className = 'status-dot ' + (consecutiveErrors >= 3 ? 'error' : 'warning');
            document.getElementById('status-text').textContent = consecutiveErrors >= 3 ? 'ERR' : '...';

            var banner = document.getElementById('error-banner');
            banner.textContent = err.message;
            banner.style.display = 'block';
          });
      }

      function updateTimestamps() {
        if (lastFetch === 0) return;
        document.getElementById('last-updated').textContent = Math.floor((Date.now() - lastFetch) / 1000) + 's ago';

        // Update relative times in activity feed
        var times = document.querySelectorAll('.activity-time');
        // Not worth re-rendering; times update on next poll
      }

      // ─── Events ─────────────────────────────────────

      document.getElementById('login-btn').addEventListener('click', function() {
        var val = document.getElementById('secret-input').value.trim();
        if (!val) return;
        sha256(val).then(function(hash) {
          mode = 'room';
          secretHash = hash;
          knownActivityIds = {};
          activityCount = 0;
          saveSession();
          updateUI();
          refresh();
        });
      });

      document.getElementById('secret-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') document.getElementById('login-btn').click();
      });

      document.getElementById('logout-btn').addEventListener('click', function() {
        mode = 'public';
        secretHash = null;
        knownActivityIds = {};
        activityCount = 0;
        saveSession();
        updateUI();
        document.getElementById('secret-input').value = '';
        document.getElementById('room-badge-name').textContent = '--';
        refresh();
      });

      // ─── Init ───────────────────────────────────────

      loadSession();
      updateUI();
      refresh();
      setInterval(refresh, 2000);
      setInterval(updateTimestamps, 1000);
    })();
  </script>
</body>
</html>`;
}
