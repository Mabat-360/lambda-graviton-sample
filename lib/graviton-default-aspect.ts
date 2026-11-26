// Lambda functions on Graviton (arm64) by default.
//
// For every AWS::Lambda::Function in scope:
//   - On the exception list (construct path pattern + reason): left exactly as it is.
//   - A zip function on a nodejs* or python* runtime with no architecture set: its code
//     asset is scanned for native binaries, then it gets `Architectures: [arm64]`.
//   - Anything the aspect cannot decide safely gets an error annotation, which fails
//     `cdk synth`: a container image, layers, an Architectures / Runtime / PackageType it
//     cannot read (a token or an Fn::If), an explicit x86_64 that is not on the list,
//     another runtime, code it cannot inspect, a raw CloudFormation function.
//
// Register it as a mutating aspect, so it runs before read-only checks:
//   cdk.Aspects.of(app).add(new GravitonDefaultAspect({ x86Functions: [...] }),
//                           { priority: cdk.AspectPriority.MUTATING });
//
// Setting the architecture this late is only safe when the code asset does not depend on
// it: if a bundling step reads the architecture (Docker bundling, native dependencies),
// set it at construction time and use this aspect only to validate.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import type { IConstruct } from 'constructs';

export const ARM64 = lambda.Architecture.ARM_64.name; // 'arm64'
export const X86_64 = lambda.Architecture.X86_64.name; // 'x86_64'

/** A function that stays on x86_64, and why. */
export interface X86Exception {
  /**
   * Matched against the construct path of the function resource, e.g.
   * `MyStack/PdfExportFunction/Resource`. Use exact construct ids, so that a new function
   * under the same parent is not covered by accident.
   */
  readonly pattern: RegExp;
  /** Why it cannot move, and what would have to change. Required. */
  readonly reason: string;
}

export interface GravitonDefaultAspectProps {
  /** The only place that keeps a function on x86_64. Default: no exceptions. */
  readonly x86Functions?: readonly X86Exception[];
}

/**
 * Ready-made exceptions for functions that aws-cdk-lib creates itself. They run CDK's
 * own code at deploy time only, so they are left as CDK ships them. Spread this into
 * `x86Functions` if your app uses these features.
 */
export const CDK_PROVIDER_EXCEPTIONS: readonly X86Exception[] = [
  {
    pattern: /\/AWS679f53fac002430cb0da5b7982bd2287\/Resource$/,
    reason: 'CDK AwsCustomResource singleton (aws-cdk-lib code, deploy time only)',
  },
  {
    pattern: /\/BucketNotificationsHandler050a0587b7544547bf325f094a3db834\/Resource$/,
    reason: 'CDK S3 bucket-notification provider (aws-cdk-lib code, deploy time only)',
  },
  {
    pattern: /\/LogRetentionaae0aa3c5b4d4f87b02d85b201efdd8a\/Resource$/,
    reason: 'CDK log-retention provider (aws-cdk-lib code, deploy time only)',
  },
  {
    pattern: /\/Custom::S3AutoDeleteObjectsCustomResourceProvider\/Handler$/,
    reason: 'CDK autoDeleteObjects provider (aws-cdk-lib code, runs on stack deletion only)',
  },
  {
    pattern: /\/Custom::CrossRegionExport(Reader|Writer)CustomResourceProvider\/Handler$/,
    reason: 'CDK cross-region reference provider (aws-cdk-lib code, deploy time only)',
  },
];

/** Where a function's code comes from, as far as the aspect can tell. */
export type CodeSource =
  | { readonly kind: 'inline' }
  | { readonly kind: 'asset'; readonly stagedPath: string }
  | { readonly kind: 'image' }
  | { readonly kind: 'unknown' };

/** What the decision needs to know about one synthesised function. */
export interface FunctionShape {
  readonly path: string;
  /** False for a raw CfnResource (some CDK providers); true for a lambda.CfnFunction. */
  readonly isCfnFunction: boolean;
  readonly runtime?: unknown;
  readonly packageType?: unknown;
  readonly architectures?: unknown;
  readonly layers?: unknown;
}

export type ArchitectureDecision =
  | { readonly action: 'keep'; readonly why: string; readonly runsOnArm64: boolean }
  | { readonly action: 'set-arm64' }
  | { readonly action: 'error'; readonly message: string };

// Runtimes whose code is architecture-neutral unless the package ships a native binary.
const ARCH_NEUTRAL_RUNTIME = /^(nodejs|python)/;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && !cdk.Token.isUnresolved(x));
}

/** A plain string or absent, i.e. nothing the aspect would have to guess. */
function isPlainOrAbsent(v: unknown): boolean {
  return v === undefined || (typeof v === 'string' && !cdk.Token.isUnresolved(v));
}

/** The exception that covers a construct path, if any. */
export function x86ExceptionFor(
  constructPath: string,
  x86Functions: readonly X86Exception[],
): X86Exception | undefined {
  return x86Functions.find((e) => e.pattern.test(constructPath));
}

