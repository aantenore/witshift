import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, witshiftConfigSchema } from '../src/config.js';
import type { WitshiftError } from '../src/errors.js';

describe('configuration', () => {
  it('applies deny-by-default policy values', () => {
    const config = witshiftConfigSchema.parse({
      version: 1,
      entry: 'src/server.ts',
      build: { package: 'demo:weather', world: 'mcp-tools' },
    });

    expect(config.policy).toEqual({
      network: { allow: [] },
      storage: { read: [], write: [] },
    });
  });

  it('rejects parent path traversal', () => {
    expect(() =>
      witshiftConfigSchema.parse({
        version: 1,
        entry: '../server.ts',
        build: { package: 'demo:weather', world: 'mcp-tools' },
      }),
    ).toThrow();
  });

  it('normalizes invalid JSON into a typed configuration error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'witshift-config-'));
    await writeFile(join(root, 'witshift.config.json'), '{');

    await expect(loadConfig(root)).rejects.toMatchObject({
      code: 'INVALID_CONFIGURATION',
      exitCode: 3,
    } satisfies Partial<WitshiftError>);
  });
});
