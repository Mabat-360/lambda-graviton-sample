# Lambda on arm64 by default: a CDK Aspect that fails closed

A pattern for AWS CDK apps, in four parts:

1. **arm64 by default.** Every Node.js or Python Lambda function that does not set an
   architecture runs on Graviton (arm64). A new function gets it without anyone having to
   remember.
2. **Exceptions in code.** A function stays on x86_64 only through an entry on one list: a
   construct path pattern and a written reason.
3. **Fail closed.** What the Aspect cannot decide safely fails the synth. It never guesses.
4. **Scan the assets.** Before a function moves to arm64, its code asset is searched for
   native binaries that cannot run there. The same check runs at build time.

Extracted from a real application codebase. Nothing here needs an AWS account, except the two
measurement scripts.

## Contents

| Path | What it is |
|---|---|
| `lib/graviton-default-aspect.ts` | The Aspect. One file; it imports `aws-cdk-lib` and nothing else. |
| `lib/native-binary-check.mjs` | The build-time check, with a CLI. No dependencies. |
| `example/` | A CDK app with three functions: pure Node.js, pure Python, and one that carries an x86-64 binary. |
| `test/` | Offline tests (`node:test`, run through `tsx`). |
| `measure/` | Two scripts that compare an x86_64 run and an arm64 run from CloudWatch Logs. |
| `scripts/demo.mjs` | `npm run demo:fail` and `npm run demo:pass`. |
| `scripts/leak-scan.mjs` | `npm run scan`: checks the files for things that must not be published. |

## Quick start

Needs Node.js 20 or later (tested with Node.js 22) and the npm registry. No AWS account, no
credentials, no CDK CLI.

```sh
npm ci
npm test            # the offline tests
npm run synth       # synthesises the example app and prints each function's architecture
npm run demo:fail   # plants an x86-64 addon in a bundle: the build-time check exits 1
npm run demo:pass   # the same with an AArch64 addon: the check exits 0
```

`npm run synth` prints:

```text
function                                      runtime      architecture
GravitonExample/HelloNodeFunction/Resource    nodejs22.x   arm64
GravitonExample/HelloPythonFunction/Resource  python3.13   arm64
GravitonExample/PdfExportFunction/Resource    nodejs22.x   x86_64 (Lambda default; on the exception list)
```

No function in `example/example-stack.ts` sets an architecture. The Aspect sets arm64 on the
first two. The third is on the exception list, so it is left alone.

This repository holds no binary file. The "x86-64 binary" of the example is a fake: a
64-byte ELF header (the ELF magic number, then `e_machine`: `0x3E` for x86-64, `0xB7` for
AArch64). `example/fake-elf.mjs` writes it before every synth, test and demo.

## Using the Aspect

Copy `lib/graviton-default-aspect.ts` into your CDK app and register it on the app:

```ts
import * as cdk from 'aws-cdk-lib';
import { CDK_PROVIDER_EXCEPTIONS, GravitonDefaultAspect } from './graviton-default-aspect.js';

cdk.Aspects.of(app).add(
  new GravitonDefaultAspect({
    x86Functions: [
      {
        pattern: /\/PdfExportFunction\/Resource$/,
        reason: 'ships a prebuilt x86-64 renderer binary; moving it needs an arm64 build of that binary',
      },
      ...CDK_PROVIDER_EXCEPTIONS,
    ],
  }),
  { priority: cdk.AspectPriority.MUTATING },
);
```

- `pattern` is matched against the construct path of the function resource. Use exact
  construct ids, so that a new function under the same parent is not covered by accident.
- `reason` is required. An entry without one throws.
- The list is the only place that keeps a function on x86_64. A function that pins x86_64
  itself and is not on the list fails the synth.
- `CDK_PROVIDER_EXCEPTIONS` covers functions that `aws-cdk-lib` creates for itself (the
  `autoDeleteObjects`, bucket-notification, log-retention, cross-region-reference and
  `AwsCustomResource` providers). They run CDK's own code at deploy time and are left as
  CDK ships them. Leave the preset out if your app has none of them.
- The mutating priority makes the Aspect run before read-only Aspects that look at the
  architecture.

## How the Aspect decides

For every `AWS::Lambda::Function`, the first row that applies wins:

