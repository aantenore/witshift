import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectProject } from '../src/inspect.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function projectWith(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'witshift-inspect-'));
  roots.push(root);
  await Promise.all([
    writeFile(
      join(root, 'witshift.config.json'),
      JSON.stringify({
        version: 1,
        entry: 'server.ts',
        build: { package: 'test:fixture', world: 'mcp-tools' },
      }),
    ),
    writeFile(join(root, 'server.ts'), source),
  ]);
  return root;
}

describe('inspectProject', () => {
  it('inventories a supported static MCP tool and normalizes its Zod schema', async () => {
    const root = await projectWith(`
      import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
      import { z } from 'zod';
      const server = new McpServer({ name: 'weather', version: '1.0.0' });
      server.registerTool('forecast', {
        description: 'Return a deterministic forecast',
        inputSchema: z.object({ city: z.string(), days: z.number().optional() }),
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } } }
      }, ({ city }) => ({ structuredContent: { summary: \`Sunny in \${city}\` } }));
    `);

    const report = await inspectProject(root);

    expect(report.supported).toBe(true);
    expect(report.tools).toHaveLength(1);
    expect(report.tools[0]?.name).toBe('forecast');
    expect(report.tools[0]?.inputSchema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' }, days: { type: 'number' } },
      additionalProperties: false,
      required: ['city'],
    });
    expect(report.inputDigest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['dynamic import', `const x = import('./runtime.js');`],
    ['dynamic evaluation', `eval('2 + 2');`],
    ['process spawning', `import { exec } from 'node:child_process'; exec('date');`],
    ['native addon', `import addon from './native.node';`],
  ])('fails closed on %s', async (_label, forbidden) => {
    const root = await projectWith(`
      import { z } from 'zod';
      ${forbidden}
      server.registerTool('safe', { description: 'safe', inputSchema: z.object({ value: z.string() }) },
        ({ value }) => ({ structuredContent: { value } }));
    `);

    const report = await inspectProject(root);

    expect(report.supported).toBe(false);
    expect(report.unsupported.some((item) => item.fatal)).toBe(true);
  });

  it('rejects dynamic registration and external handler bindings', async () => {
    const root = await projectWith(`
      import { z } from 'zod';
      const name = 'forecast';
      const suffix = '!';
      server.registerTool(name, { description: 'unsafe', inputSchema: z.object({ city: z.string() }) },
        ({ city }) => ({ structuredContent: { text: city + suffix } }));
    `);

    const report = await inspectProject(root);

    expect(report.supported).toBe(false);
    expect(report.unsupported.map((item) => item.code)).toContain('AMBIGUOUS_TOOL_NAME');
  });

  it('rejects ambiguous schema calls', async () => {
    const root = await projectWith(`
      import { z } from 'zod';
      server.registerTool('bad', { description: 'bad', inputSchema: createSchema() },
        ({ value }) => ({ structuredContent: { value } }));
    `);

    const report = await inspectProject(root);

    expect(report.supported).toBe(false);
    expect(report.unsupported.map((item) => item.code)).toContain('AMBIGUOUS_SCHEMA');
  });
});
