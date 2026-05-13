import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export interface PatchFileChange {
  action: "add" | "update" | "delete";
  path: string;
  moveTo?: string;
  lines: string[];
}

export function parseMflowPatch(patchText: string): PatchFileChange[] {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const changes: PatchFileChange[] = [];
  let current: PatchFileChange | null = null;
  let inChange = false;

  for (const line of lines) {
    const move = line.match(/^\*\*\* Move to: (.+)$/);
    if (move && current) {
      current.moveTo = normalizePatchPath(move[1]);
      continue;
    }
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      continue;
    }

    const add = line.match(/^\*\*\* Add File: (.+)$/);
    const update = line.match(/^\*\*\* Update File: (.+)$/);
    const del = line.match(/^\*\*\* Delete File: (.+)$/);
    if (add || update || del) {
      current = {
        action: add ? "add" : update ? "update" : "delete",
        path: normalizePatchPath((add ?? update ?? del)![1]),
        lines: [],
      };
      changes.push(current);
      inChange = true;
      continue;
    }

    if (!current || !inChange) continue;
    if (line === "@@" || line.startsWith("@@ ")) {
      continue;
    }
    if (line === "*** End of File") {
      continue;
    }
    if (current.action === "delete") {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ")) {
      current.lines.push(line);
    }
  }

  return changes;
}

export async function applyMflowPatch(projectRoot: string, patchText: string): Promise<string[]> {
  const changes = parseMflowPatch(patchText);
  const changedPaths: string[] = [];

  for (const change of changes) {
    const absolute = resolveProjectPath(projectRoot, change.path);
    if (change.action === "delete") {
      await rm(absolute, { force: true });
      changedPaths.push(change.path);
      continue;
    }

    if (change.action === "add") {
      const content = change.lines
        .filter((line) => line.startsWith("+"))
        .map((line) => line.slice(1))
        .join("\n");
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, content + (content.length > 0 ? "\n" : ""), "utf-8");
      changedPaths.push(change.path);
      continue;
    }

    const oldContent = await readFile(absolute, "utf-8");
    const newContent = applyUpdateLines(oldContent, change.lines, change.path);
    const target = change.moveTo ? resolveProjectPath(projectRoot, change.moveTo) : absolute;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, newContent, "utf-8");
    if (change.moveTo && change.moveTo !== change.path) {
      await rm(absolute, { force: true });
    }
    changedPaths.push(change.moveTo ?? change.path);
  }

  return changedPaths;
}

export function getPatchPaths(patchText: string): string[] {
  return [...new Set(parseMflowPatch(patchText).flatMap((change) => [change.path, change.moveTo].filter(Boolean) as string[]))];
}

function applyUpdateLines(oldContent: string, patchLines: string[], path: string): string {
  const oldLines = oldContent.split("\n");
  if (oldLines.at(-1) === "") oldLines.pop();

  const out: string[] = [];
  let cursor = 0;

  for (const line of patchLines) {
    const marker = line[0];
    const value = line.slice(1);
    if (marker === " ") {
      const foundAt = findLine(oldLines, value, cursor);
      if (foundAt === -1) {
        throw new Error(`Patch context not found in ${path}: ${value}`);
      }
      out.push(...oldLines.slice(cursor, foundAt + 1));
      cursor = foundAt + 1;
      continue;
    }
    if (marker === "-") {
      const foundAt = findLine(oldLines, value, cursor);
      if (foundAt === -1) {
        throw new Error(`Patch removal not found in ${path}: ${value}`);
      }
      out.push(...oldLines.slice(cursor, foundAt));
      cursor = foundAt + 1;
      continue;
    }
    if (marker === "+") {
      out.push(value);
    }
  }

  out.push(...oldLines.slice(cursor));
  return out.join("\n") + (oldContent.endsWith("\n") ? "\n" : "");
}

function findLine(lines: string[], value: string, start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i] === value) return i;
  }
  return -1;
}

function normalizePatchPath(path: string): string {
  return path.trim().replace(/^["']|["']$/g, "");
}

function resolveProjectPath(projectRoot: string, path: string): string {
  const absolute = resolve(projectRoot, path);
  const rel = relative(projectRoot, absolute);
  if (!rel || rel.startsWith("..")) {
    throw new Error(`Patch path escapes project root: ${path}`);
  }
  return absolute;
}
