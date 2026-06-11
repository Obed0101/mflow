import { constants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { displayInfo, displaySuccess, displayWarning } from "../display.js";

type Harness = "claude" | "opencode" | "codex" | "mendcode" | "all";

interface InstallHooksOptions {
  harness?: Harness;
  force?: boolean;
}

export async function installHooksCommand(
  projectRoot: string,
  options: InstallHooksOptions,
): Promise<void> {
  const harness = options.harness ?? "all";
  if (!["claude", "opencode", "codex", "mendcode", "all"].includes(harness)) {
    throw new Error("Invalid harness. Use claude, opencode, codex, mendcode, or all.");
  }

  if (harness === "claude" || harness === "all") {
    await installClaudeHooks(projectRoot, Boolean(options.force));
  }
  if (harness === "opencode" || harness === "all") {
    await installOpenCodePlugin(projectRoot, Boolean(options.force));
  }
  if (harness === "codex" || harness === "all") {
    await installCodexScaffold(projectRoot, Boolean(options.force));
  }
  if (harness === "mendcode" || harness === "all") {
    await installMendCodeScaffold(projectRoot, Boolean(options.force));
  }

  displaySuccess("mflow hook installation complete");
  displayInfo("Human approval should happen before this step in agent-driven workflows.");
  displayInfo("Hooks acquire queued locks before supported file edit tools run.");
  displayWarning("Keep mflow start running in each worktree; hooks are enforcement adapters, not the sync daemon.");
}

async function installClaudeHooks(projectRoot: string, force: boolean): Promise<void> {
  const hookDir = join(projectRoot, ".claude", "hooks");
  const hookPath = join(hookDir, "mflow-lock.mjs");
  await mkdir(hookDir, { recursive: true });
  await writeIfAllowed(hookPath, CLAUDE_HOOK_SCRIPT, force);

  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const settings = await readJsonObject(settingsPath);
  const hooks = ensureRecord(settings, "hooks");
  const preToolUse = ensureArray(hooks, "PreToolUse");
  const command = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/mflow-lock.mjs"`;

  const exists = preToolUse.some((entry) => JSON.stringify(entry).includes("mflow-lock.mjs"));
  if (!exists) {
    preToolUse.push({
      matcher: "Edit|Write|MultiEdit",
      hooks: [
        {
          type: "command",
          command,
          timeout: 330,
        },
      ],
    });
  }

  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  displayInfo(`Claude Code hook installed: ${hookPath}`);
  displayInfo(`Claude Code settings updated: ${settingsPath}`);
}

async function installOpenCodePlugin(projectRoot: string, force: boolean): Promise<void> {
  const pluginDir = join(projectRoot, ".opencode", "plugins");
  const pluginPath = join(pluginDir, "mflow-lock.js");
  await mkdir(pluginDir, { recursive: true });
  await writeIfAllowed(pluginPath, OPENCODE_PLUGIN_SCRIPT, force);
  displayInfo(`OpenCode plugin installed: ${pluginPath}`);
}

async function installCodexScaffold(projectRoot: string, force: boolean): Promise<void> {
  const codexDir = join(projectRoot, ".codex");
  const hooksDir = join(codexDir, "hooks");
  await mkdir(hooksDir, { recursive: true });

  const scriptPath = join(hooksDir, "mflow-pre-edit.sh");
  const promptPath = join(codexDir, "mflow-agent-prompt.md");
  const examplePath = join(codexDir, "mflow-hook.example.toml");

  await writeIfAllowed(scriptPath, CODEX_HOOK_SCRIPT, force);
  await chmod(scriptPath, 0o755);
  await writeIfAllowed(promptPath, CODEX_AGENT_PROMPT, force);
  await writeIfAllowed(examplePath, CODEX_HOOK_EXAMPLE_TOML, force);

  displayInfo(`Codex scaffold installed: ${scriptPath}`);
  displayInfo(`Codex prompt installed: ${promptPath}`);
  displayInfo(`Codex example config installed: ${examplePath}`);
  displayWarning("Codex scaffold is experimental. Wire it manually after verifying your exact Codex build supports the intended hook path.");
}

async function installMendCodeScaffold(projectRoot: string, force: boolean): Promise<void> {
  const mendCodeDir = join(projectRoot, ".mendcode");
  const pluginDir = join(mendCodeDir, "plugins");
  await mkdir(pluginDir, { recursive: true });

  const pluginPath = join(pluginDir, "mflow-lock.js");
  const controlPath = join(mendCodeDir, "mflow-control.md");
  const mcpExamplePath = join(mendCodeDir, "mcp.mflow.example.json");

  await writeIfAllowed(pluginPath, MENDCODE_PLUGIN_SCRIPT, force);
  await writeIfAllowed(controlPath, MENDCODE_CONTROL_GUIDE, force);
  await writeIfAllowed(mcpExamplePath, MENDCODE_MCP_EXAMPLE, force);

  displayInfo(`MendCode scaffold installed: ${pluginPath}`);
  displayInfo(`MendCode control guide installed: ${controlPath}`);
  displayInfo(`MendCode MCP example installed: ${mcpExamplePath}`);
  displayWarning("MendCode scaffold is experimental. Do not mark pre-edit enforcement as verified until the active MendCode build blocks a real write without a lock.");
}

async function writeIfAllowed(path: string, content: string, force: boolean): Promise<void> {
  if (!force && await exists(path)) {
    displayWarning(`Skipped existing file: ${path}. Re-run with --force to overwrite.`);
    return;
  }
  await writeFile(path, content, "utf-8");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  if (!await exists(path)) return {};
  const raw = await readFile(path, "utf-8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function ensureArray(parent: Record<string, unknown>, key: string): unknown[] {
  const current = parent[key];
  if (Array.isArray(current)) return current;
  const next: unknown[] = [];
  parent[key] = next;
  return next;
}

const CLAUDE_HOOK_SCRIPT = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const input = JSON.parse(await readStdin() || "{}");
const projectRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const files = extractFiles(input)
  .map((file) => normalizeProjectPath(projectRoot, input.cwd || projectRoot, file))
  .filter(Boolean);

for (const file of files) {
  const result = spawnSync(process.env.MFLOW_BIN || "mflow", [
    "lock",
    file,
    "--duration",
    process.env.MFLOW_LOCK_DURATION || "30s",
    "--wait",
    "--timeout",
    process.env.MFLOW_LOCK_TIMEOUT || "60s",
    "--priority",
    process.env.MFLOW_LOCK_PRIORITY || "0",
  ], { cwd: projectRoot, encoding: "utf-8" });

  if (result.status !== 0) {
    deny(\`mflow could not acquire lock for \${file}: \${result.stderr || result.stdout || "lock failed"}\`);
  }
}

if (files.length > 0) {
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
}

function extractFiles(event) {
  const tool = event.tool_name;
  const input = event.tool_input || {};
  if ((tool === "Write" || tool === "Edit" || tool === "MultiEdit") && input.file_path) {
    return [input.file_path];
  }
  return [];
}

function normalizeProjectPath(projectRoot, cwd, file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(cwd, file);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    deny(\`Refusing to lock path outside project: \${file}\`);
  }
  return relative;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason.trim(),
    },
  }));
  process.exit(0);
}

async function readStdin() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}
`;

const OPENCODE_PLUGIN_SCRIPT = `import { spawnSync } from "node:child_process";
import path from "node:path";

export const MflowLockPlugin = async ({ directory, worktree }) => {
  const projectRoot = worktree || directory || process.cwd();

  return {
    "tool.execute.before": async (input, output) => {
      const files = extractFiles(input.tool, output.args || {})
        .map((file) => normalizeProjectPath(projectRoot, file))
        .filter(Boolean);

      for (const file of files) {
        const result = spawnSync(process.env.MFLOW_BIN || "mflow", [
          "lock",
          file,
          "--duration",
          process.env.MFLOW_LOCK_DURATION || "30s",
          "--wait",
          "--timeout",
          process.env.MFLOW_LOCK_TIMEOUT || "60s",
          "--priority",
          process.env.MFLOW_LOCK_PRIORITY || "0",
        ], { cwd: projectRoot, encoding: "utf-8" });

        if (result.status !== 0) {
          throw new Error(\`mflow could not acquire lock for \${file}: \${result.stderr || result.stdout || "lock failed"}\`);
        }
      }
    },
  };
};

function extractFiles(tool, args) {
  if ((tool === "edit" || tool === "write" || tool === "multiedit") && args.filePath) {
    return [args.filePath];
  }
  if (tool === "apply_patch" && args.patchText) {
    return extractPatchFiles(args.patchText);
  }
  return [];
}

function extractPatchFiles(patchText) {
  const files = [];
  for (const line of patchText.split("\\n")) {
    const match = line.match(/^\\*\\*\\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
    if (match) files.push(match[1].trim());
  }
  return [...new Set(files)];
}

function normalizeProjectPath(projectRoot, file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(\`Refusing to lock path outside project: \${file}\`);
  }
  return relative;
}
`;

const CODEX_HOOK_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="\${1:-\$(pwd)}"
shift || true

if [ "$#" -eq 0 ]; then
  echo "usage: mflow-pre-edit.sh <project-root> <path> [<path> ...]" >&2
  exit 64
fi

MFLOW_BIN="\${MFLOW_BIN:-mflow}"
LOCK_DURATION="\${MFLOW_LOCK_DURATION:-30s}"
LOCK_TIMEOUT="\${MFLOW_LOCK_TIMEOUT:-60s}"
LOCK_PRIORITY="\${MFLOW_LOCK_PRIORITY:-0}"

normalize_path() {
  local path_input="$1"
  local abs
  if [[ "$path_input" = /* ]]; then
    abs="$path_input"
  else
    abs="$PROJECT_ROOT/$path_input"
  fi

  python3 - "$PROJECT_ROOT" "$abs" <<'PY'
import os
import sys

project_root = os.path.realpath(sys.argv[1])
candidate = os.path.realpath(sys.argv[2])

try:
    rel = os.path.relpath(candidate, project_root)
except ValueError:
    print("", end="")
    sys.exit(1)

if rel.startswith("..") or os.path.isabs(rel):
    print("", end="")
    sys.exit(1)

print(rel)
PY
}

for file in "$@"; do
  rel="$(normalize_path "$file")" || {
    echo "mflow Codex scaffold refused path outside project: $file" >&2
    exit 65
  }

  "$MFLOW_BIN" lock "$rel" \
    --duration "$LOCK_DURATION" \
    --wait \
    --timeout "$LOCK_TIMEOUT" \
    --priority "$LOCK_PRIORITY"
done
`;

const CODEX_AGENT_PROMPT = `# mflow Codex Hook Prompt

This repository uses mflow as an optional coordination layer for Codex.

If you are an AI agent:

1. Run \`mflow hook-status --harness codex\`.
2. If the status says Codex is still manual, do not modify Codex harness files automatically.
3. Tell the human that an experimental Codex hook scaffold is available.
4. Ask for approval before wiring or changing any Codex integration.
5. If the human approves, verify the current Codex build and wire the scaffold deliberately.
6. If approval is not granted, continue with manual mflow coordination only.

Minimum manual coordination:

- \`mflow status\` at task start
- \`mflow lock <path> --wait --timeout 60s\` before hot-file edits
- \`mflow claim "<glob>"\` before broad multi-file work
- \`mflow pause\` before commit/rebase/reset
- \`mflow resume\` after tests and git operations

Never print room secrets.
`;

const CODEX_HOOK_EXAMPLE_TOML = `# Experimental Codex hook scaffold for mflow
#
# This file is intentionally not auto-loaded by mflow because Codex hook
# semantics may vary by build. Review and adapt it for your local Codex setup.
#
# Suggested command shape for a pre-edit adapter:
#   /absolute/path/to/repo/.codex/hooks/mflow-pre-edit.sh /absolute/path/to/repo <path> [<path> ...]
#
# The adapter should:
# - normalize target paths relative to the repo root
# - acquire mflow locks before filesystem writes
# - fail the edit cleanly if a lock cannot be acquired
# - keep \`mflow pause\`/\`mflow resume\` around git operations
#
# See docs/harnesses/hook-contract.md for the universal contract.
`;

const MENDCODE_PLUGIN_SCRIPT = `import { spawnSync } from "node:child_process";
import path from "node:path";

// Experimental MendCode adapter for builds that expose a plugin-style
// tool.execute.before hook. Verify against the active MendCode build before
// relying on this to block writes.
export const MflowMendCodePlugin = async ({ directory, worktree, projectRoot: configuredRoot } = {}) => {
  const projectRoot = configuredRoot || worktree || directory || process.cwd();

  return {
    "tool.execute.before": async (input, output) => {
      const files = extractFiles(input?.tool || input?.toolName || input?.name, output?.args || input?.args || input?.tool_input || {})
        .map((file) => normalizeProjectPath(projectRoot, file))
        .filter(Boolean);

      for (const file of files) {
        const result = spawnSync(process.env.MFLOW_BIN || "mflow", [
          "lock",
          file,
          "--duration",
          process.env.MFLOW_LOCK_DURATION || "30s",
          "--wait",
          "--timeout",
          process.env.MFLOW_LOCK_TIMEOUT || "60s",
          "--priority",
          process.env.MFLOW_LOCK_PRIORITY || "0",
        ], { cwd: projectRoot, encoding: "utf-8" });

        if (result.status !== 0) {
          throw new Error(\`mflow could not acquire lock for \${file}: \${result.stderr || result.stdout || "lock failed"}\`);
        }
      }
    },
  };
};

function extractFiles(tool, args) {
  const normalizedTool = String(tool || "").toLowerCase();
  const directPath = args.filePath || args.file_path || args.path;
  if ((normalizedTool === "edit" || normalizedTool === "write" || normalizedTool === "multiedit") && directPath) {
    return [directPath];
  }

  if (Array.isArray(args.files)) return args.files;
  if (Array.isArray(args.paths)) return args.paths;

  const patchText = args.patchText || args.patch_text || args.patch;
  if ((normalizedTool === "apply_patch" || normalizedTool === "apply-patch") && patchText) {
    return extractPatchFiles(String(patchText));
  }

  return [];
}

function extractPatchFiles(patchText) {
  const files = [];
  for (const line of patchText.split("\\n")) {
    const match = line.match(/^\\*\\*\\* (?:Add File|Update File|Delete File|Move to): (.+)$/);
    if (match) files.push(match[1].trim());
  }
  return [...new Set(files)];
}

function normalizeProjectPath(projectRoot, file) {
  const absolute = path.isAbsolute(file) ? file : path.resolve(projectRoot, file);
  const relative = path.relative(projectRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(\`Refusing to lock path outside project: \${file}\`);
  }
  return relative;
}
`;

const MENDCODE_CONTROL_GUIDE = `# mflow for MendCode

This scaffold prepares repo-local MendCode integration files for mflow. It does not store room secrets.

## Activation flow for MendCode UI

1. Show current state: disabled, enabled but stopped, or running.
2. If disabled, ask the user to activate mflow.
3. Ask for relay:
   - Public relay: https://mflow-signal.obed0101.deno.net/
   - Custom/self-hosted relay URL
4. If public relay is selected, show this warning:

   Public mflow relay is a shared fair-use service. It is good for demos, small swarms, and onboarding. It has peer, message, rate, active-room, idle-timeout, and dashboard-history limits. For larger teams, private code, production reliability, or custom limits, use a self-hosted mflow relay URL.

5. Ask for or generate the room name and room secret.
6. Ask whether to store the room secret locally. Never print it.
7. Configure MCP for the active repo/user with pnpm only.

## MCP command shape

\`\`\`bash
mend mcp add mflow -- pnpm --package=mflow-cli dlx mflow-mcp --root /absolute/path/to/repo
\`\`\`

If MendCode has a native MCP config API, use this equivalent config instead of shelling out:

\`\`\`json
{
  "command": "pnpm",
  "args": ["--package=mflow-cli", "dlx", "mflow-mcp", "--root", "/absolute/path/to/repo"]
}
\`\`\`

## Pre-edit enforcement

This repo installed \`.mendcode/plugins/mflow-lock.js\`, an experimental adapter for MendCode builds that expose \`tool.execute.before\`. Verify with a real write interception test before relying on it.

Expected lock command:

\`\`\`bash
mflow lock path/to/file --duration 30s --wait --timeout 60s --priority 0
\`\`\`

For broad work, reserve a scope first:

\`\`\`bash
mflow claim "src/**" --timeout 2m --priority 0
\`\`\`

For patch-heavy edits, prefer:

\`\`\`bash
mflow apply-patch patch.txt --timeout 60s --priority 0
\`\`\`

Pause before commit/rebase/reset and resume afterward.
`;

const MENDCODE_MCP_EXAMPLE = `${JSON.stringify({
  mcpServers: {
    mflow: {
      command: "pnpm",
      args: ["--package=mflow-cli", "dlx", "mflow-mcp", "--root", "/absolute/path/to/repo"],
    },
  },
}, null, 2)}\n`;