| # | The function | Result |
|---|---|---|
| 1 | has an `Architectures` value that is not a list of plain strings (an `Fn::If`, a token) | error |
| 2 | has a `Runtime` or `PackageType` that is a token or an intrinsic | error |
| 3 | is on the exception list | left as it is; error if it is set to arm64 (the entry is stale) |
| 4 | is a raw CloudFormation resource, not a `lambda.CfnFunction` (some CDK providers) | error |
| 5 | has layers | error |
| 6 | sets `arm64` itself | kept; its code is scanned |
| 7 | sets any other architecture | error |
| 8 | is a container image | error |
| 9 | has a runtime other than `nodejs*` or `python*` | error |
| 10 | anything else: a zip function on Node.js or Python with no architecture | its code is scanned, then it gets `arm64` |

"Its code is scanned" means:

| Code | Result |
|---|---|
| inline | passes |
| a directory asset (`Code.fromAsset(dir)`) | scanned; error if it holds a native binary that cannot run on arm64 |
| a pre-built archive (`Code.fromAsset('x.zip')`) or an S3 object | error: it cannot be inspected |
| a container image that sets `arm64` itself | passes without analysis: the owner stated the choice |

An "error" is a CDK error annotation on the function. The CDK CLI fails `cdk synth` and
`cdk deploy` for a stack that carries one. This repository does not use the CLI: the tests
assert on the annotations, and `example/app.ts` exits non-zero on them, so `npm run synth`
fails too. Every error names the function and says what to do, for example:

```text
Lambda GravitonExample/HelloNodeFunction/Resource ships native binaries (bin/renderer) but would run on arm64 (GravitonDefaultAspect).
```

## The native-binary check

The same rules run in two places:

- **At synth time**, in the Aspect, on the asset directory of every function that would run
  on arm64.
- **At build time**, in `lib/native-binary-check.mjs`, on a directory that holds one
  sub-directory per function bundle. Call `assertArchNeutralBundles(dir, { allow })` from
  your build script after bundling, or use the CLI:

  ```sh
  node lib/native-binary-check.mjs --dir dist/lambdas --allow pdf-export
  ```

  `--allow` names a bundle whose function stays on x86_64. Exit code 0 means clean, 1 means
  a violation, 2 means a usage error. `--json` prints the result as JSON.

A file is flagged when it is:

- a `.br` file (a Brotli-packed binary: its content cannot be read, so it is never accepted),
- an ELF file built for another machine than AArch64, whatever its name or extension,
- a `.node` or `.so` file that is not an AArch64 ELF.

Files are judged by content: the check reads the ELF header. An AArch64 ELF passes.

### What it proves, and what it does not

It proves one thing: the deployment asset holds no file that the rules above flag.

It does not prove that the function works on arm64:

- Layers, extensions (they are delivered as layers) and container images are **refused, not
  analysed**. A function that has them must go on the exception list, or set arm64 itself in
  the case of an image.
- Only files in the asset directory are seen. A binary that the function downloads at run
  time is not, and neither is one inside an archive other than `.br` (a zip, a tarball).
- An AArch64 ELF passes on its header alone. Whether it finds the shared libraries it needs
  in the Lambda runtime is not checked.
- Code that branches on the CPU architecture, or calls an x86-only tool, is not detected.
- Symbolic links are not followed.
- An exception that no longer matches any function is not reported.
- The build-time `--allow` list and the Aspect's exception list are two lists. Keep them in
  step.

Test the function on arm64 before production. The check only removes one known way to fail.

## Why setting the architecture in an Aspect is safe here

An Aspect runs after the constructs exist. It can only change the `Architectures` property.
That is enough when the code asset does not depend on the architecture.

It was true in the codebase this comes from: the bundles are built before the synth by
esbuild with `platform: 'node'` and no CPU target, and loaded with `Code.fromAsset()`.
Nothing is bundled per architecture, so the same zip runs on x86_64 and on arm64. The
example also loads plain asset folders with `Code.fromAsset()`.

It is not true everywhere. If you use `NodejsFunction` with Docker bundling, or any
dependency with native code, the bundling step reads the architecture when the function is
constructed. An Aspect comes too late to change what was bundled. In that case, set the
architecture at construction time and use the Aspect only to validate: a function that sets
`arm64` itself is kept and scanned (row 6), and one that was bundled for x86_64 with a
native dependency fails the scan.

## Measuring the effect

`measure/` holds the two scripts used to compare a run on x86_64 with a run on arm64. They
read the `REPORT` line that Lambda writes for every invocation, through CloudWatch Logs
Insights. They need bash, Python 3 and the AWS CLI v2 with `logs:StartQuery` and
`logs:GetQueryResults`. They contain no log group names, no account and no profile: all of
that comes from arguments or environment variables.

