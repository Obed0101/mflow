/**
 * Landing page HTML served at /.
 */
export function getLandingHtml(): string {
  return LANDING_HTML;
}

const LANDING_HTML = `
<!DOCTYPE html>
<html class="dark" lang="en">
<head>
<meta charset="utf-8"/>
<meta content="width=device-width, initial-scale=1.0" name="viewport"/>
<title>mflow | Open-source real-time code sync for AI agent teams</title>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap" rel="stylesheet"/>
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@100..700,0..1&amp;display=swap" rel="stylesheet"/>
<script id="tailwind-config">
  tailwind.config = {
    darkMode: "class",
    theme: {
      extend: {
        colors: {
          primary: "#10b981",
          "background-light": "#f6f8f7",
          "background-dark": "#0a0a0a",
          "neutral-dark": "#171717",
          "text-main": "#fafafa",
          "text-muted": "#737373"
        },
        fontFamily: {
          display: ["Inter", "sans-serif"],
          mono: ["JetBrains Mono", "monospace"]
        },
        borderRadius: {
          DEFAULT: "0.25rem",
          lg: "0.5rem",
          xl: "0.75rem",
          full: "9999px"
        }
      }
    }
  }
</script>
</head>
<body class="bg-background-light dark:bg-background-dark font-display text-slate-900 dark:text-text-main antialiased selection:bg-primary/30">
<header class="fixed top-0 w-full z-50 border-b border-white/5 bg-background-dark/80 backdrop-blur-md">
  <div class="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
    <a class="flex items-center gap-2" href="#top" aria-label="mflow home">
      <span class="text-xl font-bold tracking-tight text-text-main">mflow</span>
    </a>
    <nav class="hidden md:flex items-center gap-8">
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="https://github.com/Obed0101/mflow">GitHub</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#quickstart">Install</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="/dashboard">Monitor</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#access">Access</a>
      <a class="text-sm font-medium text-text-muted hover:text-primary transition-colors" href="#limits">Limits</a>
    </nav>
    <a class="bg-primary hover:bg-primary/90 text-background-dark px-4 py-2 rounded-lg text-sm font-bold transition-all" href="/dashboard">
      Open Dashboard
    </a>
  </div>
</header>
<main id="top" class="pt-32 pb-20">
<section class="max-w-7xl mx-auto px-6 mb-28">
  <div class="grid lg:grid-cols-2 gap-16 items-center">
    <div class="flex flex-col gap-8">
      <div class="inline-flex w-fit items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-semibold text-primary">
        MIT licensed core · self-hostable · public relay is fair-use
      </div>
      <h1 class="text-5xl md:text-7xl font-black tracking-tighter text-text-main leading-[1.06]">
        Real-time code sync for AI agent teams
      </h1>
      <p class="text-lg md:text-xl text-text-muted leading-relaxed max-w-xl">
        Sync working files between multiple worktrees or machines while agents edit. No account required. Bring a room name and a strong secret.
      </p>
      <div class="flex flex-wrap gap-4">
        <a class="bg-primary hover:bg-primary/90 text-background-dark px-8 py-4 rounded-xl text-base font-bold transition-all shadow-lg shadow-primary/10" href="/dashboard">
          Open Dashboard
        </a>
        <a class="border border-white/10 hover:border-primary/50 hover:bg-primary/5 text-text-main px-8 py-4 rounded-xl text-base font-bold transition-all" href="#quickstart">
          Install CLI
        </a>
        <a class="border border-white/10 hover:border-primary/50 hover:bg-primary/5 text-text-main px-8 py-4 rounded-xl text-base font-bold transition-all" href="https://github.com/Obed0101/mflow">
          View on GitHub
        </a>
      </div>
    </div>
    <div class="relative">
      <div class="absolute -inset-1 bg-gradient-to-r from-primary/20 to-transparent blur-2xl opacity-50"></div>
      <div class="relative bg-neutral-dark border border-white/10 rounded-xl overflow-hidden shadow-2xl">
        <div class="flex items-center gap-1.5 px-4 py-3 border-b border-white/5 bg-white/5">
          <div class="w-3 h-3 rounded-full bg-red-500/20 border border-red-500/50"></div>
          <div class="w-3 h-3 rounded-full bg-yellow-500/20 border border-yellow-500/50"></div>
          <div class="w-3 h-3 rounded-full bg-green-500/20 border border-green-500/50"></div>
          <span class="ml-2 text-xs font-mono text-text-muted">bash — mflow</span>
        </div>
        <div class="p-6 font-mono text-sm leading-relaxed space-y-1">
          <p class="text-text-main"><span class="text-primary">$</span> npm i -g mflow-sdk</p>
          <p class="text-text-main"><span class="text-primary">$</span> mflow start --room my-project --secret "$MFLOW_SECRET"</p>
          <p class="text-primary">✓ Connected to public relay (fair-use: 4 peers/room)</p>
          <p class="text-text-muted">↑ src/auth.ts synced → 3 peers</p>
          <p class="text-text-muted">! Treat the room secret like a password</p>
          <div class="h-4 w-2 bg-primary inline-block animate-pulse ml-1"></div>
        </div>
      </div>
    </div>
  </div>
</section>

<section id="access" class="max-w-7xl mx-auto px-6 mb-28">
  <div class="bg-neutral-dark border border-white/5 rounded-3xl p-8 md:p-12">
    <div class="grid lg:grid-cols-[1.1fr_0.9fr] gap-10 items-start">
      <div>
        <p class="text-sm font-bold text-primary uppercase tracking-wider mb-3">Access today</p>
        <h2 class="text-3xl font-bold tracking-tight mb-4">Access is room + secret based</h2>
        <p class="text-text-muted text-lg leading-relaxed mb-6">
          There is no login or register flow in this OSS release. The dashboard asks for your room secret, hashes it in the browser, and only uses the hash to load room-scoped status. The secret itself is not sent by the dashboard.
        </p>
        <div class="grid md:grid-cols-3 gap-4 text-sm">
          <div class="rounded-xl border border-white/10 bg-background-dark/60 p-4">
            <div class="font-bold text-text-main mb-1">1. Start a room</div>
            <div class="text-text-muted">Run the CLI with a room and strong secret.</div>
          </div>
          <div class="rounded-xl border border-white/10 bg-background-dark/60 p-4">
            <div class="font-bold text-text-main mb-1">2. Share secret</div>
            <div class="text-text-muted">Give it only to trusted peers out-of-band.</div>
          </div>
          <div class="rounded-xl border border-white/10 bg-background-dark/60 p-4">
            <div class="font-bold text-text-main mb-1">3. Monitor</div>
            <div class="text-text-muted">Open /dashboard and enter the same secret.</div>
          </div>
        </div>
      </div>
      <div class="rounded-2xl border border-primary/20 bg-primary/5 p-6">
        <h3 class="font-bold text-text-main mb-3">Login/register status</h3>
        <p class="text-sm text-text-muted leading-relaxed">
          The hosted dashboard can require GitHub device sign-in before showing room status. Sync peers still join with room + secret. Self-hosted deployments can remain accountless.
        </p>
        <button class="mt-5 inline-flex rounded-xl border border-white/10 px-4 py-2 text-sm font-bold text-text-muted cursor-not-allowed opacity-70" type="button" disabled>
          Login/register planned
        </button>
      </div>
    </div>
  </div>
</section>

<section id="limits" class="max-w-7xl mx-auto px-6 mb-28">
  <div class="mb-10 text-center">
    <p class="text-sm font-bold text-primary uppercase tracking-wider mb-3">Public hosted relay limits</p>
    <h2 class="text-3xl font-bold tracking-tight mb-4">Fair-use limits per room, IP, and relay</h2>
    <p class="text-text-muted max-w-2xl mx-auto">These limits protect the shared Deno free-tier relay. Self-host if you need larger rooms, private infrastructure, or production reliability.</p>
  </div>
  <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">4</div><div class="font-bold mb-1">peers per room</div><p class="text-sm text-text-muted">Enough for demos and small agent swarms.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">64KB</div><div class="font-bold mb-1">max WebSocket message</div><p class="text-sm text-text-muted">Oversized messages are rejected before parsing.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">120/min</div><div class="font-bold mb-1">messages per IP</div><p class="text-sm text-text-muted">Repeated violations can disconnect the socket.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">10/min</div><div class="font-bold mb-1">joins per IP</div><p class="text-sm text-text-muted">Protects room auth from noisy clients.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">5</div><div class="font-bold mb-1">unauth sockets per IP</div><p class="text-sm text-text-muted">Unauthenticated sockets auto-timeout.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">500</div><div class="font-bold mb-1">global unauth sockets</div><p class="text-sm text-text-muted">Relay-wide protection before authentication.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">200</div><div class="font-bold mb-1">active rooms max</div><p class="text-sm text-text-muted">Room cap for the shared hosted relay.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">15m</div><div class="font-bold mb-1">idle room TTL</div><p class="text-sm text-text-muted">Idle rooms are eligible for cleanup.</p></div>
    <div class="rounded-2xl border border-white/10 bg-neutral-dark p-6"><div class="text-3xl font-black text-primary mb-1">20</div><div class="font-bold mb-1">activity entries per room</div><p class="text-sm text-text-muted">Dashboard activity is intentionally bounded.</p></div>
  </div>
</section>

<section class="max-w-7xl mx-auto px-6 mb-28">
  <div class="mb-12">
    <h2 class="text-3xl font-bold tracking-tight mb-4">How it works</h2>
    <p class="text-text-muted">Mflow syncs files. It does not sync chat history, tool logs, or agent memory.</p>
  </div>
  <div class="grid md:grid-cols-3 gap-6">
    <div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
      <span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">sync_alt</span>
      <h3 class="text-xl font-bold mb-3">Sync</h3>
      <p class="text-text-muted leading-relaxed">File changes propagate between peers through encrypted room traffic.</p>
    </div>
    <div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
      <span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">encrypted</span>
      <h3 class="text-xl font-bold mb-3">Encrypt</h3>
      <p class="text-text-muted leading-relaxed">Room secrets derive encryption keys. The relay should not be treated as trusted storage.</p>
    </div>
    <div class="bg-neutral-dark border border-white/5 p-8 rounded-2xl hover:border-primary/30 transition-colors group">
      <span class="material-symbols-outlined text-primary mb-4 text-3xl group-hover:scale-110 transition-transform">lock_person</span>
      <h3 class="text-xl font-bold mb-3">Coordinate</h3>
      <p class="text-text-muted leading-relaxed">Pause/resume and file locks help avoid conflict during git operations or hot-file edits.</p>
    </div>
  </div>
</section>

<section class="max-w-7xl mx-auto px-6 mb-28">
  <div class="bg-neutral-dark border border-white/5 rounded-3xl overflow-hidden">
    <div class="grid lg:grid-cols-2">
      <div class="p-12 flex flex-col justify-center gap-6">
        <div>
          <h2 class="text-3xl font-bold mb-4">Monitor your sync room</h2>
          <p class="text-text-muted text-lg mb-6">Use the dashboard to see connected peers and recent room activity. Enter the same room secret you used in the CLI.</p>
          <p class="font-mono text-sm text-primary/60 mb-8 break-all">/dashboard</p>
        </div>
        <a class="bg-primary hover:bg-primary/90 text-background-dark px-6 py-3 rounded-xl font-bold w-fit transition-all" href="/dashboard">
          Open Monitor
        </a>
      </div>
      <div class="bg-gradient-to-br from-neutral-dark to-primary/10 p-4 lg:p-12 relative overflow-hidden flex items-center justify-center min-h-[300px]">
        <div class="w-full h-full rounded-xl bg-background-dark/60 border border-white/10 p-6 font-mono text-xs">
          <div class="flex justify-between items-center mb-6"><div class="text-primary">SIGNAL SERVER: ACTIVE</div><div class="text-text-muted">FAIR-USE RELAY</div></div>
          <div class="space-y-3">
            <div class="flex gap-4"><span class="text-primary">[ROOM]</span><span>4 peers max on public relay</span></div>
            <div class="flex gap-4"><span class="text-primary">[SYNC]</span><span>src/auth.ts → 3 peers</span></div>
            <div class="flex gap-4"><span class="text-primary">[LOCK]</span><span>db.ts locked by agent-beta</span></div>
            <div class="flex gap-4 opacity-50"><span class="text-primary">[SELF-HOST]</span><span>raise limits with MFLOW_* env vars</span></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</section>

<section id="quickstart" class="max-w-7xl mx-auto px-6 mb-28">
  <h2 class="text-3xl font-bold tracking-tight mb-12 text-center">Quick Start</h2>
  <div class="grid lg:grid-cols-3 gap-6">
    <div class="flex flex-col gap-4">
      <h3 class="text-sm font-bold text-primary uppercase tracking-wider">1. Install</h3>
      <div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10"><span class="text-text-muted"># npm package, CLI binary is mflow</span><br/><span class="text-text-main">npm i -g mflow-sdk</span></div>
    </div>
    <div class="flex flex-col gap-4">
      <h3 class="text-sm font-bold text-primary uppercase tracking-wider">2. Start syncing</h3>
      <div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10"><span class="text-text-muted"># From project root</span><br/><span class="text-text-main">mflow start --room project-x --secret "$MFLOW_SECRET"</span></div>
    </div>
    <div class="flex flex-col gap-4">
      <h3 class="text-sm font-bold text-primary uppercase tracking-wider">3. Join from another worktree</h3>
      <div class="bg-neutral-dark p-4 rounded-lg font-mono text-sm border border-white/10"><span class="text-text-muted"># Same room and same secret</span><br/><span class="text-text-main">mflow start --room project-x --secret "$MFLOW_SECRET"</span></div>
    </div>
  </div>
</section>

<section class="max-w-7xl mx-auto px-6 mb-20">
  <div class="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
    <div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40"><h4 class="text-text-main font-bold mb-2">Self-hostable</h4><p class="text-sm text-text-muted">Run your own signaling server on Deno Deploy, Bun, Docker, or private infrastructure.</p></div>
    <div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40"><h4 class="text-text-main font-bold mb-2">MCP and CLI</h4><p class="text-sm text-text-muted">Works from CLI first, with MCP integration for supported harnesses.</p></div>
    <div class="p-6 rounded-2xl border border-white/5 bg-neutral-dark/40"><h4 class="text-text-main font-bold mb-2">Future managed relay</h4><p class="text-sm text-text-muted">Managed/private relay may come later. Core OSS and self-hosting remain the base path.</p></div>
  </div>
</section>
</main>
<footer class="border-t border-white/5 bg-neutral-dark/30 py-16">
  <div class="max-w-7xl mx-auto px-6">
    <div class="flex flex-col md:flex-row justify-between items-start gap-12 mb-12">
      <div class="flex flex-col gap-4"><span class="text-2xl font-bold tracking-tight text-text-main">mflow</span><p class="text-text-muted max-w-xs text-sm">Open-source real-time code sync for AI agent teams.</p></div>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-12">
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Resources</span><a class="text-sm text-text-muted hover:text-primary transition-colors" href="https://github.com/Obed0101/mflow">GitHub</a><a class="text-sm text-text-muted hover:text-primary transition-colors" href="#quickstart">Documentation</a></div>
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Product</span><a class="text-sm text-text-muted hover:text-primary transition-colors" href="/dashboard">Monitor</a><a class="text-sm text-text-muted hover:text-primary transition-colors" href="#limits">Limits</a></div>
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Related</span><a class="text-sm text-text-muted hover:text-primary transition-colors" href="https://trees.software/">Trees</a><a class="text-sm text-text-muted hover:text-primary transition-colors" href="https://diffs.com/">Diffs</a></div>
        <div class="flex flex-col gap-4"><span class="text-xs font-bold text-text-main uppercase">Legal</span><span class="text-sm text-text-muted">MIT License</span></div>
      </div>
    </div>
    <div class="flex flex-col md:flex-row justify-between items-center pt-8 border-t border-white/5 gap-4"><p class="text-sm text-text-muted">Made for AI agent teams. No hosted account required.</p></div>
  </div>
</footer>
</body>
</html>`;
