import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { displayInfo, displaySuccess, displayWarning } from "../display.js";

type Harness = "claude" | "opencode" | "all";

interface InstallHooksOptions {
  harness?: Harness;
  force?: boolean;
}

export async function installHooksCommand(
  projectRoot: string,
  options: InstallHooksOptions,
): Promise<void> {
  const harness = options.harness ?? "all";
  if (!["claude", "opencode", "all"].includes(harness)) {
    throw new Error("Invalid harness. Use claude, opencode, or all.");
  }

  if (harness === "claude" || harness === "all") {
    await installClaudeHooks(projectRoot, Boolean(options.force));
  }
  if (harness === "opencode" || harness === "all") {
    await installOpenCodePlugin(projectRoot, Boolean(options.force));
  }

  displaySuccess("mflow hook installation complete");
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
