// ─── Limits ──────────────────────────────────────────────────

export const MAX_FILE_SIZE_BYTES = 1_048_576; // 1MB
export const MAX_TRACKED_FILES = 5_000;
export const TRACKED_FILES_WARNING = 4_000;
export const MAX_PEERS_PER_ROOM = 10;

// ─── Timing ──────────────────────────────────────────────────

export const DEFAULT_DEBOUNCE_MS = 50;
export const AWARENESS_BROADCAST_MS = 5_000;
export const YDOC_UNLOAD_MINUTES = 5;
export const WRITE_TOKEN_TTL_MS = 5_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RENAME_DETECTION_WINDOW_MS = 500;

// ─── Rate Limits ─────────────────────────────────────────────

export const RATE_LIMIT_JOINS_PER_MINUTE = 10;
export const RATE_LIMIT_MESSAGES_PER_MINUTE = 100;
export const RATE_LIMIT_VIOLATIONS_BEFORE_DISCONNECT = 3;

// ─── Networking ──────────────────────────────────────────────

export const DEFAULT_SIGNALING_URL = "wss://mflow-signal.obed0101.deno.net";
export const DEFAULT_STUN_SERVERS = [
  "stun:stun.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

// ─── Paths ───────────────────────────────────────────────────

export const MFLOW_DIR = ".mflow";
export const MFLOW_CONFIG_FILE = ".mflow/config.toml";
export const MFLOW_IGNORE_FILE = ".mflowignore";
export const MFLOW_PID_FILE = ".mflow/daemon.pid";
export const MFLOW_SOCK_FILE = ".mflow/daemon.sock";
export const MFLOW_CRDT_DIR = ".mflow/crdt";
export const MFLOW_MANIFEST_FILE = ".mflow/crdt/manifest.json";

// ─── Default Ignore Patterns ─────────────────────────────────

export const DEFAULT_IGNORE_PATTERNS = [
  "node_modules",
  ".env*",
  "*.lock",
  "dist/",
  "build/",
  ".git/",
  ".mflow/",
  ".agents/",
  ".next/",
  ".turbo/",
  "coverage/",
  "*.pyc",
  "__pycache__/",
  ".DS_Store",
  "Thumbs.db",
];

// ─── Binary Detection ────────────────────────────────────────

export const BINARY_CHECK_BYTES = 8_192; // Check first 8KB for null bytes
export const KNOWN_BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".avif",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".flac",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".wasm", ".bin", ".exe", ".dll", ".so", ".dylib",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".sqlite", ".db",
]);

// ─── Signaling Hardening ─────────────────────────────────────

export const WS_MAX_PAYLOAD_BYTES = 65_536;
export const UNAUTHENTICATED_TIMEOUT_MS = 10_000;
export const MAX_UNAUTHENTICATED_PER_IP = 5;
export const MAX_UNAUTHENTICATED_GLOBAL = 500;
export const RELAY_DATA_MAX_LENGTH = 65_536;

// ─── Crypto ──────────────────────────────────────────────────

export const HKDF_ENC_INFO = "mflow-enc";
export const NONCE_PEER_PREFIX_BYTES = 4;
export const NONCE_COUNTER_BYTES = 8;
export const NONCE_TOTAL_BYTES = 12; // 96-bit
export const AES_KEY_BITS = 256;
