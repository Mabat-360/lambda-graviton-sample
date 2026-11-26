// Offline tests of scripts/leak-scan.mjs. Every fixture is built at test time from pieces,
// so that no file in this repository contains what the scan looks for.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ROOT, cleanup, tempDir } from './helpers.js';

after(cleanup);

const SCANNER = join(ROOT, 'scripts', 'leak-scan.mjs');

function scan(dir: string, deny?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.LEAK_DENY;
  if (deny !== undefined) env.LEAK_DENY = deny;
  return spawnSync(process.execPath, [SCANNER, dir], { cwd: ROOT, env, encoding: 'utf8' });
}

const BACKSLASH = String.fromCharCode(92);

/** One line per rule: [rule, text that must be caught]. */
const LEAKS: [string, string][] = [
  ['aws-account-id', `account ${'1234'.repeat(3)} here`],
  ['aws-arn', ['arn', 'aws', 'iam'].join(':')],
  ['aws-access-key', `${'AK'}${'IA'}${'A1'.repeat(8)}`],
  ['aws-access-key', `${'AS'}${'IA'}${'B2'.repeat(8)}`],
  ['private-key', `${'-'.repeat(5)}BEGIN RSA ${'PRIVATE'} KEY${'-'.repeat(5)}`],
  ['github-token', `${'gh'}p_${'a1'.repeat(18)}`],
  ['github-token', `${'github'}_pat_${'a1'.repeat(11)}`],
  ['slack-token', `${'xo'}xb-${'1a'.repeat(6)}`],
  ['windows-path', `C:${BACKSLASH}temp${BACKSLASH}file`],
  ['windows-path', `"D:${'/'}temp/file"`],
  ['home-path', `${'/'}Users${'/'}someone/file`],
  ['home-path', `${'/'}home${'/'}someone/file`],
];

describe('leak scan', () => {
  it('passes a clean directory, and skips node_modules, cdk.out, .tmp and .git', () => {
    const leak = LEAKS[0][1];
    const dir = tempDir({
      'src/index.js': 'export const answer = 42;\n',
      'notes.md': 'An 11-digit number 12345678901 and a 13-digit one 1234567890123 are not account IDs.\n',
      'node_modules/pkg/index.js': leak,
      'cdk.out/template.json': leak,
      '.tmp/scratch.txt': leak,
      '.git/config': leak,
    });
    const run = scan(dir);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /leak scan: 2 file\(s\) scanned, no hits/);
  });

  it('catches every pattern, as file:line, and exits 1', () => {
    const dir = tempDir({ 'docs/leaky.txt': ['a clean first line', ...LEAKS.map(([, text]) => text)].join('\n') });
    const run = scan(dir);
    assert.equal(run.status, 1, run.stdout);
    const reported = run.stderr.trim().split('\n');
    LEAKS.forEach(([rule], i) => {
      const prefix = `docs/leaky.txt:${i + 2}: ${rule}: `;
      assert.ok(reported.some((l) => l.startsWith(prefix)), `${prefix} missing in\n${run.stderr}`);
    });
    assert.match(reported[reported.length - 1], /hit\(s\) in 1 file\(s\); 1 file\(s\) scanned/);
  });

  it('does not print a whole secret', () => {
    const secret = LEAKS[2][1];
    const run = scan(tempDir({ 'key.txt': secret }));
    assert.equal(run.status, 1);
    assert.ok(!run.stderr.includes(secret));
    assert.match(run.stderr, /key\.txt:1: aws-access-key: .{4}\.\.\.\(20 chars\)/);
  });

  it('refuses the words in LEAK_DENY, case-insensitively, in file contents and in file names', () => {
    const dir = tempDir({ 'readme.txt': 'Built for the Acme-Internal team.\n', 'acme-internal/notes.txt': 'nothing here\n' });
    assert.equal(scan(dir).status, 0);
    const run = scan(dir, 'something-else, acme-internal');
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /readme\.txt:1: deny-list: /);
    assert.match(run.stderr, /acme-internal\/notes\.txt:0: deny-list: /);
  });

  it('exits 2 when the directory does not exist', () => {
    assert.equal(scan(join(ROOT, 'no-such-directory')).status, 2);
  });
});
