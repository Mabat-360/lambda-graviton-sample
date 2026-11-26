// Offline tests: no AWS account, no credentials, no CDK CLI. Run with `npm test`.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { ExampleStack, X86_FUNCTIONS, type ExampleStackProps } from '../example/example-stack.js';
import { EM_AARCH64, EM_X86_64, FUNCTIONS_DIR, ensureExampleBinaries, fakeElf } from '../example/fake-elf.mjs';
import {
  ARM64,
  CDK_PROVIDER_EXCEPTIONS,
  GravitonDefaultAspect,
  X86_64,
  architectureDecision,
  type X86Exception,
} from '../lib/graviton-default-aspect.js';
import { ROOT, cleanup, copyOf, tempDir } from './helpers.js';

ensureExampleBinaries(); // example/functions/pdf-export/bin/renderer, a fake x86-64 ELF
after(cleanup);

const HELLO = join(FUNCTIONS_DIR, 'hello-node');
const HANDLER_JS = 'exports.handler = async () => 1;';

type FnResource = { Properties: { Architectures?: string[] }; Metadata?: { 'aws:cdk:path'?: string } };

function newApp(): cdk.App {
  return new cdk.App({ outdir: tempDir(), context: { 'aws:cdk:enable-path-metadata': true } });
}

function addAspect(app: cdk.App, x86Functions: readonly X86Exception[]): void {
  cdk.Aspects.of(app).add(new GravitonDefaultAspect({ x86Functions }), { priority: cdk.AspectPriority.MUTATING });
}

/** Synthesises the stack. Returns Architectures by construct path and the error annotations (what fails `cdk synth`). */
function read(stack: cdk.Stack) {
  const template = Template.fromStack(stack);
  const arch = new Map<string, string[] | undefined>();
  for (const [id, r] of Object.entries(template.findResources('AWS::Lambda::Function')) as [string, FnResource][]) {
    arch.set(r.Metadata?.['aws:cdk:path'] ?? id, r.Properties.Architectures);
  }
  const errors = Annotations.fromStack(stack)
    .findError('*', Match.anyValue())
    .map((m) => String(m.entry.data));
  return { arch, errors };
}

/** The example stack with the example's own exception list. */
function synthExample(assetDirs: ExampleStackProps['assetDirs'] = {}, tweak?: (stack: ExampleStack) => void) {
  const app = newApp();
  const stack = new ExampleStack(app, 'Example', { assetDirs });
  tweak?.(stack);
  addAspect(app, X86_FUNCTIONS);
  return read(stack);
}

/** A stack built by `build`, in an app with the aspect. */
function synth(build: (stack: cdk.Stack) => void, x86Functions: readonly X86Exception[] = []) {
  const app = newApp();
  const stack = new cdk.Stack(app, 'Test');
  build(stack);
  addAspect(app, x86Functions);
  return read(stack);
}

function nodeFn(stack: cdk.Stack, id: string, props: Partial<lambda.FunctionProps> = {}): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline(HANDLER_JS),
    ...props,
  });
}

