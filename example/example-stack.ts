import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';
import type { X86Exception } from '../lib/graviton-default-aspect.js';

const FUNCTIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'functions');

/** The single place that keeps a function of this app on x86_64. */
export const X86_FUNCTIONS: readonly X86Exception[] = [
  {
    pattern: /\/PdfExportFunction\/Resource$/,
    reason:
      'ships a prebuilt x86-64 renderer binary (bin/renderer); moving it needs an arm64 build of that binary',
  },
];

export interface ExampleStackProps extends cdk.StackProps {
  /** Asset directory overrides. The tests plant binaries in a copy and point here. */
  readonly assetDirs?: { readonly helloNode?: string; readonly helloPython?: string; readonly pdfExport?: string };
}

/** Three functions from local asset folders. None of them sets an architecture: the aspect decides. */
export class ExampleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ExampleStackProps = {}) {
    super(scope, id, props);
    const dirs = props.assetDirs ?? {};

    // Pure JavaScript: ends on arm64.
    new lambda.Function(this, 'HelloNodeFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(dirs.helloNode ?? path.join(FUNCTIONS, 'hello-node')),
    });

    // Pure Python: ends on arm64.
    new lambda.Function(this, 'HelloPythonFunction', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(dirs.helloPython ?? path.join(FUNCTIONS, 'hello-python')),
    });

    // Carries an x86-64 binary and is on X86_FUNCTIONS: stays on x86_64.
    new lambda.Function(this, 'PdfExportFunction', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      memorySize: 1024,
      code: lambda.Code.fromAsset(dirs.pdfExport ?? path.join(FUNCTIONS, 'pdf-export')),
    });
  }
}
