import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { displayInfo, displaySuccess, displayWarning } from "../display.js";

type Harness = "claude" | "opencode" | "codex" | "mendcode" | "all";

interface HookStatusOptions {
  harness?: Harness;
}

interface HarnessStatus {
  name: Exclude<Harness, "all">;
  installed: boolean;
  supported: boolean;
  summary: string;
  details: string[];
  nextStep?: string;
}

export async function hookStatusCommand(
  projectRoot: string,
  options: HookStatusOptions,
): Promise<void> {
  const harness = options.harness ?? "all";
  if (!["claude", "opencode", "codex", "mendcode", "all"].includes(harness)) {
    throw new Error("Invalid harness. Use claude, opencode, codex, mendcode, or all.");
  }

  const statuses = await collectStatuses(projectRoot);
  const selected = harness === "all"
    ? statuses
    : statuses.filter((status) => status.name === harness);

  displayInfo(`Hook status for ${projectRoot}`);
  console.log("");

  for (const status of selected) {
    const label = `${status.name}: ${status.summary}`;
    if (status.installed) {
      displaySuccess(label);
    } else if (status.supported) {
      displayWarning(label);
    } else {
      displayInfo(label);
    }

    for (const detail of status.details) {
      displayInfo(detail);
    }

    if (status.nextStep) {
      displayInfo(status.nextStep);
    }

    console.log("");
  }

  displayInfo("Agent policy: ask the human before installing or changing any harness hook.");
  displayInfo("If approved, run mflow install-hooks for supported harnesses before editing.");
}

async function collectStatuses(projectRoot: string): Promise<HarnessStatus[]> {
  return [
    await getClaudeStatus(projectRoot),
    await getOpenCodeStatus(projectRoot),
    await getCodexStatus(projectRoot),
    await getMendCodeStatus(projectRoot),
  ];
}

async function getClaudeStatus(projectRoot: string): Promise<HarnessStatus> {
  const hookPath = join(projectRoot, ".claude", "hooks", "mflow-lock.mjs");
  const settingsPath = join(projectRoot, ".claude", "settings.local.json");
  const [hookExists, settings] = await Promise.all([
    exists(hookPath),
    readJsonObject(settingsPath),
  ]);

  const hasSettingsEntry = jsonContains(settings, "mflow-lock.mjs");
  const installed = hookExists && hasSettingsEntry;

  return {
    name: "claude",
    installed,
    supported: true,
    summary: installed
      ? "hook installed and configured"
      : "hook missing or incomplete",
    details: [
      formatDetail("hook file", hookExists ? hookPath : "missing"),
      formatDetail("settings entry", hasSettingsEntry ? settingsPath : "missing"),
    ],
    nextStep: installed
      ? `Verified ${hookPath}`
      : "Ask the human for approval, then run: mflow install-hooks --harness claude",
  };
}

async function getOpenCodeStatus(projectRoot: string): Promise<HarnessStatus> {
  const pluginPath = join(projectRoot, ".opencode", "plugins", "mflow-lock.js");
  const installed = await exists(pluginPath);

  return {
    name: "opencode",
    installed,
    supported: true,
    summary: installed
      ? "plugin installed"
      : "plugin missing",
    details: [
      formatDetail("plugin file", installed ? pluginPath : "missing"),
    ],
    nextStep: installed
      ? `Verified ${pluginPath}`
      : "Ask the human for approval, then run: mflow install-hooks --harness opencode",
  };
}

