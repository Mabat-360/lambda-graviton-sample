#!/usr/bin/env node
// npm run demo:fail  plants a fake x86-64 native addon in a temp copy of the example
//                    bundles, runs the build-time check and exits with its status (1).
// npm run demo:pass  does the same with an AArch64 addon; the check passes (0).
// The check's own output is printed unchanged. The copy stays in .tmp/ (git-ignored), so
// the printed command can be run again by hand.

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EM_AARCH64, EM_X86_64, FUNCTIONS_DIR, ensureExampleBinaries, writeFakeElf } from '../example/fake-elf.mjs';

const mode = process.argv[2];
if (mode !== 'fail' && mode !== 'pass') {
  console.error('usage: node scripts/demo.mjs fail|pass');
  process.exit(2);
}

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const demoDir = path.join('.tmp', `demo-${mode}`); // git-ignored
const bundles = path.join(demoDir, 'bundles');
const shown = bundles.split(path.sep).join('/');
const addon = 'node_modules/fast-thing/build/Release/addon.node';

ensureExampleBinaries(); // the pdf-export bundle's x86-64 "renderer"
rmSync(demoDir, { recursive: true, force: true });
mkdirSync(bundles, { recursive: true });
cpSync(FUNCTIONS_DIR, bundles, { recursive: true });
writeFakeElf(path.join(bundles, 'hello-node', addon), mode === 'fail' ? EM_X86_64 : EM_AARCH64);

const run = spawnSync(process.execPath, ['lib/native-binary-check.mjs', '--dir', bundles, '--allow', 'pdf-export'], {
  encoding: 'utf8',
});

console.log(
  [
    `Copied example/functions to ${shown}`,
    `Planted a fake ${mode === 'fail' ? 'x86-64' : 'AArch64'} native addon in the pure-JS bundle: hello-node/${addon}`,
    `$ node lib/native-binary-check.mjs --dir ${shown} --allow pdf-export`,
    (run.stdout + run.stderr).trimEnd(),
    `exit code: ${run.status}`,
  ].join('\n'),
);
process.exitCode = run.status ?? 1;
