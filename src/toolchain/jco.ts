import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ComponentToolchainPort } from '../contracts.js';
import { ExitCode, WitshiftError } from '../errors.js';

const MAX_DIAGNOSTIC_CODE_UNITS = 65_536;

interface PackageLocation {
  readonly root: string;
  readonly version: string;
}

export class JcoToolchainAdapter implements ComponentToolchainPort {
  public readonly id = 'jco' as const;

  public async componentize(input: {
    sourcePath: string;
    witPath: string;
    outputPath: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<void> {
    const jco = await resolvePackage('@bytecodealliance/jco');
    const cliPath = resolve(jco.root, 'src/jco.js');
    await runBounded(
      process.execPath,
      [
        cliPath,
        'componentize',
        input.sourcePath,
        '--wit',
        input.witPath,
        '--disable',
        'all',
        '--out',
        input.outputPath,
      ],
      input.cwd,
      input.timeoutMs,
    );
  }

  public async versions(): Promise<{ jco: string; componentizeJs: string }> {
    const [jco, componentizeJs] = await Promise.all([
      resolvePackage('@bytecodealliance/jco'),
      resolvePackage('@bytecodealliance/componentize-js'),
    ]);
    return { jco: jco.version, componentizeJs: componentizeJs.version };
  }
}

async function resolvePackage(name: string): Promise<PackageLocation> {
  let modulePath: string;
  try {
    modulePath = fileURLToPath(import.meta.resolve(name));
  } catch (error) {
    throw new WitshiftError(
      'TOOLCHAIN_UNAVAILABLE',
      `${name} is unavailable; install WITShift with optional dependencies enabled`,
      ExitCode.toolchainFailure,
      { package: name },
      { cause: error },
    );
  }
  let directory = dirname(modulePath);
  for (let depth = 0; depth < 6; depth += 1) {
    const packagePath = resolve(directory, 'package.json');
    try {
      const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as unknown;
      if (isPackageJson(parsed) && parsed.name === name) {
        return { root: directory, version: parsed.version };
      }
    } catch {
      // Continue toward the package root.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new WitshiftError(
    'TOOLCHAIN_UNAVAILABLE',
    `Cannot resolve package metadata for ${name}`,
    ExitCode.toolchainFailure,
    { package: name },
  );
}

async function runBounded(
  command: string,
  argumentsList: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
      windowsHide: true,
    });
    let diagnostic = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (diagnostic.length < MAX_DIAGNOSTIC_CODE_UNITS) {
        diagnostic += chunk.slice(0, MAX_DIAGNOSTIC_CODE_UNITS - diagnostic.length);
      }
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(
        new WitshiftError(
          'TOOLCHAIN_UNAVAILABLE',
          `Unable to start official component toolchain: ${error.message}`,
          ExitCode.toolchainFailure,
          undefined,
          { cause: error },
        ),
      );
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new WitshiftError(
          timedOut ? 'TOOLCHAIN_TIMEOUT' : 'TOOLCHAIN_FAILED',
          timedOut
            ? `Official component toolchain exceeded ${timeoutMs}ms`
            : `Official component toolchain failed with ${code ?? signal ?? 'unknown status'}`,
          ExitCode.toolchainFailure,
          { diagnostic: diagnostic.trim(), exitCode: code, signal },
        ),
      );
    });
  });
}

function isPackageJson(value: unknown): value is { name: string; version: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'version' in value &&
    typeof value.version === 'string'
  );
}