/** Pure decision for one function. Code inspection is separate: see inspectCode(). */
export function architectureDecision(
  fn: FunctionShape,
  x86Functions: readonly X86Exception[] = [],
): ArchitectureDecision {
  if (fn.architectures !== undefined && !isStringArray(fn.architectures)) {
    return {
      action: 'error',
      message:
        `has an Architectures value the aspect cannot read (${JSON.stringify(fn.architectures)}, e.g. an ` +
        'Fn::If or a token); set a literal architecture, or add the function to the x86_64 exception list',
    };
  }
  if (!isPlainOrAbsent(fn.packageType) || !isPlainOrAbsent(fn.runtime)) {
    return {
      action: 'error',
      message:
        'has a Runtime or PackageType the aspect cannot read (a token or an intrinsic); ' +
        'add it to the x86_64 exception list',
    };
  }
  const archs = fn.architectures as string[] | undefined;
  const listed = x86ExceptionFor(fn.path, x86Functions);
  if (listed) {
    if (archs?.includes(ARM64)) {
      return {
        action: 'error',
        message: 'is set to arm64 but is on the x86_64 exception list; remove its entry if it really moved to arm64',
      };
    }
    return { action: 'keep', why: listed.reason, runsOnArm64: false };
  }
  if (!fn.isCfnFunction) {
    return {
      action: 'error',
      message:
        'is a raw CloudFormation function from a CDK or third-party construct, which this aspect does not ' +
        'change; add it to the x86_64 exception list with a reason',
    };
  }
  if (fn.layers !== undefined && !(Array.isArray(fn.layers) && fn.layers.length === 0)) {
    return {
      action: 'error',
      message:
        'has Lambda layers, whose contents the aspect cannot inspect (a layer can carry an x86-only binary); ' +
        'add the function to the x86_64 exception list, or check that every layer is built for arm64 and ' +
        'record that there',
    };
  }
  if (archs !== undefined && archs.length > 0) {
    if (archs.length === 1 && archs[0] === ARM64) return { action: 'keep', why: 'already arm64', runsOnArm64: true };
    return {
      action: 'error',
      message:
        `pins Architectures ${JSON.stringify(archs)}; drop it (arm64 is the default here) or add the ` +
        'function to the x86_64 exception list with the reason',
    };
  }
  if (fn.packageType === 'Image') {
    return {
      action: 'error',
      message:
        'is a container image, which is built for one architecture; add it to the x86_64 exception list ' +
        'or set arm64 explicitly',
    };
  }
  if (typeof fn.runtime !== 'string' || !ARCH_NEUTRAL_RUNTIME.test(fn.runtime)) {
    return {
      action: 'error',
      message:
        `has runtime ${JSON.stringify(fn.runtime)}, which may carry a native binary; add it to the x86_64 ` +
        'exception list or set arm64 explicitly',
    };
  }
  return { action: 'set-arm64' };
}

const PACKED_BINARY = /\.br$/; // Brotli-packed binaries are opaque, so never treated as arm64-safe
const NATIVE_NAME = /\.(node|so(\.\d+)*)$/;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const EM_AARCH64 = 0xb7;

function* walkFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full; // symbolic links are not followed
  }
}

/**
 * Files under `dir` (recursive) that cannot run on arm64 Linux: a .br packed binary; an
 * ELF file (any name, with or without extension) built for another machine than AArch64;
 * or a .node addon / .so library that is not an AArch64 ELF. An AArch64 ELF passes.
 * Same rules as lib/native-binary-check.mjs (a test keeps the two in step).
 */
export function nativeBinaryFiles(dir: string): string[] {
  const out: string[] = [];
  for (const full of walkFiles(dir)) {
    const name = path.basename(full);
    if (PACKED_BINARY.test(name)) {
      out.push(full);
      continue;
    }
    const fd = fs.openSync(full, 'r');
    let head = Buffer.alloc(20);
    try {
      head = head.subarray(0, fs.readSync(fd, head, 0, 20, 0));
    } finally {
      fs.closeSync(fd);
    }
    if (head.length >= 4 && head.subarray(0, 4).equals(ELF_MAGIC)) {
      // e_machine: 2 bytes at offset 18, in the byte order named by EI_DATA (offset 5).
      const machine = head.length >= 20 ? (head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18)) : -1;
      if (machine !== EM_AARCH64) out.push(full);
    } else if (NATIVE_NAME.test(name)) {
      out.push(full); // a native addon that is not even a Linux ELF
    }
  }
  return out;
}

