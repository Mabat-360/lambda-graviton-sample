#!/usr/bin/env node
// Scans the files that would be committed for things that must not be published.
//
//   node scripts/leak-scan.mjs [dir]         (npm run scan; default: the current directory)
//   LEAK_DENY=word1,word2 npm run scan       extra words to refuse, case-insensitive
//
// Prints each hit as file:line and exits 1 on any hit (0 = clean, 2 = usage error).
// Skips the directories node_modules, cdk.out, .tmp and .git. File names are checked too
// (reported as line 0). No dependencies.
//
// The patterns below are written so that this file does not match itself.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'cdk.out', '.tmp', '.git']);

const RULES = [
  // Any 12-digit number: an AWS account ID looks like nothing else.
  { name: 'aws-account-id', pattern: /(?<![0-9])[0-9]{12}(?![0-9])/g },
  { name: 'aws-arn', pattern: /arn[:]aws/g },
  { name: 'aws-access-key', pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  { name: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}/g },
  { name: 'slack-token', pattern: /xox[abeoprs]-[A-Za-z0-9-]{10,}|hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  // A drive letter with a backslash, or with a forward slash when it is not part of a longer word.
  { name: 'windows-path', pattern: /[A-Z]:\\|(?<![A-Za-z])[A-Z]:\/(?!\/)/g },
  { name: 'home-path', pattern: /\/Users\/|\/home\//g },
];

const denyWords = (process.env.LEAK_DENY ?? '')
  .split(',')
  .map((w) => w.trim().toLowerCase())
  .filter((w) => w.length > 0);

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/** Shows where to look without printing a whole secret. */
function mask(text) {
  return text.length <= 4 ? text : `${text.slice(0, 4)}...(${text.length} chars)`;
}

/** Hits in one piece of text: [{ rule, match }]. */
function hitsIn(text) {
  const hits = [];
  for (const { name, pattern } of RULES) {
    for (const m of text.matchAll(pattern)) hits.push({ rule: name, match: m[0] });
  }
  const lower = text.toLowerCase();
  for (const word of denyWords) {
    if (lower.includes(word)) hits.push({ rule: 'deny-list', match: word });
  }
  return hits;
}

const root = path.resolve(process.argv[2] ?? '.');
if (!existsSync(root) || !statSync(root).isDirectory()) {
  console.error(`usage: node scripts/leak-scan.mjs [dir]\nnot a directory: ${process.argv[2]}`);
  process.exit(2);
}

const lines = [];
const filesWithHits = new Set();
let scanned = 0;
for (const file of walkFiles(root)) {
  scanned++;
  const shown = path.relative(root, file).split(path.sep).join('/');
  const report = (lineNo, hit) => {
    filesWithHits.add(shown);
    lines.push(`${shown}:${lineNo}: ${hit.rule}: ${mask(hit.match)}`);
  };
  for (const hit of hitsIn(shown)) report(0, hit);
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((text, i) => {
      for (const hit of hitsIn(text)) report(i + 1, hit);
    });
}

const deny = denyWords.length > 0 ? `, ${denyWords.length} deny-list word(s)` : '';
if (lines.length > 0) {
  lines.push(`leak scan: ${lines.length} hit(s) in ${filesWithHits.size} file(s); ${scanned} file(s) scanned${deny}`);
  console.error(lines.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`leak scan: ${scanned} file(s) scanned${deny}, no hits`);
}