describe('architectureDecision()', () => {
  const list: X86Exception[] = [{ pattern: /^App\/PdfExportFunction\/Resource$/, reason: 'ships an x86-64 renderer binary' }];
  const p = 'App/Some/Resource';

  it('moves a zip Node.js or Python function with no architecture to arm64', () => {
    for (const runtime of ['nodejs20.x', 'nodejs22.x', 'python3.13']) {
      assert.deepEqual(architectureDecision({ path: p, isCfnFunction: true, runtime }, list), { action: 'set-arm64' }, runtime);
    }
  });

  it('keeps a listed function as it is and names the reason', () => {
    const d = architectureDecision({ path: 'App/PdfExportFunction/Resource', isCfnFunction: true, runtime: 'nodejs22.x' }, list);
    assert.deepEqual(d, { action: 'keep', why: 'ships an x86-64 renderer binary', runsOnArm64: false });
  });

  it('matches the list on the construct path only where the pattern says so', () => {
    assert.equal(architectureDecision({ path: 'App/PdfExportFunction/Resource', isCfnFunction: true, runtime: 'nodejs22.x' }, list).action, 'keep');
    assert.equal(architectureDecision({ path: 'App/PdfExportFunction2/Resource', isCfnFunction: true, runtime: 'nodejs22.x' }, list).action, 'set-arm64');
    assert.equal(architectureDecision({ path: 'Other/PdfExportFunction/Resource', isCfnFunction: true, runtime: 'nodejs22.x' }, list).action, 'set-arm64');
  });

  it('fails on anything it cannot decide safely', () => {
    const fnIf = { 'Fn::If': ['IsProd', [X86_64], [ARM64]] };
    const cases = [
      { path: p, isCfnFunction: true, runtime: 'nodejs22.x', architectures: [X86_64] }, // explicit x86_64, not listed
      { path: p, isCfnFunction: true, packageType: 'Image' },
      { path: p, isCfnFunction: true, runtime: 'provided.al2023' },
      { path: p, isCfnFunction: true, runtime: 'java21' },
      { path: 'App/SomeProvider/Handler', isCfnFunction: false }, // raw CloudFormation function
      { path: 'App/PdfExportFunction/Resource', isCfnFunction: true, runtime: 'nodejs22.x', architectures: [ARM64] }, // listed, but arm64
      // values the aspect cannot read are never treated as "absent"
      { path: p, isCfnFunction: true, runtime: 'nodejs22.x', architectures: fnIf },
      { path: p, isCfnFunction: true, runtime: 'nodejs22.x', architectures: [{ Ref: 'Arch' }] },
      { path: p, isCfnFunction: true, runtime: { Ref: 'Runtime' } },
      { path: p, isCfnFunction: true, runtime: 'nodejs22.x', packageType: { 'Fn::If': ['C', 'Image', 'Zip'] } },
      { path: 'App/PdfExportFunction/Resource', isCfnFunction: true, runtime: 'nodejs22.x', architectures: fnIf },
      // layers are not inspected
      { path: p, isCfnFunction: true, runtime: 'nodejs22.x', layers: ['some-layer-version'] },
      { path: p, isCfnFunction: true, runtime: 'nodejs22.x', layers: { 'Fn::If': ['C', ['some-layer-version'], []] } },
    ];
    for (const c of cases) assert.equal(architectureDecision(c, list).action, 'error', JSON.stringify(c));
  });

  it('accepts an explicit arm64, an empty layer list, and a listed function with layers', () => {
    assert.deepEqual(architectureDecision({ path: p, isCfnFunction: true, runtime: 'nodejs22.x', architectures: [ARM64] }, list), {
      action: 'keep',
      why: 'already arm64',
      runsOnArm64: true,
    });
    assert.equal(architectureDecision({ path: p, isCfnFunction: true, runtime: 'nodejs22.x', layers: [] }, list).action, 'set-arm64');
    assert.equal(
      architectureDecision({ path: 'App/PdfExportFunction/Resource', isCfnFunction: true, runtime: 'nodejs22.x', layers: ['some-layer-version'] }, list).action,
      'keep',
    );
  });
});

describe('the exception list', () => {
  it('refuses an entry without a reason', () => {
    assert.throws(() => new GravitonDefaultAspect({ x86Functions: [{ pattern: /X/, reason: ' ' }] }), /needs a reason/);
  });

  it('is not confused by a global RegExp, which keeps state between matches', () => {
    const { arch, errors } = synth(
      (stack) => {
        nodeFn(stack, 'KeepA');
        nodeFn(stack, 'KeepB');
      },
      [{ pattern: /\/Keep[AB]\/Resource$/g, reason: 'test entry with a global flag' }],
    );
    assert.deepEqual(errors, []);
    assert.equal(arch.get('Test/KeepA/Resource'), undefined);
    assert.equal(arch.get('Test/KeepB/Resource'), undefined);
  });
});

