import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TMP = join(ROOT, '.tmp'); // git-ignored
const created: string[] = [];

/** A new temp directory holding `files` (relative path -> content). Removed by cleanup(). */
export function tempDir(files: Record<string, string | Buffer> = {}): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, 'test-'));
  created.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

/** A temp copy of `source` with `extra` files added. */
export function copyOf(source: string, extra: Record<string, string | Buffer> = {}): string {
  const dir = tempDir();
  cpSync(source, dir, { recursive: true });
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}

export function cleanup(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** Path relative to `base`, with forward slashes. */
export function rel(base: string, file: string): string {
  return file.slice(base.length + 1).replace(/\\/g, '/');
}
