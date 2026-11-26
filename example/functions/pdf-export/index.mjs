// Stands in for a function that shells out to a prebuilt x86-64 binary (bin/renderer).
// The binary is why this function is on the exception list and stays on x86_64.
// In this sample bin/renderer is a fake 64-byte ELF header written by example/fake-elf.mjs.
import { existsSync } from 'node:fs';

export const handler = async () => ({
  statusCode: 200,
  body: JSON.stringify({ renderer: existsSync(new URL('./bin/renderer', import.meta.url)), arch: process.arch }),
});
