import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { DEFAULT_SIGNALING_URL, MFLOW_CONFIG_FILE, MFLOW_DIR } from "../../../shared/src/index.js";
import { displayInfo, displaySuccess, displayWarning, getBanner } from "../display.js";

interface SetupAnswers {
  room: string;
  signaling: string;
  storeRoomSecret: boolean;
  roomSecret: string;
  apiKey: string;
}

export async function setupCommand(projectRoot: string): Promise<void> {
  if (!input.isTTY || !output.isTTY) {
    throw new Error("mflow setup requires an interactive terminal. Use mflow start --room <room> --secret <secret> for scripts.");
  }

  console.log(getBanner());
  console.log("");
  console.log("Guided setup for local mflow sync.");
  console.log("");

  const rl = createInterface({ input, output });
  try {
    const answers = await collectSetupAnswers(rl);
    await writeSetupFiles(projectRoot, answers);

    displaySuccess("mflow setup complete");
    displayInfo(`Config: ${join(projectRoot, MFLOW_CONFIG_FILE)}`);
    if (answers.apiKey) displayInfo(`Hosted API key saved locally in ${join(projectRoot, MFLOW_DIR, "credentials.json")}`);
    console.log("");
    console.log("Start sync:");
    if (answers.storeRoomSecret) {
      console.log("  mflow start");
    } else {
      console.log(`  MFLOW_SECRET="<room-secret>" mflow start --room ${answers.room}`);
    }
    console.log("");
    console.log("MCP:");
    console.log("  bunx -p mflow-cli mflow-mcp --root .");
  } finally {
    rl.close();
  }
}

async function collectSetupAnswers(
  rl: ReturnType<typeof createInterface>,
): Promise<SetupAnswers> {
  const roomDefault = basename(projectRoot) || "mflow-room";
  console.log("Room names identify who can meet in the same sync session. Peers must use the same room and secret.");
  const room = normalizeAnswer(await rl.question(`Room name (${roomDefault}): `), roomDefault);
  const relayMode = normalizeAnswer(
    await rl.question("Relay: hosted free tier with fair-use limits, or self-hosted URL? (hosted/self-hosted): "),
    "hosted",
  ).toLowerCase();
  const signaling = relayMode.startsWith("self")
    ? normalizeAnswer(await rl.question("Self-hosted relay URL (ws:// or wss://): "), DEFAULT_SIGNALING_URL)
    : DEFAULT_SIGNALING_URL;

  const generateSecret = normalizeAnswer(await rl.question("Generate a new room secret? (Y/n): "), "y").toLowerCase() !== "n";
  const roomSecret = generateSecret
    ? randomBytes(32).toString("hex")
    : await questionHidden(rl, "Paste room secret (input hidden): ");

  const storeRoomSecret = normalizeAnswer(
    await rl.question("Store room secret in local .mflow/config.toml? This is convenient but less portable. (y/N): "),
    "n",
  ).toLowerCase() === "y";

  const apiKey = await questionHidden(
    rl,
    "Paste hosted dashboard API key from /settings (optional, input hidden): ",
  );

  return { room, signaling, roomSecret, storeRoomSecret, apiKey };
}

async function writeSetupFiles(projectRoot: string, answers: SetupAnswers): Promise<void> {
  const mflowDir = join(projectRoot, MFLOW_DIR);
  await mkdir(mflowDir, { recursive: true });

  const config = `[daemon]
name = ""
type = "auto"

[sync]
signaling = "${escapeToml(answers.signaling)}"
room = "${escapeToml(answers.room)}"
${answers.storeRoomSecret ? `secret = "${escapeToml(answers.roomSecret)}"` : "# secret: set via MFLOW_SECRET env var or 'mflow start --secret'"}
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

  const configPath = join(projectRoot, MFLOW_CONFIG_FILE);
  await writeFile(configPath, config, { encoding: "utf-8", mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => {});

  if (answers.apiKey) {
    const credentialsPath = join(mflowDir, "credentials.json");
    await writeFile(
      credentialsPath,
      `${JSON.stringify({ hostedApiKey: answers.apiKey }, null, 2)}\n`,
      { encoding: "utf-8", mode: 0o600 },
    );
    await chmod(credentialsPath, 0o600).catch(() => {});
  }

  if (!answers.storeRoomSecret) {
    displayWarning("Room secret was not stored. Keep it in a password manager or export MFLOW_SECRET before starting.");
  }
}

function normalizeAnswer(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed || fallback;
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function questionHidden(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  if (!input.isTTY) return (await rl.question(prompt)).trim();

  const mutableOutput = output as typeof output & { muted?: boolean };
  const originalWrite = mutableOutput.write.bind(mutableOutput);
  mutableOutput.muted = true;
  mutableOutput.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error) => void) => {
    if (!mutableOutput.muted) return originalWrite(chunk, encoding, cb);
    const text = chunk.toString();
    if (text.includes("\n")) return originalWrite("\n", encoding, cb);
    return true;
  }) as typeof output.write;

  try {
    const answer = await rl.question(prompt);
    return answer.trim();
  } finally {
    mutableOutput.muted = false;
    mutableOutput.write = originalWrite as typeof output.write;
  }
}