describe('example app: arm64 by default, exceptions in code', () => {
  it('(a) the Node.js and the Python function end on arm64', () => {
    const { arch, errors } = synthExample();
    assert.deepEqual(errors, []);
    assert.deepEqual(arch.get('Example/HelloNodeFunction/Resource'), [ARM64]);
    assert.deepEqual(arch.get('Example/HelloPythonFunction/Resource'), [ARM64]);
  });

  it('(b) the listed pdf-export function stays on x86_64, although its asset holds an x86-64 binary', () => {
    const { arch, errors } = synthExample();
    assert.deepEqual(errors, []);
    assert.equal(arch.size, 3);
    assert.equal(arch.get('Example/PdfExportFunction/Resource'), undefined, 'no Architectures = the Lambda default, x86_64');
  });

  it('(c) synth fails when the x86-64 binary is moved into the pure-JS function', () => {
    const planted = copyOf(HELLO, { 'bin/renderer': fakeElf(EM_X86_64) });
    const { arch, errors } = synthExample({ helloNode: planted });
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /Lambda Example\/HelloNodeFunction\/Resource ships native binaries \(bin\/renderer\) but would run on arm64/);
    assert.equal(arch.get('Example/HelloNodeFunction/Resource'), undefined, 'not moved to arm64');
    assert.deepEqual(arch.get('Example/HelloPythonFunction/Resource'), [ARM64], 'the other functions are not affected');
  });

  it('(c) the file name does not matter: a .node addon, an extensionless ELF, a .so and a .br pack are all found', () => {
    const planted = copyOf(HELLO, {
      'node_modules/fast-thing/build/Release/addon.node': fakeElf(EM_X86_64),
      'bin/helper': fakeElf(EM_X86_64),
      'lib/libthing.so.1': fakeElf(EM_X86_64),
      'bin/browser.br': 'packed',
    });
    const { errors } = synthExample({ helloNode: planted });
    assert.equal(errors.length, 1, errors.join('\n'));
    for (const name of ['addon.node', 'bin/helper', 'lib/libthing.so.1', 'bin/browser.br']) assert.ok(errors[0].includes(name), name);
  });

  it('(d) an AArch64 ELF passes: the function goes to arm64', () => {
    const planted = copyOf(HELLO, {
      'bin/renderer': fakeElf(EM_AARCH64),
      'node_modules/fast-thing/build/Release/addon.node': fakeElf(EM_AARCH64),
    });
    const { arch, errors } = synthExample({ helloNode: planted });
    assert.deepEqual(errors, []);
    assert.deepEqual(arch.get('Example/HelloNodeFunction/Resource'), [ARM64]);
  });

  it('(f) a listed function that is set to arm64 fails: the entry is stale', () => {
    const { errors } = synthExample({}, (stack) => {
      const pdfExport = stack.node.findChild('PdfExportFunction').node.defaultChild as lambda.CfnFunction;
      pdfExport.architectures = [ARM64];
    });
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /Lambda Example\/PdfExportFunction\/Resource is set to arm64 but is on the x86_64 exception list/);
  });
});

describe('fail closed: what the aspect cannot decide fails synth', () => {
  it('(e) a function with a layer', () => {
    const { arch, errors } = synth((stack) => {
      const layer = new lambda.LayerVersion(stack, 'Layer', {
        code: lambda.Code.fromAsset(tempDir({ 'nodejs/util.js': 'module.exports = 1;' })),
      });
      nodeFn(stack, 'WithLayer', { layers: [layer] });
    });
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /Lambda Test\/WithLayer\/Resource has Lambda layers, whose contents the aspect cannot inspect/);
    assert.equal(arch.get('Test/WithLayer/Resource'), undefined);
  });

  it('(e) a container-image function', () => {
    const { arch, errors } = synth((stack) => {
      new lambda.DockerImageFunction(stack, 'ImageFn', {
        code: lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(stack, 'Repo', 'example-repo')),
      });
    });
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /Lambda Test\/ImageFn\/Resource is a container image, which is built for one architecture/);
    assert.equal(arch.get('Test/ImageFn/Resource'), undefined);
  });

  it('(e) an Fn::If Architectures value', () => {
    const { errors } = synth((stack) => {
      const stage = new cdk.CfnParameter(stack, 'Stage', { default: 'dev' });
      const isProd = new cdk.CfnCondition(stack, 'IsProd', { expression: cdk.Fn.conditionEquals(stage.valueAsString, 'prod') });
      const fn = nodeFn(stack, 'CondArch');
      (fn.node.defaultChild as lambda.CfnFunction).architectures = cdk.Token.asList(
        cdk.Fn.conditionIf(isProd.logicalId, [X86_64], [ARM64]),
      );
    });
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /Lambda Test\/CondArch\/Resource has an Architectures value the aspect cannot read \(\{"Fn::If"/);
  });

  it('an explicit x86_64 that is not on the list', () => {
    const { errors } = synth((stack) => nodeFn(stack, 'PinnedX86', { architecture: lambda.Architecture.X86_64 }));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /Lambda Test\/PinnedX86\/Resource pins Architectures \["x86_64"\]/);
  });

  it('a runtime that is not Node.js or Python', () => {
    const { errors } = synth((stack) =>
      nodeFn(stack, 'CustomRuntime', {
        runtime: lambda.Runtime.PROVIDED_AL2023,
        handler: 'bootstrap',
        code: lambda.Code.fromAsset(tempDir({ bootstrap: '#!/bin/sh\n' })),
      }),
    );
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /Lambda Test\/CustomRuntime\/Resource has runtime "provided.al2023"/);
  });

  it('code it cannot inspect: an S3 object and a pre-built archive', () => {
    const archive = join(tempDir({ 'code.zip': 'stands in for a pre-built zip' }), 'code.zip');
    const { errors } = synth((stack) => {
      const bucket = s3.Bucket.fromBucketName(stack, 'CodeBucket', 'some-bucket');
      nodeFn(stack, 'S3Code', { code: lambda.Code.fromBucket(bucket, 'code.zip') });
      nodeFn(stack, 'ZipCode', { code: lambda.Code.fromAsset(archive) });
    });
    assert.equal(errors.length, 2, errors.join('\n'));
    assert.ok(errors.some((e) => /S3Code\/Resource has code the aspect cannot inspect/.test(e)));
    assert.ok(errors.some((e) => /ZipCode\/Resource has a code asset the aspect cannot inspect \(a pre-built archive/.test(e)));
  });

  it("a raw CloudFormation function, such as CDK's own providers, until it is listed", () => {
    const build = (stack: cdk.Stack) => {
      const bucket = new s3.Bucket(stack, 'Bucket', { autoDeleteObjects: true, removalPolicy: cdk.RemovalPolicy.DESTROY });
      bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.SqsDestination(new sqs.Queue(stack, 'Queue')));
      new cr.AwsCustomResource(stack, 'SdkCall', {
        onCreate: { service: 'SSM', action: 'getParameter', parameters: { Name: 'x' }, physicalResourceId: cr.PhysicalResourceId.of('x') },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
        installLatestAwsSdk: false,
      });
    };
    const unlisted = synth(build);
    assert.equal(unlisted.errors.length, 2, unlisted.errors.join('\n'));
    for (const e of unlisted.errors) assert.match(e, /is a raw CloudFormation function/);

    const listed = synth(build, CDK_PROVIDER_EXCEPTIONS);
    assert.deepEqual(listed.errors, []);
    assert.equal(listed.arch.size, 3, 'autoDeleteObjects, bucket notifications and AwsCustomResource providers');
    for (const [path, a] of listed.arch) assert.equal(a, undefined, `${path} is left as CDK ships it`);
  });
});

