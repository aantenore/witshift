import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildProject } from '../dist/index.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'witshift-component-smoke-'));

try {
  const project = resolve(repositoryRoot, 'samples', 'weather');
  const output = resolve(temporaryRoot, 'build');
  const transpiled = resolve(temporaryRoot, 'transpiled');
  const result = await buildProject(project, output, {
    cache: false,
    reproducibilityCheck: false,
  });
  await run(
    process.execPath,
    [
      packageManagerEntry(),
      'exec',
      'jco',
      'transpile',
      result.componentPath,
      '--out-dir',
      transpiled,
    ],
    repositoryRoot,
  );
  const namespace = await import(pathToFileURL(resolve(transpiled, 'component.js')).href);
  if (typeof namespace['getForecast'] !== 'function') {
    throw new Error('Transpiled component does not expose getForecast');
  }
  const invoke = namespace['getForecast'];
  const encoded = Reflect.apply(invoke, namespace, [JSON.stringify({ city: 'Turin' })]);
  if (typeof encoded !== 'string') throw new Error('Component result is not a JSON string');
  const decoded = JSON.parse(encoded);
  if (
    !isRecord(decoded) ||
    !isRecord(decoded['structuredContent']) ||
    decoded['structuredContent']['forecast'] !== 'Sunny in Turin'
  ) {
    throw new Error('Component result differs from the migrated handler contract');
  }
  const component = await readFile(result.componentPath);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      evidenceLevel: 'component-runtime',
      runtime: 'jco-transpiled-webassembly',
      componentSha256: createHash('sha256').update(component).digest('hex'),
      bytes: component.byteLength,
      result: decoded,
    })}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

function packageManagerEntry() {
  const entry = process.env.npm_execpath;
  if (!entry) throw new Error('Run component smoke through the pinned pnpm script');
  return entry;
}

function run(command, argumentsList, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, NO_COLOR: '1' },
    });
    let diagnostic = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (diagnostic.length < 65_536) diagnostic += chunk.slice(0, 65_536 - diagnostic.length);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `jco transpile failed with ${code ?? signal ?? 'unknown status'}: ${diagnostic.trim()}`,
          ),
        );
    });
  });
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
