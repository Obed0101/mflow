import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { MFLOW_CONFIG_FILE } from "../../../shared/src/index.js";
import { displayError, displayInfo, displaySuccess } from "../display.js";

export async function secretCommand(projectRoot: string, options: { copy?: boolean } = {}): Promise<void> {
  const content = await readFile(join(projectRoot, MFLOW_CONFIG_FILE), "utf-8").catch(() => "");
  const secret = readTomlString(content, "secret");

  if (!secret) {
    displayError("No room secret found in .mflow/config.toml");
    displayInfo("Run 'mflow setup' or 'mflow start --secret <value>' first.");
    process.exitCode = 1;
    return;
  }

  if (options.copy) {
    const copied = await copyToClipboard(secret);
    if (!copied) {
      displayError("Could not copy secret to clipboard.");
      process.exitCode = 1;
      return;
    }
    displaySuccess("Secret copied to clipboard.");
    return;
  }

  console.log(secret);
}

function readTomlString(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^${key}\\s*=\\s*"((?:\\\\.|[^"])*)"`, "m"));
  if (!match) return undefined;
  return match[1].replaceAll('\\"', '"').replaceAll("\\\\", "\\");
}

async function copyToClipboard(secret: string): Promise<boolean> {
  const platform = process.platform;
  const copyCmd = platform === "darwin"
    ? ["pbcopy"]
    : platform === "win32"
      ? ["clip"]
      : ["xclip", "-selection", "clipboard"];
  try {
    const proc = spawn(copyCmd[0], copyCmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    proc.stdin?.write(secret);
    proc.stdin?.end();
    const code: number = await new Promise((resolve) => proc.on("close", resolve));
    return code === 0;
  } catch {
    return false;
  }
}
