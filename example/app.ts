// Example CDK app. Run it without the CDK CLI and without an AWS account:
//   npm run synth
// It writes cdk.out/, prints the architecture of every function, and exits non-zero when
// the aspect raised an error annotation (the CDK CLI refuses a stack with error annotations).

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { GravitonDefaultAspect, x86ExceptionFor } from '../lib/graviton-default-aspect.js';
import { ExampleStack, X86_FUNCTIONS } from './example-stack.js';
import { ensureExampleBinaries } from './fake-elf.mjs';

// A real project gets its binaries from its bundler. This sample fabricates a fake one.
ensureExampleBinaries();

const app = new cdk.App({ outdir: process.env.CDK_OUTDIR ?? 'cdk.out' });

// Context `helloNodeAssetDir` (set through CDK_CONTEXT_JSON) swaps the pure-JS function's
// asset folder, to try the app against a folder with a planted binary.
const helloNodeAssetDir = app.node.tryGetContext('helloNodeAssetDir') as string | undefined;
const stack = new ExampleStack(app, 'GravitonExample', { assetDirs: { helloNode: helloNodeAssetDir } });

// Mutating priority: the aspect runs before read-only checks that look at the architecture.
cdk.Aspects.of(app).add(new GravitonDefaultAspect({ x86Functions: X86_FUNCTIONS }), {
  priority: cdk.AspectPriority.MUTATING,
});

const assembly = app.synth();

const rows = stack.node
  .findAll()
  .filter((c): c is lambda.CfnFunction => c instanceof lambda.CfnFunction)
  .map((fn) => {
    const archs = stack.resolve(fn.architectures) as string[] | undefined;
    const listed = x86ExceptionFor(fn.node.path, X86_FUNCTIONS);
    return {
      path: fn.node.path,
      runtime: String(stack.resolve(fn.runtime)),
      arch: archs?.join(',') ?? (listed ? 'x86_64 (Lambda default; on the exception list)' : 'not set'),
    };
  });
const width = Math.max(...rows.map((r) => r.path.length), 'function'.length) + 2;
console.log('function'.padEnd(width) + 'runtime'.padEnd(13) + 'architecture');
for (const r of rows) console.log(r.path.padEnd(width) + r.runtime.padEnd(13) + r.arch);

const errors = assembly.stacksRecursively.flatMap((s) => s.messages.filter((m) => m.level === 'error'));
if (errors.length > 0) {
  console.error(errors.map((m) => `[Error at ${m.id}] ${String(m.entry.data)}`).join('\n'));
  console.error(`synth failed: ${errors.length} error(s)`);
  process.exitCode = 1;
}
