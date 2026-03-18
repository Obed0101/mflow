import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import {
  MFLOW_DIR,
  MFLOW_CONFIG_FILE,
  MFLOW_IGNORE_FILE,
  MFLOW_CRDT_DIR,
  DEFAULT_IGNORE_PATTERNS,
} from "@mflow/shared";
import { displaySuccess, displayInfo, displayWarning } from "../display.js";

// ─── Default Config Template ────────────────────────────────

const DEFAULT_CONFIG_TOML = `[daemon]
name = ""
type = "auto"

[sync]
signaling = "wss://signal.mflow.dev"
room = ""
# secret: set via MFLOW_SECRET env var or 'mflow join' command
debounce_ms = 50
max_file_size_bytes = 1048576
max_tracked_files = 5000
unload_after_minutes = 5

[sync.ignore]
patterns = [
  "node_modules",
  ".env*",
  "*.lock",
  "dist/",
  "build/",
  ".git/",
  ".mflow/",
]

[awareness]
broadcast_interval_ms = 5000
share_current_file = true

[transport]
stun_servers = [
  "stun:stun.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
]
reconnect_max_delay_ms = 30000
`;

// ─── Init Command ───────────────────────────────────────────

export async function initCommand(projectRoot: string): Promise<void> {
  const mflowDir = join(projectRoot, MFLOW_DIR);
  const configPath = join(projectRoot, MFLOW_CONFIG_FILE);
  const ignorePath = join(projectRoot, MFLOW_IGNORE_FILE);
  const crdtDir = join(projectRoot, MFLOW_CRDT_DIR);

  // Check if already initialized
  const exists = await access(mflowDir).then(() => true).catch(() => false);
  if (exists) {
    displayWarning("Project already initialized — .mflow/ exists");
    displayInfo(`Config: ${configPath}`);
    return;
  }

  // Create directories
  await mkdir(mflowDir, { recursive: true });
  await mkdir(crdtDir, { recursive: true });

  // Write default config
  await writeFile(configPath, DEFAULT_CONFIG_TOML, "utf-8");

  // Generate .mflowignore from .gitignore + defaults
  let ignoreContent = "# Mflow ignore patterns\n# Uses .gitignore syntax\n\n";

  // Read .gitignore if it exists
  const gitignorePath = join(projectRoot, ".gitignore");
  try {
    const gitignore = await readFile(gitignorePath, "utf-8");
    ignoreContent += "# From .gitignore:\n" + gitignore.trim() + "\n\n";
  } catch {
    // No .gitignore — fine
  }

  // Add default patterns that aren't already in .gitignore
  ignoreContent += "# Mflow defaults:\n";
  for (const pattern of DEFAULT_IGNORE_PATTERNS) {
    ignoreContent += pattern + "\n";
  }

  await writeFile(ignorePath, ignoreContent, "utf-8");

  // Ensure .mflow/ is in .gitignore
  const gitignorePath2 = join(projectRoot, ".gitignore");
  try {
    const gitignoreContent = await readFile(gitignorePath2, "utf-8");
    if (!gitignoreContent.split("\n").some((line) => line.trim() === ".mflow/" || line.trim() === ".mflow")) {
      await writeFile(gitignorePath2, gitignoreContent.trimEnd() + "\n\n# mflow local state\n.mflow/\n", "utf-8");
      displayInfo("Added .mflow/ to .gitignore");
    }
  } catch {
    // No .gitignore exists — create one with .mflow/
    await writeFile(gitignorePath2, "# mflow local state\n.mflow/\n", "utf-8");
    displayInfo("Created .gitignore with .mflow/");
  }

  displaySuccess("Initialized mflow project");
  displayInfo(`Config: ${configPath}`);
  displayInfo(`Ignore: ${ignorePath}`);
}

/**
 * Ensure .mflow/ directory exists for commands that auto-bootstrap.
 * Returns true if it was already initialized, false if we just created it.
 */
export async function ensureMflowDir(projectRoot: string): Promise<boolean> {
  const mflowDir = join(projectRoot, MFLOW_DIR);
  const exists = await access(mflowDir).then(() => true).catch(() => false);
  if (exists) return true;

  await initCommand(projectRoot);
  return false;
}