### Method

1. Deploy one code revision to a non-production environment with every function on x86_64.
   Run a fixed workload (the same sequence of requests) and note the start and end time.
2. Deploy the same revision with the Aspect. Keep the memory sizes. Run the same workload
   and note the times.
3. Wait a few minutes, then compare the two windows:

```sh
bash measure/compare.sh \
  --require-substring /dev/ \
  --price-x86 <USD per GB-second> --price-arm64 <USD per GB-second> \
  2030-01-31T16:00:00Z 2030-01-31T16:10:00Z \
  2030-01-31T17:00:00Z 2030-01-31T17:10:00Z \
  /aws/lambda/dev/main-view /aws/lambda/dev/list-view /aws/lambda/dev/sign-in
```

- The log groups are arguments, or the `LOG_GROUPS` environment variable. There are no
  defaults.
- `--require-substring` is a guard: the script refuses to run unless every log group name
  contains the given text. Use it to keep the script away from production logs.
- The AWS profile and region come from `--profile` and `--region`, or from `AWS_PROFILE` and
  `AWS_REGION`.
- Take both prices from the AWS Lambda pricing page for your region. They are required, and
  there are no defaults.
- The raw query results are saved (default `./measure-results`), with the account ID removed
  from the log group names. `--offline` recomputes the table from saved results.

`measure/lambda-report.sh` prints the statistics of one window (count, cold starts, average,
p50, p95, init duration, billed milliseconds, memory). It takes one start and end time, the
log groups, and the same profile, region and guard options. It needs no prices.

### The queries

Two Logs Insights queries per window:

- **All invocations**, per log group: the count, the cold starts (a `REPORT` line with
  `Init Duration`), the sum of `@billedDuration` and the configured `@memorySize`.
- **Warm invocations only** (a `REPORT` line without `Init Duration`): the count, and the
  average, median and 95th percentile of `@duration`.

### The cost formula

```text
billed GB-seconds           = billed_ms / 1000  x  mem_b / 1,000,000 / 1024
GB-seconds per 1,000        = billed GB-seconds / invocations x 1000
charge per 1,000,000 (USD)  = GB-seconds per 1,000  x 1000  x price per GB-second
change in cost              = (arm64 GB-seconds per 1,000 x arm64 price)
                              / (x86 GB-seconds per 1,000 x x86 price)  - 1
```

`billed_ms` is the sum of `@billedDuration`. `mem_b` is `@memorySize`, which Logs Insights
reports as the configured megabytes times 1,000,000. The charge covers duration only.
Request charges are the same on both architectures and are left out, and so are the free
tier and volume discounts.

### What such a measurement can tell you

- One run per architecture with a few hundred invocations is an indication, not a benchmark.
  Repeat it before you quote a number.
- For I/O-bound functions, most of the duration is waiting for a database or another
  service. The architecture changes little there. The lower price per GB-second on arm64
  applies anyway.
- Cold starts are counted, not compared: a short window holds too few of them.
- Logs Insights only sees events that are already ingested. `compare.sh` checks that the two
  queries of a window agree (all invocations minus cold starts equals warm invocations) and
  prints a warning when they do not. Then run the queries again.

## Leak scan

`npm run scan` reads every file that would be committed (it skips `node_modules`, `cdk.out`,
`.tmp` and `.git`) and exits non-zero when it finds an AWS account ID (any 12-digit number),
an ARN, an AWS access key, a private-key header, a GitHub or Slack token, a Windows drive
path or a home-directory path. Each hit is printed as `file:line`
with the rule name. A match is shown only by its first four characters.

Add your own words (product names, ticket prefixes, internal host names) through an environment variable:

```sh
LEAK_DENY=word-one,word-two npm run scan
```

The test fixtures that need such values (a 12-digit number, an ELF header) are built at test
time, so the scan of the repository stays clean.

## Notes

- Built and tested with `aws-cdk-lib` 2.278.0. The Aspect relies on how `Code.fromAsset()`
  attaches its asset to a function. If a later CDK version changes that, the Aspect cannot
  find the asset, reports "cannot inspect" and fails the synth. It does not pass silently.
- One `Code.fromAsset()` object shared by several functions is supported: each function is
  matched to the asset by the S3 location it points at.
