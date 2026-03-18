import { extname } from "node:path";
import {
  BINARY_CHECK_BYTES,
  DEFAULT_IGNORE_PATTERNS,
  KNOWN_BINARY_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
} from "./constants.js";

// ─── Pattern Types ──────────────────────────────────────────

interface ParsedPattern {
  regex: RegExp;
  negated: boolean;
  directoryOnly: boolean;
  original: string;
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Escape special regex characters except glob wildcards we handle separately.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a gitignore-style glob pattern to a RegExp.
 *
 * Rules implemented:
 * - `*`  matches anything except `/`
 * - `**` matches any number of directories (including zero)
 * - `?`  matches any single char except `/`
 * - Leading `/` anchors to root
 * - Trailing `/` marks directory-only (stripped before regex)
 * - Pattern without `/` (other than trailing) matches against filename only
 */
function globToRegex(pattern: string): { regex: RegExp; matchFullPath: boolean } {
  let matchFullPath = false;

  // Strip trailing slash (directory marker handled separately)
  let p = pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;

  // Leading slash anchors to root — remove it but remember
  let anchored = false;
  if (p.startsWith("/")) {
    anchored = true;
    p = p.slice(1);
    matchFullPath = true;
  }

  // If pattern contains a `/` (after stripping leading), it matches full path
  if (p.includes("/")) {
    matchFullPath = true;
  }

  // Build regex from the pattern segments
  const regexStr = buildGlobRegex(p);

  // Anchor: if anchored (had leading /) match from start,
  // otherwise if matchFullPath, match from any directory boundary
  let fullRegex: string;
  if (anchored) {
    fullRegex = `^${regexStr}$`;
  } else if (matchFullPath) {
    fullRegex = `(?:^|/)${regexStr}$`;
  } else {
    // filename-only match: match against basename
    fullRegex = regexStr;
  }

  return { regex: new RegExp(fullRegex), matchFullPath };
}

function buildGlobRegex(pattern: string): string {
  let result = "";
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` or `**` at end
        if (pattern[i + 2] === "/") {
          // `**/` — matches zero or more directories
          result += "(?:.+/)?";
          i += 3;
        } else {
          // `**` at end — matches everything
          result += ".*";
          i += 2;
        }
      } else {
        // Single `*` — anything except `/`
        result += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      result += "[^/]";
      i += 1;
    } else {
      result += escapeRegex(ch);
      i += 1;
    }
  }

  return result;
}

function parseLine(raw: string): ParsedPattern | null {
  // Trim trailing whitespace (but not leading — leading spaces are significant in gitignore? no, trim both trailing)
  let line = raw.trimEnd();

  // Skip empty lines and comments
  if (line === "" || line.startsWith("#")) {
    return null;
  }

  // Trim leading whitespace
  line = line.trimStart();

  // Check negation
  let negated = false;
  if (line.startsWith("!")) {
    negated = true;
    line = line.slice(1);
  }

  // Check directory-only
  const directoryOnly = line.endsWith("/");

  // Convert glob to regex
  const { regex, matchFullPath } = globToRegex(line);

  return {
    regex,
    negated,
    directoryOnly,
    original: raw.trim(),
  };
}

// ─── IgnoreFilter ───────────────────────────────────────────

export class IgnoreFilter {
  private patterns: ParsedPattern[] = [];
  private rawPatterns: string[] = [];

  constructor(patterns: string[]) {
    this.addPatterns(patterns);
  }

  /**
   * Parse patterns from file content (.gitignore / .mflowignore format).
   * Each line is treated as one pattern.
   */
  addFromFile(content: string): void {
    const lines = content.split(/\r?\n/);
    this.addPatterns(lines);
  }

  /**
   * Add individual patterns.
   */
  addPatterns(patterns: string[]): void {
    for (const raw of patterns) {
      const parsed = parseLine(raw);
      if (parsed) {
        this.patterns.push(parsed);
        this.rawPatterns.push(parsed.original);
      }
    }
  }

  /**
   * Test if a file path should be ignored.
   * @param filePath - relative path (forward slashes, no leading `/`)
   */
  isIgnored(filePath: string): boolean {
    // Normalize to forward slashes, strip leading ./
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const basename = normalized.includes("/")
      ? normalized.slice(normalized.lastIndexOf("/") + 1)
      : normalized;

    let ignored = false;

    for (const pattern of this.patterns) {
      // Determine what to test against
      const testValue = this.shouldMatchFullPath(pattern)
        ? normalized
        : basename;

      const matches = pattern.regex.test(testValue);
      if (matches) {
        ignored = !pattern.negated;
      }
    }

    return ignored;
  }

  /**
   * Get all current raw patterns.
   */
  getPatterns(): string[] {
    return [...this.rawPatterns];
  }

  /**
   * Determine if a pattern should match against the full path or just the basename.
   * Patterns containing `/` (other than trailing) match full path.
   */
  private shouldMatchFullPath(pattern: ParsedPattern): boolean {
    const raw = pattern.original;
    // Remove negation prefix and trailing slash for analysis
    let cleaned = raw.startsWith("!") ? raw.slice(1) : raw;
    if (cleaned.endsWith("/")) cleaned = cleaned.slice(0, -1);

    // If it starts with / or contains / it's a path pattern
    return cleaned.startsWith("/") || cleaned.includes("/");
  }
}

// ─── Binary Detection ───────────────────────────────────────

/**
 * Check if a file is likely binary.
 * - If `content` is provided, checks first 8KB for null bytes.
 * - Always checks extension against KNOWN_BINARY_EXTENSIONS.
 */
export function isBinaryFile(filePath: string, content?: Buffer): boolean {
  // Extension check
  const ext = extname(filePath).toLowerCase();
  if (KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return true;
  }

  // Content check: look for null bytes in first 8KB
  if (content) {
    const limit = Math.min(content.length, BINARY_CHECK_BYTES);
    for (let i = 0; i < limit; i++) {
      if (content[i] === 0x00) {
        return true;
      }
    }
  }

  return false;
}

// ─── Size Check ─────────────────────────────────────────────

/**
 * Returns true if the file exceeds the maximum allowed size.
 */
export function isFileTooLarge(sizeBytes: number): boolean {
  return sizeBytes > MAX_FILE_SIZE_BYTES;
}

// ─── Combined Sync Decision ─────────────────────────────────

export interface ShouldSyncResult {
  sync: boolean;
  reason?: "ignored" | "binary" | "too_large";
}

/**
 * Determine whether a file should be synced.
 * Checks ignore patterns, binary detection, and size limit.
 */
export function shouldSync(
  filePath: string,
  sizeBytes: number,
  content?: Buffer,
  filter?: IgnoreFilter,
): ShouldSyncResult {
  // 1. Ignore patterns
  if (filter && filter.isIgnored(filePath)) {
    return { sync: false, reason: "ignored" };
  }

  // 2. Binary detection
  if (isBinaryFile(filePath, content)) {
    return { sync: false, reason: "binary" };
  }

  // 3. Size limit
  if (isFileTooLarge(sizeBytes)) {
    return { sync: false, reason: "too_large" };
  }

  return { sync: true };
}

// ─── Default Filter Factory ─────────────────────────────────

/**
 * Create an IgnoreFilter pre-loaded with DEFAULT_IGNORE_PATTERNS.
 */
export function createDefaultFilter(): IgnoreFilter {
  return new IgnoreFilter(DEFAULT_IGNORE_PATTERNS);
}
