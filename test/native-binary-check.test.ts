// Offline tests of the build-time check (lib/native-binary-check.mjs) and its CLI.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EM_AARCH64, EM_X86_64, FUNCTIONS_DIR, ensureExampleBinaries, fakeElf } from '../example/fake-elf.mjs';
import { nativeBinaryFiles } from '../lib/graviton-default-aspect.js';
import { assertArchNeutralBundles, nativeFindings, nativeFiles, scanBundles } from '../lib/native-binary-check.mjs';
import { ROOT, cleanup, copyOf, rel, tempDir } from './helpers.js';

ensureExampleBinaries();
after(cleanup);

const CHECKER = join(ROOT, 'lib', 'native-binary-check.mjs');
const cli = (...args: string[]) => spawnSync(process.execPath, [CHECKER, ...args], { cwd: ROOT, encoding: 'utf8' });

/** One of everything: what must be flagged and what must pass. */
function mixedDir(): string {
  return tempDir({
    'index.js': 'exports.handler = async () => 1;',
    'index.py': 'def handler(e, c):\n  return 1\n',
    'node_modules/x/build/addon.node': fakeElf(EM_X86_64),
    'bin/tool': fakeElf(EM_X86_64), // extensionless x86-64 ELF
    'bin/tool-arm64': fakeElf(EM_AARCH64), // AArch64 ELF: fine on arm64
    'node_modules/w/addon-arm64.node': fakeElf(EM_AARCH64), // AArch64 addon: fine on arm64
    'node_modules/y/addon.node': Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), // Mach-O, not Linux
    'node_modules/z/lib/libz.so.1': fakeElf(EM_X86_64),
    'node_modules/packed/bin/browser.br': 'packed',
    short: Buffer.from([0x7f, 0x45]), // too short to be an ELF header
  });
}

const FLAGGED = [
  'bin/tool',
  'node_modules/packed/bin/browser.br',
  'node_modules/x/build/addon.node',
  'node_modules/y/addon.node',
  'node_modules/z/lib/libz.so.1',
];

describe('nativeFiles()', () => {
  it('flags what cannot run on arm64 by content, and passes JavaScript, Python and AArch64 ELF files', () => {
    const dir = mixedDir();
    assert.deepEqual(nativeFiles(dir).map((f) => rel(dir, f)).sort(), FLAGGED);
  });

  it('says what each file is', () => {
    const dir = mixedDir();
    const kinds = Object.fromEntries(nativeFindings(dir).map((f) => [rel(dir, f.file), f.kind]));
    assert.deepEqual(kinds, {
      'bin/tool': 'ELF x86-64',
      'node_modules/packed/bin/browser.br': 'packed binary (.br)',
      'node_modules/x/build/addon.node': 'ELF x86-64',
      'node_modules/y/addon.node': 'native addon, not a Linux ELF',
      'node_modules/z/lib/libz.so.1': 'ELF x86-64',
    });
  });

  it('applies the same rules as the synth-time scan in the aspect', () => {
    const dir = mixedDir();
    assert.deepEqual(nativeBinaryFiles(dir).map((f) => rel(dir, f)).sort(), FLAGGED);
    assert.deepEqual(nativeBinaryFiles(dir).sort(), nativeFiles(dir).sort());
  });
});

describe('scanBundles() and assertArchNeutralBundles()', () => {
  it('the example bundles pass when the pdf-export bundle is allowed', (t) => {
    t.mock.method(console, 'log', () => {}); // the check prints one line when it passes
    const scanned = scanBundles(FUNCTIONS_DIR, ['pdf-export']);
    assert.deepEqual(
      scanned.map((b) => [b.bundle, b.allowed, b.files.length]),
      [['hello-node', false, 0], ['hello-python', false, 0], ['pdf-export', true, 1]],
    );
    assert.doesNotThrow(() => assertArchNeutralBundles(FUNCTIONS_DIR, { allow: ['pdf-export'] }));
  });

  it('throws, naming the bundle and the file, when a bundle outside the list ships a native binary', () => {
    assert.throws(
      () => assertArchNeutralBundles(FUNCTIONS_DIR),
      /FAIL {2}pdf-export ships native binaries, but its Lambda runs on arm64:\n\s+bin\/renderer {2}\(ELF x86-64\)/,
    );
  });
});

describe('CLI', () => {
  it('exits 1 on a .node file and an extensionless x86-64 ELF in an ordinary bundle; allows them only in a listed bundle', () => {
    const files = { 'index.js': 'x', 'node_modules/n/addon.node': fakeElf(EM_X86_64), 'bin/helper': fakeElf(EM_X86_64) };
    const dir = tempDir(Object.fromEntries(Object.entries(files).flatMap(([k, v]) => [[`ordinary/${k}`, v], [`pdf-export/${k}`, v]])));
    const run = cli('--dir', dir, '--allow', 'pdf-export', '--json');
    assert.equal(run.status, 1, run.stderr);
    const out = JSON.parse(run.stdout) as {
      bundles: number;
      violations: { bundle: string; files: { path: string; kind: string }[] }[];
      x86Bundles: { bundle: string }[];
    };
    assert.equal(out.bundles, 2);
    assert.deepEqual(out.violations.map((v) => v.bundle), ['ordinary']);
    assert.deepEqual(out.violations[0].files.map((f) => f.path).sort(), ['bin/helper', 'node_modules/n/addon.node']);
    assert.deepEqual(out.x86Bundles.map((b) => b.bundle), ['pdf-export']);
  });

  it('prints the bundle, the file and the remedy on stderr', () => {
    const dir = copyOf(FUNCTIONS_DIR, { 'hello-node/node_modules/fast-thing/build/Release/addon.node': fakeElf(EM_X86_64) });
    const run = cli('--dir', dir, '--allow', 'pdf-export');
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /FAIL {2}hello-node ships native binaries, but its Lambda runs on arm64:/);
    assert.match(run.stderr, /node_modules\/fast-thing\/build\/Release\/addon\.node {2}\(ELF x86-64\)/);
    assert.match(run.stderr, /1 Lambda bundle\(s\) ship native binaries that cannot run on arm64/);
    assert.match(run.stderr, /3 bundle\(s\) checked, 1 violation\(s\)/);
  });

  it('exits 0 on the example bundles, and on an AArch64 addon', () => {
    const clean = cli('--dir', FUNCTIONS_DIR, '--allow', 'pdf-export');
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /3 bundle\(s\) checked, 0 violation\(s\)/);

    const dir = copyOf(FUNCTIONS_DIR, { 'hello-node/node_modules/fast-thing/build/Release/addon.node': fakeElf(EM_AARCH64) });
    const arm = cli('--dir', dir, '--allow', 'pdf-export');
    assert.equal(arm.status, 0, arm.stderr);
    assert.match(arm.stdout, /ok {4}hello-node/);
  });

  it('exits 2 on a usage error', () => {
    assert.equal(cli().status, 2);
    assert.equal(cli('--dir', join(ROOT, 'no-such-directory')).status, 2);
  });
});