async function getCodexStatus(projectRoot: string): Promise<HarnessStatus> {
  const mcpPath = join(projectRoot, ".mcp.json");
  const codexConfigPath = join(projectRoot, ".codex", "config.toml");
  const scaffoldScriptPath = join(projectRoot, ".codex", "hooks", "mflow-pre-edit.sh");
  const scaffoldPromptPath = join(projectRoot, ".codex", "mflow-agent-prompt.md");
  const scaffoldExamplePath = join(projectRoot, ".codex", "mflow-hook.example.toml");
  const repoSkillPath = join(projectRoot, "skills", "mflow", "SKILL.md");

  const [mcpConfig, codexConfigRaw, scriptExists, promptExists, exampleExists, skillExists] = await Promise.all([
    readJsonObject(mcpPath),
    readTextIfExists(codexConfigPath),
    exists(scaffoldScriptPath),
    exists(scaffoldPromptPath),
    exists(scaffoldExamplePath),
    exists(repoSkillPath),
  ]);

  const hasMflowMcp = jsonContains(mcpConfig, "\"mflow\"") || jsonContains(mcpConfig, "mflow-mcp");
  const hasCodexMflowConfig = codexConfigRaw.includes("mflow");
  const hasScaffold = scriptExists && promptExists && exampleExists;

  const details = [
    formatDetail("repo .mcp.json mflow entry", hasMflowMcp ? mcpPath : "missing"),
    formatDetail("repo .codex/config.toml mflow mention", hasCodexMflowConfig ? codexConfigPath : "missing"),
    formatDetail("experimental scaffold", hasScaffold ? join(projectRoot, ".codex") : "missing"),
    formatDetail("repo skill source", skillExists ? repoSkillPath : "missing"),
  ];

  if (hasScaffold) {
    return {
      name: "codex",
      installed: true,
      supported: true,
      summary: "experimental scaffold installed; enforcement still requires human wiring and build verification",
      details,
      nextStep: "Ask the human before wiring the scaffold into Codex. Verify MCP, prompt path, and edit interception on the current Codex build before relying on it.",
    };
  }

  return {
    name: "codex",
    installed: false,
    supported: true,
    summary: hasMflowMcp || hasCodexMflowConfig
      ? "manual Codex coordination detected; scaffold not installed yet"
      : "Codex still manual; no scaffold installed yet",
    details,
    nextStep: "Ask the human for approval, then run: mflow install-hooks --harness codex. Until verified, keep using MCP + skill/manual coordination.",
  };
}

async function getMendCodeStatus(projectRoot: string): Promise<HarnessStatus> {
  const pluginPath = join(projectRoot, ".mendcode", "plugins", "mflow-lock.js");
  const controlPath = join(projectRoot, ".mendcode", "mflow-control.md");
  const mcpExamplePath = join(projectRoot, ".mendcode", "mcp.mflow.example.json");

  const [pluginExists, controlExists, mcpExampleExists, mcpExample] = await Promise.all([
    exists(pluginPath),
    exists(controlPath),
    exists(mcpExamplePath),
    readJsonObject(mcpExamplePath),
  ]);

  const hasPnpmMcpShape = jsonContains(mcpExample, "pnpm") && jsonContains(mcpExample, "mflow-mcp");
  const hasScaffold = pluginExists && controlExists && mcpExampleExists && hasPnpmMcpShape;

  const details = [
    formatDetail("experimental plugin", pluginExists ? pluginPath : "missing"),
    formatDetail("control guide", controlExists ? controlPath : "missing"),
    formatDetail("pnpm MCP example", hasPnpmMcpShape ? mcpExamplePath : "missing"),
  ];

  if (hasScaffold) {
    return {
      name: "mendcode",
      installed: true,
      supported: true,
      summary: "experimental scaffold present; MendCode UI toggle and hook verification still require MendCode-side implementation",
      details,
      nextStep: "Verify the active MendCode build exposes tool.execute.before, then test that a real file write is blocked when mflow cannot acquire a queued lock.",
    };
  }

  return {
    name: "mendcode",
    installed: false,
    supported: true,
    summary: "MendCode scaffold not installed yet",
    details,
    nextStep: "Ask the human for approval, then run: mflow install-hooks --harness mendcode. Until verified, use MCP + manual mflow lock/claim/pause/resume coordination.",
  };
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
    return {};
  }
  return parsed as Record<string, unknown>;
}

async function readTextIfExists(path: string): Promise<string> {
  if (!await exists(path)) return "";
  return readFile(path, "utf-8");
}

function jsonContains(value: unknown, needle: string): boolean {
  return JSON.stringify(value).includes(needle);
}

function formatDetail(label: string, value: string): string {
  return `${label}: ${value}`;
}
