import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProject } from '../src/build.js';
import type { ComponentToolchainPort } from '../src/contracts.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class DeterministicTestToolchain implements ComponentToolchainPort {
  public readonly id = 'jco' as const;

  public async componentize(input: {
    sourcePath: string;
    witPath: string;
    outputPath: string;
  }): Promise<void> {
    const content = await Promise.all([readFile(input.sourcePath), readFile(input.witPath)]);
    const digest = createHash('sha256').update(content[0]).update(content[1]).digest();
    await writeFile(
      input.outputPath,
      Buffer.concat([Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00]), digest]),
    );
  }

  public versions(): Promise<{ jco: string; componentizeJs: string }> {
    return Promise.resolve({ jco: 'test-jco', componentizeJs: 'test-componentizer' });
  }
}

class InvalidArtifactTestToolchain extends DeterministicTestToolchain {
  public override async componentize(input: { outputPath: string }): Promise<void> {
    await writeFile(
      input.outputPath,
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
  }
}

async function supportedProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'witshift-build-'));
  roots.push(root);
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
      }),
    ),
    writeFile(
      join(root, 'server.ts'),
      `import { z } from 'zod';
       server.registerTool('get_forecast', {
         description: 'Get a forecast',
         inputSchema: z.object({ city: z.string() })
       }, ({ city }) => ({ structuredContent: { forecast: \`Sunny in \${city}\` } }));`,
    ),
    writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n'),
  ]);
  return root;
}

describe('buildProject', () => {
  it('emits deterministic migration artifacts and a least-privilege policy', async () => {
    const project = await supportedProject();
    const first = await buildProject(project, join(project, 'out-a'), {
      toolchain: new DeterministicTestToolchain(),
    });
    const second = await buildProject(project, join(project, 'out-b'), {
      toolchain: new DeterministicTestToolchain(),
    });

    expect(first.manifest).toEqual(second.manifest);
    expect(first.manifest.reproducibility.componentDigestStable).toBe(true);
    expect(first.manifest.tools).toEqual([
      expect.objectContaining({ name: 'get_forecast', witName: 'get-forecast' }),
    ]);
    expect(await readFile(first.componentPath)).toEqual(await readFile(second.componentPath));
    const wit = await readFile(join(first.outputDirectory, 'world.wit'), 'utf8');
    const source = await readFile(join(first.outputDirectory, 'generated', 'component.js'), 'utf8');
    expect(wit).toContain('export get-forecast: func(input: string) -> string;');
    expect(wit).not.toContain('interface tools');
    expect(source).toContain('export function getForecast(input)');
    expect(source).not.toContain('export const tools');
    const policy = parseYaml(
      await readFile(join(first.outputDirectory, 'policy.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(policy).toMatchObject({
      version: '1.0',
      permissions: {
        network: { allow: [{ host: 'weather.example' }] },
        storage: { allow: [{ uri: 'fs://fixtures', access: ['read'] }] },
      },
    });
  });

  it('rejects output that is a core module rather than a component', async () => {
    const project = await supportedProject();

    await expect(
      buildProject(project, join(project, 'out'), {
        toolchain: new InvalidArtifactTestToolchain(),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_COMPONENT_ARTIFACT', exitCode: 5 });
  });
});