describe('what passes', () => {
  it('an image explicitly set to arm64 (the configuration the error message suggests)', () => {
    const { arch, errors } = synth((stack) => {
      new lambda.DockerImageFunction(stack, 'ArmImage', {
        architecture: lambda.Architecture.ARM_64,
        code: lambda.DockerImageCode.fromEcr(ecr.Repository.fromRepositoryName(stack, 'Repo', 'example-repo')),
      });
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(arch.get('Test/ArmImage/Resource'), [ARM64]);
  });

  it('one Code object shared by two functions: both are scanned, both go to arm64', () => {
    const { arch, errors } = synth((stack) => {
      const code = lambda.Code.fromAsset(HELLO);
      nodeFn(stack, 'First', { code });
      nodeFn(stack, 'Second', { code });
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(arch.get('Test/First/Resource'), [ARM64]);
    assert.deepEqual(arch.get('Test/Second/Resource'), [ARM64]);
  });

  it('one Code object shared by two functions, with a planted x86-64 binary: both fail', () => {
    const { errors } = synth((stack) => {
      const code = lambda.Code.fromAsset(copyOf(HELLO, { 'bin/helper': fakeElf(EM_X86_64) }));
      nodeFn(stack, 'First', { code });
      nodeFn(stack, 'Second', { code });
    });
    assert.equal(errors.length, 2, errors.join('\n'));
    for (const e of errors) assert.match(e, /ships native binaries \(bin\/helper\)/);
  });
});

describe('example/app.ts as a process (what `npm run synth` runs)', () => {
  function runApp(context?: Record<string, string>) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CDK_OUTDIR;
    delete env.CDK_CONTEXT_JSON;
    if (context) env.CDK_CONTEXT_JSON = JSON.stringify(context);
    return spawnSync(process.execPath, ['--import', 'tsx', 'example/app.ts'], { cwd: ROOT, env, encoding: 'utf8' });
  }

  it('exits 0 and reports arm64, arm64, x86_64', () => {
    const run = runApp();
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /HelloNodeFunction\/Resource\s+nodejs22\.x\s+arm64/);
    assert.match(run.stdout, /HelloPythonFunction\/Resource\s+python3\.13\s+arm64/);
    assert.match(run.stdout, /PdfExportFunction\/Resource\s+nodejs22\.x\s+x86_64 \(Lambda default; on the exception list\)/);
  });

  it('exits non-zero with the error text when a native binary is planted', () => {
    const planted = copyOf(HELLO, { 'bin/renderer': fakeElf(EM_X86_64) });
    const run = runApp({ helloNodeAssetDir: planted });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stderr, /HelloNodeFunction\/Resource ships native binaries \(bin\/renderer\) but would run on arm64/);
    assert.match(run.stderr, /synth failed: 1 error\(s\)/);
  });
});
