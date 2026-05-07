/**
 * Landing page HTML served at /.
 */
export function getLandingHtml(): string {
  return LANDING_HTML;
}

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>mflow — real-time code sync for AI agent teams</title>
<meta name="description" content="Open-source file sync between worktrees while AI agents edit. Room + secret access, self-hostable, MIT licensed."/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0c;
  --surface:#141416;
  --surface-2:#1a1a1e;
  --border:rgba(255,255,255,.08);
  --border-hover:rgba(255,255,255,.16);
  --text:#e8e8ed;
  --text-2:#a0a0ab;
  --text-3:#5a5a66;
  --accent:#34d399;
  --accent-dim:rgba(52,211,153,.12);
  --accent-glow:rgba(52,211,153,.06);
  --mono:'JetBrains Mono',ui-monospace,monospace;
  --sans:'Inter',-apple-system,sans-serif;
}
html{scroll-behavior:smooth}
body{
  background:var(--bg);color:var(--text);
  font-family:var(--sans);font-size:15px;line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
a{color:inherit;text-decoration:none}
.w{max-width:1080px;margin:0 auto;padding:0 32px}

/* ── Ambient glow ─────────────────────────── */
.glow{
  position:fixed;top:-400px;left:50%;transform:translateX(-50%);
  width:900px;height:900px;pointer-events:none;z-index:0;
  background:radial-gradient(circle,var(--accent-glow) 0%,transparent 60%);
  opacity:.7;
}

/* ── Nav ──────────────────────────────────── */
nav{
  position:fixed;top:0;left:0;right:0;z-index:100;
  background:rgba(10,10,12,.85);backdrop-filter:blur(16px);
  border-bottom:1px solid var(--border);
}
.nav-inner{
  display:grid;grid-template-columns:1fr auto 1fr;align-items:center;
  height:56px;
}
.nav-brand{font-size:16px;font-weight:700;letter-spacing:-.02em;justify-self:start}
.nav-center{display:flex;align-items:center;gap:28px;justify-self:center}
.nav-center a{font-size:13px;color:var(--text-2);font-weight:500;transition:color .15s}
.nav-center a:hover{color:var(--text)}
.nav-right{justify-self:end;display:flex;align-items:center;gap:10px}
.nav-dashboard{
  display:inline-flex;align-items:center;gap:6px;
  font-size:13px;font-weight:700;color:#000;
  padding:8px 16px;border-radius:8px;
  background:#fff;
  transition:transform .15s,opacity .15s;
}
.nav-dashboard:hover{transform:translateY(-1px);opacity:.92}
.nav-gh{
  display:inline-flex;align-items:center;gap:6px;
  font-size:13px;font-weight:600;color:var(--text);
  padding:6px 14px;border-radius:6px;
  border:1px solid var(--border);transition:border-color .15s,background .15s;
}
.nav-gh:hover{border-color:var(--border-hover);background:var(--surface)}
.nav-gh svg{width:16px;height:16px;fill:currentColor}

/* ── Hero ─────────────────────────────────── */
.hero{padding:140px 0 100px;text-align:center;position:relative;z-index:1}
.hero-badge{
  display:inline-block;font-size:12px;font-weight:600;
  color:var(--accent);letter-spacing:.04em;
  padding:5px 14px;border-radius:100px;
  border:1px solid rgba(52,211,153,.25);background:var(--accent-dim);
  margin-bottom:28px;
}
.hero h1{
  font-size:clamp(38px,5.5vw,60px);font-weight:800;
  letter-spacing:-.045em;line-height:1.08;margin-bottom:20px;
  color:#fff;
}
.hero .sub{
  font-size:18px;color:var(--text-2);max-width:540px;
  margin:0 auto 36px;line-height:1.55;
}
.hero-btns{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}
.btn-p{
  display:inline-flex;align-items:center;gap:6px;
  padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600;
  background:#fff;color:#000;transition:opacity .15s;
}
.btn-p:hover{opacity:.88}
.btn-s{
  display:inline-flex;align-items:center;gap:6px;
  padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600;
  border:1px solid var(--border);color:var(--text);
  transition:border-color .15s,background .15s;
}
.btn-s:hover{border-color:var(--border-hover);background:var(--surface)}

/* ── Terminal ─────────────────────────────── */
.term-wrap{max-width:640px;margin:56px auto 0}
.term{
  background:#0f0f11;border:1px solid var(--border);
  border-radius:10px;overflow:hidden;
  box-shadow:0 20px 60px rgba(0,0,0,.5);
}
.term-bar{
  display:flex;align-items:center;gap:7px;
  padding:11px 16px;border-bottom:1px solid var(--border);
}
.term-dot{width:11px;height:11px;border-radius:50%}
.term-dot:nth-child(1){background:#ff5f57}
.term-dot:nth-child(2){background:#febc2e}
.term-dot:nth-child(3){background:#28c840}
.term-label{margin-left:auto;font-size:11px;color:var(--text-3);font-family:var(--mono)}
.term pre{
  padding:20px;font-family:var(--mono);font-size:13px;
  line-height:1.75;color:var(--text-2);overflow-x:auto;
}
.term .p{color:var(--accent)}
.term .c{color:#fff}
.term .g{color:var(--accent)}
.term .d{color:var(--text-3)}

/* ── Section ──────────────────────────────── */
section{padding:100px 0;position:relative;z-index:1}
.s-label{
  font-size:12px;font-weight:700;color:var(--accent);
  text-transform:uppercase;letter-spacing:.1em;margin-bottom:10px;
}
.s-title{font-size:30px;font-weight:700;letter-spacing:-.03em;margin-bottom:14px;color:#fff}
.s-desc{color:var(--text-2);max-width:520px;margin-bottom:40px;font-size:16px;line-height:1.6}
.s-center{text-align:center}
.s-center .s-desc{margin-left:auto;margin-right:auto}

/* ── Feature grid (How it works) ──────────── */
.feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:14px;overflow:hidden}
.feat{background:var(--surface);padding:36px 28px}
.feat-icon{
  width:40px;height:40px;border-radius:10px;margin-bottom:18px;
  display:flex;align-items:center;justify-content:center;
  background:var(--accent-dim);color:var(--accent);
}
.feat-icon svg{width:20px;height:20px}
.feat h3{font-size:16px;font-weight:700;margin-bottom:8px;color:#fff}
.feat p{font-size:14px;color:var(--text-2);line-height:1.55}

/* ── Access model ─────────────────────────── */
.access-card{
  background:var(--surface);border:1px solid var(--border);
  border-radius:14px;overflow:hidden;
}
.access-top{padding:40px 36px 32px}
.access-steps{
  display:grid;grid-template-columns:repeat(3,1fr);gap:1px;
  background:var(--border);
}
.access-step{background:var(--surface);padding:24px}
.access-step .num{font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px}
.access-step strong{display:block;font-size:14px;margin-bottom:4px;color:#fff}
.access-step span{font-size:13px;color:var(--text-2)}
.access-note{
  padding:20px 36px;border-top:1px solid var(--border);
  font-size:13px;color:var(--text-2);
  background:var(--accent-dim);
}
.access-note strong{color:var(--text);font-weight:600}

/* ── Limits ───────────────────────────────── */
.limits-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:14px;overflow:hidden}
.limit{background:var(--surface);padding:28px 24px}
.limit-val{font-size:28px;font-weight:800;color:#fff;font-family:var(--mono);line-height:1.1}
.limit-name{font-size:14px;font-weight:600;margin:6px 0 4px;color:var(--text)}
.limit-desc{font-size:13px;color:var(--text-3)}

/* ── Dashboard promo ──────────────────────── */
.promo{
  background:var(--surface);border:1px solid var(--border);
  border-radius:14px;overflow:hidden;
  display:grid;grid-template-columns:1fr 1fr;
}
.promo-text{padding:48px 40px;display:flex;flex-direction:column;justify-content:center}
.promo-text h2{font-size:26px;font-weight:700;margin-bottom:14px;color:#fff;letter-spacing:-.02em}
.promo-text p{font-size:15px;color:var(--text-2);margin-bottom:8px;line-height:1.55}
.promo-path{font-family:var(--mono);font-size:13px;color:var(--text-3);margin-bottom:24px}
.promo-visual{
  background:linear-gradient(135deg,var(--surface-2),rgba(52,211,153,.05));
  padding:40px;display:flex;align-items:center;justify-content:center;
  border-left:1px solid var(--border);
}
.promo-mock{
  width:100%;background:var(--bg);border:1px solid var(--border);
  border-radius:10px;padding:24px;font-family:var(--mono);font-size:12px;
  line-height:2;color:var(--text-2);
}
.promo-mock .hl{color:var(--accent)}

/* ── Quick start ──────────────────────────── */
.qs-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.qs-step .qs-num{
  font-size:11px;font-weight:700;color:var(--accent);
  text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px;
}
.qs-code{
  padding:16px;background:var(--surface);
  border:1px solid var(--border);border-radius:8px;
  font-family:var(--mono);font-size:13px;line-height:1.6;color:var(--text);
}
.qs-code .cmt{color:var(--text-3)}

/* ── Extras ───────────────────────────────── */
.extras{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--border);border-radius:14px;overflow:hidden}
.extra{background:var(--surface);padding:28px 24px}
.extra h4{font-size:15px;font-weight:700;margin-bottom:6px;color:#fff}
.extra p{font-size:14px;color:var(--text-2);line-height:1.5}

/* ── Footer ───────────────────────────────── */
footer{border-top:1px solid var(--border);padding:64px 0 40px;position:relative;z-index:1}
.ftr-grid{display:flex;justify-content:space-between;gap:48px;margin-bottom:40px}
.ftr-brand-col{max-width:240px}
.ftr-brand{font-size:18px;font-weight:700;margin-bottom:10px}
.ftr-tagline{font-size:13px;color:var(--text-2);line-height:1.5}
.ftr-links{display:flex;gap:48px}
.ftr-col-title{font-size:11px;font-weight:700;color:var(--text);text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px}
.ftr-col a,.ftr-col span{display:block;font-size:13px;color:var(--text-2);margin-bottom:8px;transition:color .15s}
.ftr-col a:hover{color:var(--accent)}
.ftr-bottom{padding-top:24px;border-top:1px solid var(--border);font-size:13px;color:var(--text-3)}

/* ── Responsive ───────────────────────────── */
@media(max-width:768px){
  .nav-inner{display:flex;justify-content:space-between}
  .nav-center{display:none}
  .hero{padding:110px 0 60px}
  .feat-grid,.limits-grid,.qs-grid,.extras,.access-steps{grid-template-columns:1fr}
  .promo{grid-template-columns:1fr}
  .promo-visual{border-left:none;border-top:1px solid var(--border)}
  .ftr-grid{flex-direction:column;gap:32px}
  .ftr-links{flex-wrap:wrap;gap:32px}
  section{padding:64px 0}
}
</style>
</head>
<body>
<div class="glow"></div>

<nav>
  <div class="w nav-inner">
    <a href="/" class="nav-brand">mflow</a>
    <div class="nav-center">
      <a href="#how">How it works</a>
      <a href="#access">Access</a>
      <a href="#limits">Limits</a>
      <a href="#quickstart">Quick Start</a>
    </div>
    <div class="nav-right">
      <a href="/dashboard" class="nav-dashboard">Dashboard</a>
      <a href="https://github.com/Obed0101/mflow" class="nav-gh"><svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a>
    </div>
  </div>
</nav>

<main>

<div class="w">
  <div class="hero">
    <div class="hero-badge">Open source · MIT licensed · self-hostable</div>
    <h1>Real-time file sync<br/>for AI agent teams</h1>
    <p class="sub">Sync working files across worktrees while agents edit in parallel. No account needed — just a room name and a strong secret.</p>
    <div class="hero-btns">
      <a class="btn-p" href="/dashboard">Open Dashboard</a>
      <a class="btn-s" href="#quickstart">Install CLI</a>
      <a class="btn-s" href="https://github.com/Obed0101/mflow" style="gap:8px"><svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub</a>
    </div>

    <div class="term-wrap">
      <div class="term">
        <div class="term-bar">
          <div class="term-dot"></div>
          <div class="term-dot"></div>
          <div class="term-dot"></div>
          <span class="term-label">bash</span>
        </div>
        <pre><span class="p">$</span> <span class="c">npm i -g mflow-sdk</span>
<span class="p">$</span> <span class="c">mflow start --room my-project --secret "$MFLOW_SECRET"</span>

<span class="g">✓ Connected to public relay (fair-use: 4 peers/room)</span>
  <span class="d">↑ src/auth.ts synced → 3 peers</span>
  <span class="d">! Treat the room secret like a password</span></pre>
      </div>
    </div>
  </div>
</div>

<!-- How it works -->
<section id="how">
  <div class="w">
    <div class="s-label">How it works</div>
    <h2 class="s-title">File sync, not chat sync</h2>
    <p class="s-desc">Mflow propagates file changes between peers. It does not sync chat history, tool logs, or agent memory.</p>
    <div class="feat-grid">
      <div class="feat">
        <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg></div>
        <h3>Sync</h3>
        <p>File changes propagate between peers through encrypted room traffic.</p>
      </div>
      <div class="feat">
        <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg></div>
        <h3>Encrypt</h3>
        <p>Room secrets derive encryption keys. The relay should not be treated as trusted storage.</p>
      </div>
      <div class="feat">
        <div class="feat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg></div>
        <h3>Coordinate</h3>
        <p>Pause/resume and file locks help avoid conflicts during git operations or hot-file edits.</p>
      </div>
    </div>
  </div>
</section>

<!-- Access Model -->
<section id="access">
  <div class="w">
    <div class="access-card">
      <div class="access-top">
        <div class="s-label">Access model</div>
        <h2 class="s-title">Room + secret based</h2>
        <p style="color:var(--text-2);font-size:15px;line-height:1.6;max-width:560px">No login or register flow in the OSS release. The dashboard hashes your room secret in the browser and only sends the hash. The plaintext secret never leaves your machine.</p>
      </div>
      <div class="access-steps">
        <div class="access-step"><div class="num">Step 1</div><strong>Start a room</strong><span>Run the CLI with a room name and a strong secret.</span></div>
        <div class="access-step"><div class="num">Step 2</div><strong>Share the secret</strong><span>Give it only to trusted peers, out-of-band.</span></div>
        <div class="access-step"><div class="num">Step 3</div><strong>Monitor</strong><span>Open /dashboard and enter the same secret.</span></div>
      </div>
      <div class="access-note"><strong>Hosted relay auth ·</strong> The hosted dashboard can require GitHub device sign-in before showing room status. Sync peers still join with room + secret. Self-hosted deployments can keep auth disabled.</div>
    </div>
  </div>
</section>

<!-- Limits -->
<section id="limits">
  <div class="w">
    <div class="s-center">
      <div class="s-label">Public relay limits</div>
      <h2 class="s-title">Fair-use defaults</h2>
      <p class="s-desc">These limits protect the shared Deno free-tier relay. Self-host for larger rooms or production reliability.</p>
    </div>
    <div class="limits-grid">
      <div class="limit"><div class="limit-val">4</div><div class="limit-name">peers per room</div><div class="limit-desc">Enough for demos and small agent swarms.</div></div>
      <div class="limit"><div class="limit-val">64 KB</div><div class="limit-name">max message size</div><div class="limit-desc">Oversized messages rejected before parsing.</div></div>
      <div class="limit"><div class="limit-val">120/m</div><div class="limit-name">messages per IP</div><div class="limit-desc">Repeated violations disconnect the socket.</div></div>
      <div class="limit"><div class="limit-val">10/m</div><div class="limit-name">joins per IP</div><div class="limit-desc">Protects room auth from noisy clients.</div></div>
      <div class="limit"><div class="limit-val">5</div><div class="limit-name">unauth sockets/IP</div><div class="limit-desc">Unauthenticated sockets auto-timeout.</div></div>
      <div class="limit"><div class="limit-val">500</div><div class="limit-name">global unauth cap</div><div class="limit-desc">Relay-wide cap before authentication.</div></div>
      <div class="limit"><div class="limit-val">200</div><div class="limit-name">active rooms</div><div class="limit-desc">Room cap for the shared hosted relay.</div></div>
      <div class="limit"><div class="limit-val">15 m</div><div class="limit-name">idle room TTL</div><div class="limit-desc">Idle rooms are eligible for cleanup.</div></div>
      <div class="limit"><div class="limit-val">20</div><div class="limit-name">activity entries</div><div class="limit-desc">Dashboard activity is intentionally bounded.</div></div>
    </div>
  </div>
</section>

<!-- Dashboard promo -->
<section>
  <div class="w">
    <div class="promo">
      <div class="promo-text">
        <h2>Monitor your sync room</h2>
        <p>Use the dashboard to see connected peers and recent room activity. Enter the same room secret you used in the CLI.</p>
        <div class="promo-path">/dashboard</div>
        <a class="btn-p" href="/dashboard" style="width:fit-content">Open Monitor</a>
      </div>
      <div class="promo-visual">
        <div class="promo-mock">
          <div style="display:flex;justify-content:space-between;margin-bottom:16px"><span class="hl">SIGNAL SERVER: ACTIVE</span><span>FAIR-USE RELAY</span></div>
          <div><span class="hl">[ROOM]</span> 4 peers max on public relay</div>
          <div><span class="hl">[SYNC]</span> src/auth.ts → 3 peers</div>
          <div><span class="hl">[LOCK]</span> db.ts locked by agent-beta</div>
          <div style="opacity:.4"><span class="hl">[SELF-HOST]</span> raise limits with MFLOW_* env vars</div>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- Quick Start -->
<section id="quickstart">
  <div class="w">
    <div class="s-center" style="margin-bottom:48px">
      <h2 class="s-title">Quick Start</h2>
    </div>
    <div class="qs-grid">
      <div class="qs-step">
        <div class="qs-num">1. Install</div>
        <div class="qs-code"><span class="cmt"># npm package, CLI binary is mflow</span><br/>npm i -g mflow-sdk</div>
      </div>
      <div class="qs-step">
        <div class="qs-num">2. Start syncing</div>
        <div class="qs-code"><span class="cmt"># From project root</span><br/>mflow start --room project-x \\<br/>  --secret "$MFLOW_SECRET"</div>
      </div>
      <div class="qs-step">
        <div class="qs-num">3. Join from another worktree</div>
        <div class="qs-code"><span class="cmt"># Same room and same secret</span><br/>mflow start --room project-x \\<br/>  --secret "$MFLOW_SECRET"</div>
      </div>
    </div>
  </div>
</section>

<!-- Extras -->
<section>
  <div class="w">
    <div class="extras">
      <div class="extra"><h4>Self-hostable</h4><p>Run your own signaling server on Deno Deploy, Bun, Docker, or private infrastructure.</p></div>
      <div class="extra"><h4>MCP and CLI</h4><p>Works from CLI first, with MCP integration for supported harnesses.</p></div>
      <div class="extra"><h4>Future managed relay</h4><p>Managed/private relay may come later. Core OSS and self-hosting remain the base path.</p></div>
    </div>
  </div>
</section>

</main>

<footer>
  <div class="w">
    <div class="ftr-grid">
      <div class="ftr-brand-col">
        <div class="ftr-brand">mflow</div>
        <div class="ftr-tagline">Open-source real-time code sync for AI agent teams.</div>
      </div>
      <div class="ftr-links">
        <div class="ftr-col">
          <div class="ftr-col-title">Resources</div>
          <a href="https://github.com/Obed0101/mflow">GitHub</a>
          <a href="#quickstart">Documentation</a>
        </div>
        <div class="ftr-col">
          <div class="ftr-col-title">Product</div>
          <a href="/dashboard">Monitor</a>
          <a href="#limits">Limits</a>
        </div>
        <div class="ftr-col">
          <div class="ftr-col-title">Legal</div>
          <span>MIT License</span>
        </div>
      </div>
    </div>
    <div class="ftr-bottom">Made for AI agent teams. No hosted account required.</div>
  </div>
</footer>
</body>
</html>`;
