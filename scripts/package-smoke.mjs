import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'witshift-package-smoke-'));
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

try {
  const packDirectory = resolve(temporaryRoot, 'pack');
  await mkdir(packDirectory);
  await run(packageManager, ['pack', '--pack-destination', packDirectory], repositoryRoot);
  const archives = (await readdir(packDirectory)).filter((file) => file.endsWith('.tgz'));
  if (archives.length !== 1)
    throw new Error(`Expected one package archive, found ${archives.length}`);
  const archive = resolve(packDirectory, archives[0]);
  await run(npm, ['init', '--yes'], temporaryRoot);
  await run(npm, ['install', archive, '--omit=optional', '--no-audit', '--no-fund'], temporaryRoot);
  const installed = resolve(temporaryRoot, 'node_modules', 'witshift');
  const metadata = JSON.parse(await readFile(resolve(installed, 'package.json'), 'utf8'));
  if (metadata.version !== '0.1.0-alpha.1') throw new Error('Packed version is unexpected');
  for (const required of ['dist', 'schemas', 'README.md', 'LICENSE', 'NOTICE']) {
    await readdirOrRead(resolve(installed, required));
  }
  for (const excluded of ['src', 'test', 'samples']) {
    if ((await exists(resolve(installed, excluded))) === true) {
      throw new Error(`Package unexpectedly contains ${excluded}`);
    }
  }
  const cli = resolve(installed, 'dist', 'bin.js');
  const version = await run(process.execPath, [cli, '--version'], temporaryRoot);
  if (version.stdout.trim() !== metadata.version) {
    throw new Error(
      `Installed CLI version mismatch: expected ${metadata.version}, received ${JSON.stringify(version.stdout.trim())}; diagnostics ${JSON.stringify(version.stderr.trim())}`,
    );
  }
  const imported = await run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "import('witshift').then((module) => { if (typeof module.inspectProject !== 'function') process.exitCode = 1; })",
    ],
    temporaryRoot,
  );
  if (imported.stderr.length > 0) throw new Error(imported.stderr);
  process.stdout.write(
    `${JSON.stringify({ ok: true, archive: basename(archive), version: metadata.version })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function readdirOrRead(path) {
  try {
    await readdir(path);
  } catch {
    await readFile(path);
  }
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === 'EISDIR') return true;
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function run(command, argumentsList, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 131_072) stdout += chunk.slice(0, 131_072 - stdout.length);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 131_072) stderr += chunk.slice(0, 131_072 - stderr.length);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} failed with ${code ?? signal ?? 'unknown status'}: ${stderr.trim()}`,
          ),
        );
    });
  });
}