/** Problems with the code of a function that is about to run on arm64; empty = fine. */
export function inspectCode(code: CodeSource): string[] {
  switch (code.kind) {
    case 'inline':
      return [];
    case 'image':
      return []; // only reached for an image explicitly set to arm64: the owner's stated choice
    case 'unknown':
      return ['has code the aspect cannot inspect (not inline and not a CDK directory asset, e.g. an S3 object)'];
    case 'asset': {
      // A directory can be scanned; a pre-built .zip or .jar file cannot.
      if (!fs.existsSync(code.stagedPath) || !fs.statSync(code.stagedPath).isDirectory()) {
        return ['has a code asset the aspect cannot inspect (a pre-built archive, not a directory)'];
      }
      const found = nativeBinaryFiles(code.stagedPath);
      if (found.length === 0) return [];
      const names = found
        .slice(0, 5)
        .map((f) => path.relative(code.stagedPath, f).split(path.sep).join('/'))
        .join(', ');
      return [`ships native binaries (${names}${found.length > 5 ? ', ...' : ''}) but would run on arm64`];
    }
  }
}

/** The code source of a lambda.CfnFunction: inline, a CDK asset, an image, or unknown. */
export function codeSourceOf(node: lambda.CfnFunction): CodeSource {
  const stack = cdk.Stack.of(node);
  const code = stack.resolve(node.code) as
    | { zipFile?: unknown; imageUri?: unknown; s3Bucket?: unknown; s3Key?: unknown }
    | undefined;
  if (code?.zipFile !== undefined) return { kind: 'inline' };
  if (code?.imageUri !== undefined) return { kind: 'image' };
  // lambda.Code.fromAsset() binds an s3_assets.Asset as the child 'Code' of the L2
  // Function; its AssetStaging child 'Stage' holds what CDK uploads. A Code object shared
  // by several functions is bound under the first one only, so the others are matched
  // to their asset by the S3 bucket and key they point at.
  let asset: IConstruct | undefined = node.node.scope?.node.tryFindChild('Code');
  if (!(asset instanceof s3assets.Asset) && code?.s3Bucket !== undefined && code?.s3Key !== undefined) {
    const location = JSON.stringify([code.s3Bucket, code.s3Key]);
    asset = stack.node
      .findAll()
      .find(
        (c) =>
          c instanceof s3assets.Asset &&
          JSON.stringify(stack.resolve([c.s3BucketName, c.s3ObjectKey])) === location,
      );
  }
  if (asset instanceof s3assets.Asset) {
    const staging = asset.node.tryFindChild('Stage');
    if (staging instanceof cdk.AssetStaging) {
      // Scan the staged copy when it exists, else its source: that is what CDK will copy
      // (a superset when the asset has `exclude` patterns, so the check can only be stricter).
      const stagedPath = fs.existsSync(staging.absoluteStagedPath) ? staging.absoluteStagedPath : staging.sourcePath;
      return { kind: 'asset', stagedPath };
    }
  }
  return { kind: 'unknown' };
}

export class GravitonDefaultAspect implements cdk.IAspect {
  private readonly x86Functions: readonly X86Exception[];

  constructor(props: GravitonDefaultAspectProps = {}) {
    this.x86Functions = (props.x86Functions ?? []).map((e) => {
      if (!e.reason || e.reason.trim().length === 0) {
        throw new Error(`GravitonDefaultAspect: the x86_64 exception ${e.pattern} needs a reason`);
      }
      // A global or sticky RegExp keeps state between test() calls; match without it.
      return { pattern: new RegExp(e.pattern.source, e.pattern.flags.replace(/[gy]/g, '')), reason: e.reason };
    });
  }

  public visit(node: IConstruct): void {
    let shape: FunctionShape;
    if (node instanceof lambda.CfnFunction) {
      const stack = cdk.Stack.of(node);
      shape = {
        path: node.node.path,
        isCfnFunction: true,
        runtime: stack.resolve(node.runtime),
        packageType: stack.resolve(node.packageType),
        architectures: stack.resolve(node.architectures),
        layers: stack.resolve(node.layers),
      };
    } else if (node instanceof cdk.CfnResource && node.cfnResourceType === 'AWS::Lambda::Function') {
      const props = (node as unknown as { _cfnProperties?: { Architectures?: unknown } })._cfnProperties;
      shape = {
        path: node.node.path,
        isCfnFunction: false,
        architectures: cdk.Stack.of(node).resolve(props?.Architectures),
      };
    } else {
      return;
    }

    const decision = architectureDecision(shape, this.x86Functions);
    const problems: string[] = [];
    if (decision.action === 'error') {
      problems.push(decision.message);
    } else if (decision.action === 'set-arm64' || decision.runsOnArm64) {
      problems.push(...inspectCode(codeSourceOf(node as lambda.CfnFunction)));
      if (problems.length === 0 && decision.action === 'set-arm64') {
        (node as lambda.CfnFunction).architectures = [ARM64];
      }
    }
    for (const message of problems) {
      cdk.Annotations.of(node).addError(`Lambda ${shape.path} ${message} (GravitonDefaultAspect).`);
    }
  }
}
