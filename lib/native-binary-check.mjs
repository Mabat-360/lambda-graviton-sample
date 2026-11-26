#!/usr/bin/env node
// Build-time check: fail the build when a Lambda bundle that will run on arm64 ships a
// native binary that cannot run there.
//
// A bundle is flagged when it holds a .br packed binary, an ELF file (any name) built for
// another machine than AArch64, or a .node / .so file that is not an AArch64 ELF. Files
// are judged by content, not by name: an AArch64 ELF passes. Same rules as
// nativeBinaryFiles() in lib/graviton-default-aspect.ts, which applies them at synth time.
//
// From a build script, after bundling:
//   import { assertArchNeutralBundles } from './lib/native-binary-check.mjs';
//   assertArchNeutralBundles('dist/lambdas', { allow: ['pdf-export'] });
//
// CLI:
//   node lib/native-binary-check.mjs --dir <bundles dir> [--allow <bundle>]... [--json]
//     <bundles dir> holds one sub-directory per function bundle.
//     --allow names a bundle whose function stays on x86_64 (keep it in step with the
//     Aspect's exception list).
//   Exit code: 0 = clean, 1 = violation, 2 = usage error.

import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKED_BINARY = /\.br$/;
const NATIVE_NAME = /\.(node|so(\.\d+)*)$/;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const EM_AARCH64 = 0xb7;
const ELF_MACHINES = { 0x03: 'x86 (32-bit)', 0x28: 'ARM (32-bit)', 0x3e: 'x86-64', 0xb7: 'AArch64' };

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full; // symbolic links are not followed
  }
}

/**
 * Files under `dir` (recursive) that cannot run on arm64 Linux, each with what it is.
 * @param {string} dir
 * @returns {{ file: string, kind: string }[]}
 */
export function nativeFindings(dir) {
  const out = [];
  for (const full of walkFiles(dir)) {
    const name = path.basename(full);
    if (PACKED_BINARY.test(name)) {
      out.push({ file: full, kind: 'packed binary (.br)' });
      continue;
    }
    const fd = openSync(full, 'r');
    let head = Buffer.alloc(20);
    try {
      head = head.subarray(0, readSync(fd, head, 0, 20, 0));
    } finally {
      closeSync(fd);
    }
    if (head.length >= 4 && head.subarray(0, 4).equals(ELF_MAGIC)) {
      // e_machine: 2 bytes at offset 18, in the byte order named by EI_DATA (offset 5).
      const machine = head.length >= 20 ? (head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18)) : -1;
      if (machine !== EM_AARCH64) {
        const label = machine < 0 ? 'truncated header' : (ELF_MACHINES[machine] ?? `machine 0x${machine.toString(16)}`);
        out.push({ file: full, kind: `ELF ${label}` });
      }
    } else if (NATIVE_NAME.test(name)) {
      out.push({ file: full, kind: 'native addon, not a Linux ELF' });
    }
  }
  return out;
}

/**
 * Paths only.
 * @param {string} dir
 * @returns {string[]}
 */
export function nativeFiles(dir) {
  return nativeFindings(dir).map((f) => f.file);
}

/**
 * Every bundle (sub-directory of `bundlesDir`) with its native files and whether it may carry them.
 * @param {string} bundlesDir
 * @param {string[]} [allow] bundles whose function stays on x86_64
 * @returns {{ bundle: string, allowed: boolean, files: { path: string, kind: string }[] }[]}
 */
export function scanBundles(bundlesDir, allow = []) {
  return readdirSync(bundlesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(bundlesDir, d.name);
      const files = nativeFindings(dir).map((f) => ({
        path: path.relative(dir, f.file).split(path.sep).join('/'),
        kind: f.kind,
      }));
      return { bundle: d.name, allowed: allow.includes(d.name), files };
    })
    .sort((a, b) => a.bundle.localeCompare(b.bundle));
}

/**
 * The text of a failed check: one block per bundle, then what to do about it.
 * @param {{ bundle: string, files: { path: string, kind: string }[] }[]} bad
 */
export function violationReport(bad) {
  const lines = [];
  for (const b of bad) {
    lines.push(`FAIL  ${b.bundle} ships native binaries, but its Lambda runs on arm64:`);
    for (const f of b.files.slice(0, 10)) lines.push(`        ${f.path}  (${f.kind})`);
    if (b.files.length > 10) lines.push(`        ... and ${b.files.length - 10} more`);
  }
  lines.push(
    `${bad.length} Lambda bundle(s) ship native binaries that cannot run on arm64. Keep the bundle ` +
      'architecture-neutral, ship an AArch64 build, or keep the function on x86_64: add it to the ' +
      "Aspect's exception list with a reason and pass its bundle to this check (--allow <bundle>).",
  );
  return lines.join('\n');
}

/**
 * Throws (failing the build) when a bundle outside `allow` ships a native binary.
 * @param {string} bundlesDir
 * @param {{ allow?: string[] }} [options]
 */
export function assertArchNeutralBundles(bundlesDir, { allow = [] } = {}) {
  const scanned = scanBundles(bundlesDir, allow);
  const bad = scanned.filter((b) => !b.allowed && b.files.length > 0);
  if (bad.length > 0) throw new Error(violationReport(bad));
  console.log(`arm64 check: ${scanned.length} bundle(s), no native binaries outside [${allow.join(', ')}]`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  const values = (name) => args.flatMap((a, i) => (a === name && args[i + 1] !== undefined ? [args[i + 1]] : []));
  const dir = values('--dir')[0];
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error('usage: node lib/native-binary-check.mjs --dir <bundles dir> [--allow <bundle>]... [--json]');
    if (dir) console.error(`not a directory: ${dir}`);
    process.exit(2);
  }
  const allow = values('--allow');
  const results = scanBundles(path.resolve(dir), allow);
  const unknown = allow.filter((a) => !results.some((b) => b.bundle === a));
  const bad = results.filter((b) => !b.allowed && b.files.length > 0);
  const kept = results.filter((b) => b.allowed);
  if (args.includes('--json')) {
    console.log(JSON.stringify({ bundles: results.length, violations: bad, x86Bundles: kept, unknownAllow: unknown }, null, 2));
  } else {
    const lines = [];
    for (const b of results) {
      if (b.allowed) lines.push(`skip  ${b.bundle}  (on the x86_64 list, ${b.files.length} native file(s))`);
      else if (b.files.length === 0) lines.push(`ok    ${b.bundle}`);
    }
    for (const a of unknown) lines.push(`warn  --allow ${a}: no such bundle in ${dir}`);
    if (bad.length > 0) lines.push(violationReport(bad));
    lines.push(`${results.length} bundle(s) checked, ${bad.length} violation(s)`);
    // One stream per run, so the lines cannot interleave: stderr when failing, stdout when clean.
    (bad.length > 0 ? console.error : console.log)(lines.join('\n'));
  }
  process.exitCode = bad.length > 0 ? 1 : 0;
}
