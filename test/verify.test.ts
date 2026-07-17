import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyProject } from '../src/verify.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function verificationProject(componentForecast = 'Sunny'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'witshift-verify-'));
  roots.push(root);
  await mkdir(join(root, 'verify'));
  const adapter = (id: string, forecast: string) => `
    export function createAdapter() {
      return {
        id: ${JSON.stringify(id)},
        evidenceLevel: 'test-only',
        async invoke(tool, input) {
          if (tool !== 'forecast') throw new Error('unknown tool');
          return {
            content: [{ type: 'text', text: ${JSON.stringify(forecast)} + ' in ' + input.city }],
            structuredContent: { forecast: ${JSON.stringify(forecast)} + ' in ' + input.city }
          };
        }
      };
    }
  `;
  await Promise.all([
    writeFile(
      join(root, 'witshift.config.json'),
      JSON.stringify({
        version: 1,
        entry: 'server.ts',
        build: { package: 'demo:weather', world: 'mcp-tools' },
        policy: {
          network: { allow: ['weather.example'] },
          storage: { read: ['fixtures'], write: [] },
        },
        verification: {
          originalAdapter: 'verify/original.mjs',
          componentAdapter: 'verify/component.mjs',
          evidenceLevel: 'test-only',
          timeoutMs: 500,
        },
      }),
    ),
    writeFile(
      join(root, 'server.ts'),
      `import { z } from 'zod';
       server.registerTool('forecast', {
         description: 'Return a deterministic forecast',
         inputSchema: z.object({ city: z.string() }),
         outputSchema: {
           type: 'object',
           properties: { forecast: { type: 'string' } },
           required: ['forecast'],
           additionalProperties: false
         }
       }, ({ city }) => ({ structuredContent: { forecast: \`Sunny in \${city}\` } }));`,
    ),
    writeFile(join(root, 'verify', 'original.mjs'), adapter('original', 'Sunny')),
    writeFile(join(root, 'verify', 'component.mjs'), adapter('component', componentForecast)),
  ]);
  return root;
}

describe('verifyProject', () => {
  it('compares isolated executions and labels local policy evidence honestly', async () => {
    const root = await verificationProject();
    const fixtures = join(root, 'fixtures.jsonl');
    await writeFile(
      fixtures,
      [
        JSON.stringify({
          id: 'forecast-rome',
          tool: 'forecast',
          input: { city: 'Rome' },
          expect: {
            content: [{ type: 'text', text: 'Sunny in Rome' }],
            structuredContent: { forecast: 'Sunny in Rome' },
          },
        }),
        JSON.stringify({
          id: 'deny-network',
          tool: 'forecast',
          input: {},
          expectPolicyDeny: { capability: 'network', target: 'blocked.example' },
        }),
        JSON.stringify({
          id: 'deny-storage',
          tool: 'forecast',
          input: {},
          expectPolicyDeny: { capability: 'filesystem-read', target: '../private' },
        }),
      ].join('\n'),
    );

    const result = await verifyProject(root, fixtures);

    expect(result.report.passed).toBe(true);
    expect(result.report.summary).toEqual({
      total: 3,
      passed: 1,
      mismatched: 0,
      denied: 2,
      errors: 0,
    });
    expect(result.report.evidenceLevel).toBe('test-only');
    expect(result.report.cases[1]?.policyEvidence).toMatchObject({
      source: 'generated-policy-evaluator',
      runtimeEnforced: false,
    });
    expect(JSON.parse(await readFile(result.jsonPath, 'utf8'))).toEqual(result.report);
    expect(await readFile(result.markdownPath, 'utf8')).toContain('runtimeEnforced');
  });

  it('reports differential mismatches without throwing away the evidence', async () => {
    const root = await verificationProject('Cloudy');
    const fixtures = join(root, 'fixtures.jsonl');
    await writeFile(
      fixtures,
      JSON.stringify({ id: 'forecast-rome', tool: 'forecast', input: { city: 'Rome' } }),
    );

    const result = await verifyProject(root, fixtures);

    expect(result.report.passed).toBe(false);
    expect(result.report.summary.mismatched).toBe(1);
    expect(result.report.cases[0]).toMatchObject({
      status: 'mismatch',
      resultEqual: false,
    });
  });

  it('rejects malformed and duplicate fixture records as invalid input', async () => {
    const root = await verificationProject();
    const malformed = join(root, 'malformed.jsonl');
    const duplicate = join(root, 'duplicate.jsonl');
    await Promise.all([
      writeFile(malformed, '{'),
      writeFile(
        duplicate,
        [
          JSON.stringify({ id: 'same', tool: 'forecast', input: { city: 'Rome' } }),
          JSON.stringify({ id: 'same', tool: 'forecast', input: { city: 'Turin' } }),
        ].join('\n'),
      ),
    ]);

    await expect(verifyProject(root, malformed)).rejects.toMatchObject({
      code: 'INVALID_FIXTURES',
      exitCode: 2,
    });
    await expect(verifyProject(root, duplicate)).rejects.toMatchObject({
      code: 'INVALID_FIXTURES',
      exitCode: 2,
    });
  });

  it('does not count an allow-listed target as denial evidence', async () => {
    const root = await verificationProject();
    const fixtures = join(root, 'fixtures.jsonl');
    await writeFile(
      fixtures,
      JSON.stringify({
        id: 'allowed-network',
        tool: 'forecast',
        input: {},
        expectPolicyDeny: { capability: 'network', target: 'weather.example' },
      }),
    );

    const result = await verifyProject(root, fixtures);

    expect(result.report.passed).toBe(false);
    expect(result.report.summary.mismatched).toBe(1);
  });

  it('does not accept policy evidence for an unknown tool', async () => {
    const root = await verificationProject();
    const fixtures = join(root, 'fixtures.jsonl');
    await writeFile(
      fixtures,
      JSON.stringify({
        id: 'unknown-tool',
        tool: 'missing',
        input: {},
        expectPolicyDeny: { capability: 'network', target: 'blocked.example' },
      }),
    );

    const result = await verifyProject(root, fixtures);

    expect(result.report.passed).toBe(false);
    expect(result.report.summary).toMatchObject({ denied: 0, errors: 1 });
    expect(result.report.cases[0]?.message).toContain('Unknown tool');
  });
});
