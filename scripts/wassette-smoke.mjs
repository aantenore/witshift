import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildProject } from '../dist/index.js';

const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, '..');
const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'witshift-wassette-smoke-'));
const wassetteBinary = process.env.WASSETTE_BIN ?? 'wassette';
const expectedVersion = process.env.WASSETTE_EXPECTED_VERSION ?? '0.4.0';
const expectedTool = 'get-forecast';
let client;

try {
  const versionOutput = await runWassette(['--version']);
  const runtimeVersion = versionOutput.trim().split(/\s+/u)[0];
  if (runtimeVersion !== expectedVersion) {
    throw new Error(`Expected Wassette ${expectedVersion}, found ${runtimeVersion || 'unknown'}`);
  }

  const project = resolve(repositoryRoot, 'samples', 'weather');
  const output = resolve(temporaryRoot, 'build');
  const componentDirectory = resolve(temporaryRoot, 'components');
  const result = await buildProject(project, output, {
    cache: false,
    reproducibilityCheck: false,
  });
  const component = await readFile(result.componentPath);
  const componentSha256 = createHash('sha256').update(component).digest('hex');
  const policy = await readFile(resolve(output, 'policy.yaml'));
  const policySha256 = createHash('sha256').update(policy).digest('hex');
  const transport = new StdioClientTransport({
    command: wassetteBinary,
    args: ['run', '--component-dir', componentDirectory],
    stderr: 'pipe',
  });
  transport.stderr?.resume();
  client = new Client({ name: 'witshift-wassette-smoke', version: '1' });
  await client.connect(transport);
  const loaded = await client.callTool({
    name: 'load-component',
    arguments: { path: pathToFileURL(result.componentPath).href },
  });
  if (loaded.isError === true) throw new Error('Wassette rejected the generated component');
  const listed = await client.listTools();
  const tool = listed.tools.find((candidate) => candidate.name === expectedTool);
  if (!tool) throw new Error(`Wassette MCP surface did not expose ${expectedTool}`);
  if (tool.inputSchema.type !== 'object' || !isRecord(tool.inputSchema.properties)) {
    throw new Error(`${expectedTool} has an invalid MCP input schema`);
  }

  const response = await client.callTool({
    name: expectedTool,
    arguments: { input: JSON.stringify({ city: 'Turin' }) },
  });
  const decoded = decodeComponentResponse(response);
  if (
    !isRecord(decoded) ||
    !isRecord(decoded['structuredContent']) ||
    decoded['structuredContent']['forecast'] !== 'Sunny in Turin'
  ) {
    throw new Error('Wassette result differs from the migrated handler contract');
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      evidence: 'wassette-load-discover-invoke',
      runtime: 'wassette',
      runtimeVersion,
      platform: `${process.platform}-${process.arch}`,
      componentSha256,
      policySha256,
      tool: expectedTool,
      result: decoded,
    })}\n`,
  );
} finally {
  await client?.close().catch(() => undefined);
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function runWassette(argumentsList) {
  const { stdout } = await execFile(wassetteBinary, argumentsList, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 1_048_576,
    timeout: 180_000,
    windowsHide: true,
  });
  return stdout;
}

function decodeComponentResponse(response) {
  if (!isRecord(response) || !Array.isArray(response['content'])) {
    throw new Error('Wassette returned malformed MCP call evidence');
  }
  const text = response['content'].find(
    (entry) => isRecord(entry) && entry['type'] === 'text' && typeof entry['text'] === 'string',
  );
  if (!text || typeof text['text'] !== 'string') {
    throw new Error('Wassette MCP call did not return text content');
  }
  return JSON.parse(text['text']);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
