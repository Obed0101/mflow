/**
 * Dashboard HTML template for the mflow signaling server.
 * Pure HTML + CSS + vanilla JS — no frameworks, no build step.
 *
 * Three modes:
 * - Public (default): aggregate stats only, no room IDs or peer names
 * - Room-scoped: enter room secret, client-side SHA-256 hash, show only matching rooms
 * - Admin: enter admin token, server validates against ADMIN_TOKEN env var, show all rooms
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
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: #0d1117;
      color: #c9d1d9;
      font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'SF Mono', monospace;
      font-size: 14px;
      line-height: 1.6;
      min-height: 100vh;
      padding: 24px;
    }

    .container {
      max-width: 720px;
      margin: 0 auto;
    }

    .header {
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 16px;
      background: #161b22;
    }

    .header h1 {
      font-size: 16px;
      font-weight: 700;
      color: #e6edf3;
      margin-bottom: 12px;
    }

    .status-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 24px;
      font-size: 13px;
    }

    .status-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-label { color: #6b7280; }
    .status-value { color: #c9d1d9; }

    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 6px #22c55e80;
    }

    .dot.warning { background: #eab308; box-shadow: 0 0 6px #eab30880; }
    .dot.error { background: #ef4444; box-shadow: 0 0 6px #ef444480; }

    .section {
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 20px 24px;
      margin-bottom: 16px;
      background: #161b22;
    }

    .section-title {
      font-size: 13px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 16px;
    }

    .auth-form {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      align-items: center;
    }

    .auth-form input {
      flex: 1;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 8px 12px;
      color: #c9d1d9;
      font-family: inherit;
      font-size: 13px;
      outline: none;
    }

    .auth-form input:focus {
      border-color: #58a6ff;
      box-shadow: 0 0 0 2px #58a6ff30;
    }

    .auth-form button, .btn {
      background: #21262d;
      border: 1px solid #30363d;
      border-radius: 6px;
      padding: 8px 16px;
      color: #c9d1d9;
      font-family: inherit;
      font-size: 13px;
      cursor: pointer;
      white-space: nowrap;
    }

    .auth-form button:hover, .btn:hover {
      background: #30363d;
      border-color: #484f58;
    }

    .btn-primary {
      background: #238636;
      border-color: #2ea043;
      color: #ffffff;
    }

    .btn-primary:hover {
      background: #2ea043;
      border-color: #3fb950;
    }

    .mode-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      margin-left: 8px;
      vertical-align: middle;
    }

    .mode-badge.public { background: #1f2937; color: #6b7280; border: 1px solid #374151; }
    .mode-badge.room { background: #0c2d1b; color: #3fb950; border: 1px solid #238636; }
    .mode-badge.admin { background: #2d1b0c; color: #d29922; border: 1px solid #9e6a03; }

    .auth-toggle {
      font-size: 12px;
      color: #6b7280;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
      background: none;
      border: none;
      font-family: inherit;
      padding: 0;
    }

    .auth-toggle:hover { color: #c9d1d9; }

    .logout-btn {
      font-size: 12px;
      color: #f85149;
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
      background: none;
      border: none;
      font-family: inherit;
      padding: 0;
      margin-left: 12px;
    }

    .logout-btn:hover { color: #ff7b72; }

    .room {
      margin-bottom: 16px;
      padding-bottom: 16px;
      border-bottom: 1px solid #21262d;
    }

    .room:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }

    .room-header {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 20px;
      margin-bottom: 8px;
      font-size: 13px;
    }

    .room-id {
      color: #e6edf3;
      font-weight: 600;
    }

    .room-meta { color: #6b7280; }

    .peer {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 2px 0 2px 16px;
      font-size: 13px;
    }

    .peer-dot {
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
    }

    .peer-dot.agent { background: #06b6d4; }
    .peer-dot.human { background: #22c55e; }

    .peer-name { color: #c9d1d9; }

    .peer-type {
      color: #6b7280;
      font-size: 12px;
    }

    .peer-type.agent { color: #06b6d4; }
    .peer-type.human { color: #22c55e; }

    .empty-state {
      color: #6b7280;
      font-style: italic;
      font-size: 13px;
    }

    .auth-msg {
      color: #6b7280;
      font-size: 13px;
      padding: 8px 0;
    }

    .auth-msg.error-msg { color: #f85149; }

    .footer {
      border: 1px solid #21262d;
      border-radius: 8px;
      padding: 12px 24px;
      background: #161b22;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 8px;
      font-size: 12px;
      color: #6b7280;
    }

    .refresh-on { color: #22c55e; }

    .error-banner {
      display: none;
      background: #1c1214;
      border: 1px solid #3d1f28;
      border-radius: 8px;
      padding: 12px 24px;
      margin-bottom: 16px;
      color: #ef4444;
      font-size: 13px;
    }

    .hidden { display: none !important; }

    @media (max-width: 480px) {
      body { padding: 12px; font-size: 13px; }
      .header, .section, .footer { padding: 16px; }
      .status-row { gap: 4px 16px; }
      .auth-form { flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>mflow signaling server <span class="mode-badge public" id="mode-badge">PUBLIC</span></h1>
      <div class="status-row">
        <div class="status-item">
          <span class="status-label">Status:</span>
          <span class="dot" id="status-dot"></span>
          <span class="status-value" id="status-text">Running</span>
        </div>
        <div class="status-item">
          <span class="status-label">Uptime:</span>
          <span class="status-value" id="uptime">--</span>
        </div>
        <div class="status-item">
          <span class="status-label">Rooms:</span>
          <span class="status-value" id="room-count">--</span>
        </div>
        <div class="status-item">
          <span class="status-label">Peers:</span>
          <span class="status-value" id="peer-count">--</span>
        </div>
        <div class="status-item">
          <span class="status-label">Memory:</span>
          <span class="status-value" id="memory">--</span>
        </div>
      </div>
    </div>

    <div class="error-banner" id="error-banner"></div>

    <div class="section" id="auth-section">
      <div class="section-title">Access <span id="auth-status"></span></div>

      <div id="login-forms">
        <div id="room-login-form">
          <div class="auth-form">
            <input type="password" id="room-secret-input" placeholder="Enter room secret to view your room" autocomplete="off" aria-label="Room secret">
            <button class="btn btn-primary" id="room-login-btn" type="button">View Room</button>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:16px;margin-top:4px;">
          <button class="auth-toggle" id="toggle-admin" type="button">Admin login</button>
        </div>
        <div id="admin-login-form" class="hidden" style="margin-top:12px;">
          <div class="auth-form">
            <input type="password" id="admin-token-input" placeholder="Enter admin token" autocomplete="off" aria-label="Admin token">
            <button class="btn btn-primary" id="admin-login-btn" type="button">Admin Login</button>
          </div>
        </div>
      </div>

      <div id="logged-in-info" class="hidden">
        <div class="auth-msg" id="logged-in-msg"></div>
        <button class="logout-btn" id="logout-btn" type="button">Logout</button>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Active Rooms</div>
      <div id="rooms-container">
        <div class="empty-state">Loading...</div>
      </div>
    </div>

    <div class="footer">
      <span>Last updated: <span id="last-updated">--</span></span>
      <span>Auto-refresh: <span class="refresh-on">ON</span></span>
    </div>
  </div>

  <script>
    (function() {
      var lastFetch = 0;
      var consecutiveErrors = 0;

      // Mode: 'public' | 'room' | 'admin'
      var mode = 'public';
      var secretHash = null;  // SHA-256 hash of room secret (for room mode)
      var adminToken = null;  // Admin token (for admin mode)

      // ─── Crypto ──────────────────────────────────────────

      function sha256(str) {
        var encoder = new TextEncoder();
        return crypto.subtle.digest('SHA-256', encoder.encode(str)).then(function(buf) {
          var arr = new Uint8Array(buf);
          var hex = '';
          for (var i = 0; i < arr.length; i++) {
            hex += ('0' + arr[i].toString(16)).slice(-2);
          }
          return hex;
        });
      }

      // ─── Session Storage ─────────────────────────────────

      function loadSession() {
        try {
          var stored = sessionStorage.getItem('mflow_dash_mode');
          if (stored) {
            var s = JSON.parse(stored);
            if (s.mode === 'room' && s.secretHash) {
              mode = 'room';
              secretHash = s.secretHash;
            } else if (s.mode === 'admin' && s.adminToken) {
              mode = 'admin';
              adminToken = s.adminToken;
            }
          }
        } catch (_) {}
      }

      function saveSession() {
        try {
          if (mode === 'room') {
            sessionStorage.setItem('mflow_dash_mode', JSON.stringify({ mode: 'room', secretHash: secretHash }));
          } else if (mode === 'admin') {
            sessionStorage.setItem('mflow_dash_mode', JSON.stringify({ mode: 'admin', adminToken: adminToken }));
          } else {
            sessionStorage.removeItem('mflow_dash_mode');
          }
        } catch (_) {}
      }

      // ─── UI Helpers ──────────────────────────────────────

      function formatUptime(seconds) {
        if (seconds < 60) return seconds + 's';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
        var h = Math.floor(seconds / 3600);
        var m = Math.floor((seconds % 3600) / 60);
        return h + 'h ' + m + 'm';
      }

      function formatAge(createdAt) {
        var diff = Math.floor((Date.now() - createdAt) / 1000);
        if (diff < 60) return diff + 's';
        if (diff < 3600) return Math.floor(diff / 60) + 'm';
        var h = Math.floor(diff / 3600);
        var m = Math.floor((diff % 3600) / 60);
        return h + 'h ' + m + 'm';
      }

      function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }

      function updateModeUI() {
        var badge = document.getElementById('mode-badge');
        var loginForms = document.getElementById('login-forms');
        var loggedInInfo = document.getElementById('logged-in-info');
        var loggedInMsg = document.getElementById('logged-in-msg');

        badge.className = 'mode-badge ' + mode;
        badge.textContent = mode.toUpperCase();

        if (mode === 'public') {
          loginForms.classList.remove('hidden');
          loggedInInfo.classList.add('hidden');
        } else {
          loginForms.classList.add('hidden');
          loggedInInfo.classList.remove('hidden');
          if (mode === 'room') {
            loggedInMsg.textContent = 'Viewing rooms matching your secret';
          } else {
            loggedInMsg.textContent = 'Admin mode — viewing all rooms';
          }
        }
      }

      function renderRooms(data) {
        var container = document.getElementById('rooms-container');

        if (mode === 'public') {
          container.innerHTML = '<div class="auth-msg">Enter a room secret or admin token to view room details.</div>';
          return;
        }

        if (!data.rooms || data.rooms.length === 0) {
          if (mode === 'room') {
            container.innerHTML = '<div class="empty-state">No active room with this secret</div>';
          } else {
            container.innerHTML = '<div class="empty-state">No rooms active</div>';
          }
          return;
        }

        var html = '';
        for (var i = 0; i < data.rooms.length; i++) {
          var room = data.rooms[i];
          html += '<div class="room">';
          html += '<div class="room-header">';
          html += '<span class="room-id">Room: ' + escapeHtml(room.id.substring(0, 8)) + '</span>';
          html += '<span class="room-meta">Peers: ' + room.peerCount + '</span>';
          html += '<span class="room-meta">Age: ' + formatAge(room.createdAt) + '</span>';
          html += '</div>';

          for (var j = 0; j < room.peers.length; j++) {
            var peer = room.peers[j];
            var typeClass = peer.peerType === 'agent' ? 'agent' : 'human';
            html += '<div class="peer">';
            html += '<span class="peer-dot ' + typeClass + '"></span>';
            html += '<span class="peer-name">' + escapeHtml(peer.peerName) + '</span>';
            html += '<span class="peer-type ' + typeClass + '">(' + escapeHtml(peer.peerType) + ')</span>';
            html += '</div>';
          }

          html += '</div>';
        }

        container.innerHTML = html;
      }

      // ─── Fetch Logic ─────────────────────────────────────

      function buildApiUrl() {
        if (mode === 'admin' && adminToken) {
          return '/api/rooms?admin=' + encodeURIComponent(adminToken);
        }
        if (mode === 'room' && secretHash) {
          return '/api/rooms?secretHash=' + encodeURIComponent(secretHash);
        }
        return '/api/rooms';
      }

      function updateDashboard() {
        fetch(buildApiUrl())
          .then(function(res) {
            if (res.status === 403) {
              // Admin token invalid — logout
              mode = 'public';
              adminToken = null;
              saveSession();
              updateModeUI();
              var container = document.getElementById('rooms-container');
              container.innerHTML = '<div class="auth-msg error-msg">Invalid admin token. Logged out.</div>';
              return null;
            }
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function(data) {
            if (!data) return;
            consecutiveErrors = 0;
            lastFetch = Date.now();

            document.getElementById('status-dot').className = 'dot';
            document.getElementById('status-text').textContent = 'Running';
            document.getElementById('uptime').textContent = formatUptime(data.uptime);
            document.getElementById('room-count').textContent = data.totalRooms;
            document.getElementById('peer-count').textContent = data.totalPeers;
            document.getElementById('memory').textContent = (data.memoryMB || 0) + 'MB';

            document.getElementById('error-banner').style.display = 'none';

            renderRooms(data);
          })
          .catch(function(err) {
            consecutiveErrors++;
            document.getElementById('status-dot').className = consecutiveErrors >= 3 ? 'dot error' : 'dot warning';
            document.getElementById('status-text').textContent = consecutiveErrors >= 3 ? 'Unreachable' : 'Retrying...';

            var banner = document.getElementById('error-banner');
            banner.textContent = 'Failed to fetch: ' + err.message;
            banner.style.display = 'block';
          });
      }

      function updateTimestamp() {
        if (lastFetch === 0) return;
        var ago = Math.floor((Date.now() - lastFetch) / 1000);
        document.getElementById('last-updated').textContent = ago + 's ago';
      }

      // ─── Event Handlers ──────────────────────────────────

      document.getElementById('room-login-btn').addEventListener('click', function() {
        var input = document.getElementById('room-secret-input');
        var secret = input.value.trim();
        if (!secret) return;
        sha256(secret).then(function(hash) {
          mode = 'room';
          secretHash = hash;
          adminToken = null;
          saveSession();
          updateModeUI();
          updateDashboard();
        });
      });

      document.getElementById('room-secret-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') document.getElementById('room-login-btn').click();
      });

      document.getElementById('toggle-admin').addEventListener('click', function() {
        document.getElementById('admin-login-form').classList.toggle('hidden');
      });

      document.getElementById('admin-login-btn').addEventListener('click', function() {
        var input = document.getElementById('admin-token-input');
        var token = input.value.trim();
        if (!token) return;
        mode = 'admin';
        adminToken = token;
        secretHash = null;
        saveSession();
        updateModeUI();
        updateDashboard();
      });

      document.getElementById('admin-token-input').addEventListener('keydown', function(e) {
        if (e.key === 'Enter') document.getElementById('admin-login-btn').click();
      });

      document.getElementById('logout-btn').addEventListener('click', function() {
        mode = 'public';
        secretHash = null;
        adminToken = null;
        saveSession();
        updateModeUI();
        document.getElementById('room-secret-input').value = '';
        document.getElementById('admin-token-input').value = '';
        updateDashboard();
      });

      // ─── Init ────────────────────────────────────────────

      loadSession();
      updateModeUI();
      updateDashboard();
      setInterval(updateDashboard, 2000);
      setInterval(updateTimestamp, 1000);
    })();
  </script>
</body>
</html>`;
}
