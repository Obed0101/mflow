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
    const answers = await collectSetupAnswers(rl, projectRoot);
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
  projectRoot: string,
): Promise<SetupAnswers> {
  const roomDefault = basename(projectRoot) || "mflow-room";
  console.log("Room names identify who can meet in the same sync session. Peers must use the same room and secret.");
  const room = normalizeAnswer(await rl.question(`Room name (${roomDefault}): `), roomDefault);
  console.log("");
  const relayMode = await chooseOption(rl, {
    label: "Relay",
    options: [
      {
        key: "1",
        value: "hosted",
        title: "Hosted free tier",
        description: "Fastest path. Shared public relay with fair-use limits.",
      },
      {
        key: "2",
        value: "self-hosted",
        title: "Self-hosted URL",
        description: "Use your own ws:// or wss:// relay endpoint.",
      },
    ],
    defaultValue: "hosted",
  });
  const signaling = relayMode.startsWith("self")
    ? normalizeAnswer(await rl.question("Self-hosted relay URL (ws:// or wss://): "), DEFAULT_SIGNALING_URL)
    : DEFAULT_SIGNALING_URL;

  console.log("");
  const generateSecret = await confirmChoice(
    rl,
    "Room secret",
    "Generate a new high-entropy room secret?",
    true,
  );
  const roomSecret = generateSecret
    ? randomBytes(32).toString("hex")
    : await questionHidden(rl, "Paste room secret (input hidden): ");

  console.log("");
  const storeRoomSecret = await confirmChoice(
    rl,
    "Local storage",
    "Store room secret in local .mflow/config.toml? Convenient, but less portable.",
    false,
  );

  console.log("");
  console.log("Optional hosted API key:");
  console.log("- Create it yourself in the hosted dashboard Settings page.");
  console.log("- Paste it here only if you want this worktree to keep a local copy for future hosted workflows.");
  console.log("- Skip with Enter if you only want room + secret sync.");
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
stun_servers = []
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

interface ChoiceOption {
  key: string;
  value: string;
  title: string;
  description: string;
}

async function chooseOption(
  rl: ReturnType<typeof createInterface>,
  args: {
    label: string;
    options: ChoiceOption[];
    defaultValue: string;
  },
): Promise<string> {
  console.log(`${args.label}:`);
  for (const option of args.options) {
    const marker = option.value === args.defaultValue ? " (default)" : "";
    console.log(`  ${option.key}) ${option.title}${marker}`);
    console.log(`     ${option.description}`);
  }

  const raw = normalizeAnswer(await rl.question(`Choose ${args.label.toLowerCase()} [${args.options[0]?.key}/${args.options[1]?.key}]: `), "");
  const normalized = raw.toLowerCase();
  const byKey = args.options.find((option) => option.key === normalized);
  if (byKey) return byKey.value;
  const byValue = args.options.find((option) => option.value === normalized);
  if (byValue) return byValue.value;
  return args.defaultValue;
}

async function confirmChoice(
  rl: ReturnType<typeof createInterface>,
  label: string,
  question: string,
  defaultValue: boolean,
): Promise<boolean> {
  console.log(`${label}:`);
  console.log(`  1) Yes${defaultValue ? " (default)" : ""}`);
  console.log("  2) No" + (!defaultValue ? " (default)" : ""));
  const raw = normalizeAnswer(await rl.question(`${question} [1/2]: `), "");
  const normalized = raw.toLowerCase();
  if (normalized === "1" || normalized === "y" || normalized === "yes") return true;
  if (normalized === "2" || normalized === "n" || normalized === "no") return false;
  return defaultValue;
}

async function questionHidden(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
): Promise<string> {
  if (!input.isTTY) return (await rl.question(prompt)).trim();

  const mutableOutput = output as typeof output & { muted?: boolean };
  const originalWrite = mutableOutput.write.bind(mutableOutput);
  originalWrite(prompt);
  mutableOutput.muted = true;
  mutableOutput.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error) => void) => {
    if (!mutableOutput.muted) return originalWrite(chunk, encoding, cb);
    const text = chunk.toString();
    if (text.includes("\n")) return originalWrite("\n", encoding, cb);
    return true;
  }) as typeof output.write;

  try {
    const answer = await rl.question("");
    return answer.trim();
  } finally {
    mutableOutput.muted = false;
    mutableOutput.write = originalWrite as typeof output.write;
  }
}
