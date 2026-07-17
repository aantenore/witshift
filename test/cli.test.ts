import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../src/cli.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function capture(): { io: CliIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    stdout,
    stderr,
  };
}

async function projectWith(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'witshift-cli-'));
  roots.push(root);
  await Promise.all([
    writeFile(
      join(root, 'witshift.config.json'),
      JSON.stringify({
        version: 1,
        entry: 'server.ts',
        build: { package: 'demo:cli', world: 'mcp-tools' },
      }),
    ),
    writeFile(join(root, 'server.ts'), source),
  ]);
  return root;
}

describe('runCli', () => {
  it('emits one stable JSON error and exit 2 for invalid arguments', async () => {
    const output = capture();

    const exitCode = await runCli(['node', 'witshift', '--json', 'unknown'], output.io);

    expect(exitCode).toBe(2);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? '')).toMatchObject({
      schemaVersion: 1,
      ok: false,
      exitCode: 2,
      error: { code: 'INVALID_ARGUMENTS' },
    });
  });

  it('requires an explicit command', async () => {
    const output = capture();

    const exitCode = await runCli(['node', 'witshift'], output.io);

    expect(exitCode).toBe(2);
    expect(output.stdout).toEqual([]);
    expect(output.stderr.join('')).toContain('A command is required');
  });

  it('writes inspection evidence and returns success for the supported subset', async () => {
    const root = await projectWith(`
      import { z } from 'zod';
      server.registerTool('echo', {
        description: 'Echo a value',
        inputSchema: z.object({ value: z.string() })
      }, ({ value }) => ({ structuredContent: { value } }));
    `);
    const reportDirectory = join(root, 'reports');
    const output = capture();

    const exitCode = await runCli(
      ['node', 'witshift', 'inspect', root, '--report-dir', reportDirectory, '--json'],
      output.io,
    );

    expect(exitCode).toBe(0);
    expect(output.stderr).toEqual([]);
    const payload = JSON.parse(output.stdout[0] ?? '') as {
      report: { supported: boolean };
      jsonPath: string;
    };
    expect(payload.report.supported).toBe(true);
    expect(JSON.parse(await readFile(payload.jsonPath, 'utf8'))).toMatchObject({
      command: 'inspect',
      supported: true,
    });
  });

  it('preserves the report while returning exit 4 for unsupported input', async () => {
    const root = await projectWith(`
      import { z } from 'zod';
      eval('unsafe');
      server.registerTool('echo', {
        description: 'Echo a value',
        inputSchema: z.object({ value: z.string() })
      }, ({ value }) => ({ structuredContent: { value } }));
    `);
    const output = capture();

    const exitCode = await runCli(['node', 'witshift', '--json', 'inspect', root], output.io);

    expect(exitCode).toBe(4);
    expect(JSON.parse(output.stdout[0] ?? '')).toMatchObject({
      report: { supported: false },
    });
  });
});
