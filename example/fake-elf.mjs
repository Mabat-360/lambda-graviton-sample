#!/usr/bin/env node
// Fabricates the "native binaries" the example, the tests and the demos need, so that this
// repository carries no binary file. A fake ELF is a 64-byte ELF64 header: the magic
// number, then e_machine at offset 18 (0x3E = x86-64, 0xB7 = AArch64). It cannot be
// executed; the checks only read the header.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EM_X86_64 = 0x3e;
export const EM_AARCH64 = 0xb7;

/**
 * A 64-byte little-endian ELF64 header for `machine`.
 * @param {number} machine
 * @returns {Buffer}
 */
export function fakeElf(machine) {
  const b = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(b); // magic, 64-bit, little-endian, version 1
  b.writeUInt16LE(3, 16); // e_type: ET_DYN (shared object)
  b.writeUInt16LE(machine, 18); // e_machine
  b.writeUInt32LE(1, 20); // e_version
  return b;
}

/**
 * Writes a fake ELF for `machine` to `file`, creating its directory. Leaves an identical file alone.
 * @param {string} file
 * @param {number} machine
 * @returns {string} `file`
 */
export function writeFakeElf(file, machine) {
  const bytes = fakeElf(machine);
  if (existsSync(file) && readFileSync(file).equals(bytes)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

export const FUNCTIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'functions');

/** The pdf-export function's x86-64 "renderer". Git-ignored, written before every synth, test and demo. */
export function ensureExampleBinaries() {
  return writeFakeElf(path.join(FUNCTIONS_DIR, 'pdf-export', 'bin', 'renderer'), EM_X86_64);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`wrote ${path.relative(process.cwd(), ensureExampleBinaries())} (fake x86-64 ELF header, 64 bytes)`);
}
