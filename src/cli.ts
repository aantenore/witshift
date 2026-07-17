import { resolve } from 'node:path';
import { Command, CommanderError } from 'commander';
import packageJson from '../package.json' with { type: 'json' };
import { buildProject } from './build.js';
import { loadConfig } from './config.js';
import { asWitshiftError, ExitCode, type ExitCodeValue, WitshiftError } from './errors.js';
import { canonicalJson } from './hash.js';
import { inspectProject } from './inspect.js';
import { inspectMarkdown, writeReportPair } from './reporting.js';
import { JcoToolchainAdapter } from './toolchain/jco.js';
import { verifyProject } from './verify.js';

export interface CliIO {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface CliState {
  exitCode: ExitCodeValue;
}

interface InspectCommandOptions {
  readonly reportDir?: string;
}

interface BuildCommandOptions {
  readonly out: string;
  readonly cache: boolean;
  readonly reproducibilityCheck: boolean;
}

interface VerifyCommandOptions {
  readonly fixtures: string;
  readonly reportDir?: string;
}

const processIO: CliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export function createProgram(io: CliIO = processIO, state: CliState = { exitCode: 0 }): Command {
  const program = new Command()
    .name('witshift')
    .description('Migrate a restricted static TypeScript MCP tool subset to WebAssembly Components')
    .version(packageJson.version)
    .option('--json', 'emit stable machine-readable output');

  program.action(() => {
    throw new WitshiftError(
      'INVALID_ARGUMENTS',
      'A command is required; use --help to list commands',
      ExitCode.invalidArguments,
    );
  });

  program
    .command('doctor')
    .description('validate configuration and the pinned local component toolchain')
    .argument('[project]', 'project directory', '.')
    .action(async (project: string) => {
      const loaded = await loadConfig(project);
      const toolchain = new JcoToolchainAdapter();
      const versions = await toolchain.versions();
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
      if (nodeMajor < 24) {
        throw new WitshiftError(
          'UNSUPPORTED_NODE_VERSION',
          `Node.js 24 or newer is required; found ${process.versions.node}`,
          ExitCode.invalidConfiguration,
        );
      }
      emit(
        io,
        wantsJson(program),
        {
          schemaVersion: 1,
          command: 'doctor',
          ok: true,
          project: loaded.projectRoot,
          checks: {
            configuration: 'valid',
            node: process.versions.node,
            jco: versions.jco,
            componentizeJs: versions.componentizeJs,
          },
        },
        `Configuration valid\nNode.js ${process.versions.node}\njco ${versions.jco}\nComponentizeJS ${versions.componentizeJs}`,
      );
    });

  program
    .command('inspect')
    .description('inventory static tool contracts and reject unsupported constructs')
    .argument('<project>', 'project directory')
    .option('--report-dir <directory>', 'report output directory')
    .action(async (project: string, options: InspectCommandOptions) => {
      const report = await inspectProject(project);
      const reportDirectory = resolve(
        options.reportDir ?? resolve(project, '.witshift', 'reports', 'inspect'),
      );
      const paths = await writeReportPair(
        reportDirectory,
        'inspection-report',
        report,
        inspectMarkdown(report),
      );
      emit(
        io,
        wantsJson(program),
        { report, reportDirectory, jsonPath: paths.json, markdownPath: paths.markdown },
        `${report.supported ? 'Supported' : 'Unsupported'}: ${report.tools.length} static tool(s)\nReports: ${paths.json}, ${paths.markdown}`,
      );
      if (!report.supported) state.exitCode = ExitCode.unsupportedProject;
    });

  program
    .command('build')
    .description('emit a real WebAssembly Component, WIT contract, policy, and manifest')
    .argument('<project>', 'project directory')
    .requiredOption('--out <directory>', 'artifact output directory')
    .option('--no-cache', 'disable integrity-checked component cache')
    .option('--no-reproducibility-check', 'skip the independent componentization comparison')
    .action(async (project: string, options: BuildCommandOptions) => {
      const result = await buildProject(project, options.out, {
        cache: options.cache,
        reproducibilityCheck: options.reproducibilityCheck,
      });
      emit(
        io,
        wantsJson(program),
        result,
        `Component: ${result.componentPath}\nManifest: ${result.manifestPath}\n${result.manifest.reproducibility.note}`,
      );
    });

  program
    .command('verify')
    .description('run bounded differential fixtures and collect policy evidence')
    .argument('<project>', 'project directory')
    .requiredOption('--fixtures <jsonl>', 'newline-delimited JSON fixture file')
    .option('--report-dir <directory>', 'report output directory')
    .action(async (project: string, options: VerifyCommandOptions) => {
      const result = await verifyProject(project, options.fixtures, {
        ...(options.reportDir ? { reportDirectory: options.reportDir } : {}),
      });
      emit(
        io,
        wantsJson(program),
        result,
        `${result.report.passed ? 'Passed' : 'Failed'}: ${result.report.summary.passed} pass, ${result.report.summary.denied} denied, ${result.report.summary.mismatched} mismatch, ${result.report.summary.errors} error\nReports: ${result.jsonPath}, ${result.markdownPath}`,
      );
      if (!result.report.passed) state.exitCode = ExitCode.verificationMismatch;
    });

  return program;
}

export async function runCli(
  argv: readonly string[] = process.argv,
  io: CliIO = processIO,
): Promise<ExitCodeValue> {
  const state: CliState = { exitCode: ExitCode.success };
  const program = createProgram(io, state);
  program.exitOverride();
  program.configureOutput({
    writeOut: io.stdout,
    writeErr: () => undefined,
  });
  try {
    await program.parseAsync([...argv]);
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === ExitCode.success) {
      return ExitCode.success;
    }
    const normalized =
      error instanceof CommanderError
        ? new WitshiftError(
            'INVALID_ARGUMENTS',
            cleanCommanderMessage(error.message),
            ExitCode.invalidArguments,
          )
        : asWitshiftError(error);
    emitError(io, jsonRequested(argv), normalized);
    return normalized.exitCode;
  }
  return state.exitCode;
}

function emit(io: CliIO, json: boolean, payload: unknown, human: string): void {
  io.stdout(json ? `${canonicalJson(payload)}\n` : `${human}\n`);
}

function emitError(io: CliIO, json: boolean, error: WitshiftError): void {
  if (json) {
    io.stdout(
      `${canonicalJson({
        schemaVersion: 1,
        ok: false,
        exitCode: error.exitCode,
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      })}\n`,
    );
    return;
  }
  io.stderr(`WITShift ${error.code}: ${error.message}\n`);
}

function wantsJson(program: Command): boolean {
  const options = program.opts<{ json?: boolean }>();
  return options.json === true;
}

function jsonRequested(argv: readonly string[]): boolean {
  return argv.includes('--json');
}

function cleanCommanderMessage(message: string): string {
  return message.replace(/^error:\s*/u, '').trim();
}
