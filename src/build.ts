import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import type {
  ArtifactDigest,
  BuildResult,
  ComponentToolchainPort,
  MigrationManifest,
  ToolInventory,
} from './contracts.js';
import { loadConfig, type LoadedConfig } from './config.js';
import { ExitCode, WitshiftError } from './errors.js';
import { canonicalJson, sha256 } from './hash.js';
import { inspectProject } from './inspect.js';
import { JcoToolchainAdapter } from './toolchain/jco.js';

export interface BuildOptions {
  readonly cache?: boolean;
  readonly reproducibilityCheck?: boolean;
  readonly toolchain?: ComponentToolchainPort;
}

export async function buildProject(
  projectPath: string,
  outputPath: string,
  options: BuildOptions = {},
): Promise<BuildResult> {
  const loaded = await loadConfig(projectPath);
  const inspection = await inspectProject(projectPath);
  if (!inspection.supported) {
    throw new WitshiftError(
      'UNSUPPORTED_PROJECT',
      'Project contains constructs outside the fail-closed migration subset',
      ExitCode.unsupportedProject,
      { unsupported: inspection.unsupported },
    );
  }
  const names = mapToolNames(inspection.tools);
  const outputDirectory = resolve(outputPath);
  const generatedDirectory = resolve(outputDirectory, 'generated');
  await mkdir(generatedDirectory, { recursive: true });

  const witPath = resolve(outputDirectory, 'world.wit');
  const sourcePath = resolve(generatedDirectory, 'component.js');
  const policyPath = resolve(outputDirectory, 'policy.yaml');
  const componentPath = resolve(outputDirectory, 'component.wasm');
  const reproducibilityPath = resolve(outputDirectory, '.component.repro.wasm');
  const manifestPath = resolve(outputDirectory, 'migration-manifest.json');
  const reportPath = resolve(outputDirectory, 'build-report.md');

  const witSource = generateWit(loaded, names);
  const componentSource = generateComponentSource(inspection.tools, names);
  const policySource = generatePolicy(loaded);
  await Promise.all([
    writeFile(witPath, witSource, 'utf8'),
    writeFile(sourcePath, componentSource, 'utf8'),
    writeFile(policyPath, policySource, 'utf8'),
  ]);

  const toolchain = options.toolchain ?? new JcoToolchainAdapter();
  const versions = await toolchain.versions(loaded.projectRoot);
  const configDigest = sha256(canonicalJson(loaded.config));
  const lockDigest = await optionalFileDigest(resolve(loaded.projectRoot, 'pnpm-lock.yaml'));
  const cacheEnabled = options.cache ?? true;
  const runReproducibilityCheck = options.reproducibilityCheck ?? true;
  const cacheKey = cacheEnabled
    ? sha256(
        canonicalJson({
          inputDigest: inspection.inputDigest,
          configDigest,
          lockDigest,
          toolchain: { ...versions, node: process.versions.node },
          generated: {
            wit: sha256(witSource),
            componentSource: sha256(componentSource),
            policy: sha256(policySource),
          },
        }),
      )
    : null;
  const cacheDirectory = resolve(loaded.projectRoot, '.witshift', 'cache', 'components');
  const cachedComponentPath = cacheKey ? resolve(cacheDirectory, `${cacheKey}.wasm`) : undefined;
  const cacheObservationPath = cacheKey ? resolve(cacheDirectory, `${cacheKey}.json`) : undefined;
  let observation =
    cachedComponentPath && cacheObservationPath
      ? await restoreCachedComponent(cachedComponentPath, cacheObservationPath, componentPath)
      : undefined;
  if (!observation) {
    await toolchain.componentize({
      sourcePath,
      witPath,
      outputPath: componentPath,
      cwd: loaded.projectRoot,
      timeoutMs: loaded.config.build.timeoutMs,
    });
    await assertComponent(componentPath);
    const admittedDigest = sha256(await readFile(componentPath));
    let cleanRoomStable: boolean | null = null;
    if (runReproducibilityCheck) {
      try {
        await toolchain.componentize({
          sourcePath,
          witPath,
          outputPath: reproducibilityPath,
          cwd: loaded.projectRoot,
          timeoutMs: loaded.config.build.timeoutMs,
        });
        await assertComponent(reproducibilityPath);
        cleanRoomStable = sha256(await readFile(reproducibilityPath)) === admittedDigest;
      } finally {
        await unlink(reproducibilityPath).catch(() => undefined);
      }
    }
    observation = {
      schemaVersion: 1,
      artifactDigest: admittedDigest,
      componentDigestCompared: runReproducibilityCheck,
      componentDigestStable: cleanRoomStable,
    };
    if (cachedComponentPath && cacheObservationPath) {
      await admitComponentToCache(
        componentPath,
        cachedComponentPath,
        cacheObservationPath,
        observation,
      );
    }
  }
  const componentDigest = await artifactDigest(outputDirectory, componentPath);
  if (componentDigest.sha256 !== observation.artifactDigest) {
    throw new WitshiftError(
      'CACHE_INTEGRITY_FAILURE',
      'Delivered component digest does not match its build observation',
      ExitCode.toolchainFailure,
      { expected: observation.artifactDigest, actual: componentDigest.sha256 },
    );
  }

  const artifacts = await Promise.all([
    artifactDigest(outputDirectory, witPath),
    artifactDigest(outputDirectory, sourcePath),
    artifactDigest(outputDirectory, policyPath),
    Promise.resolve(componentDigest),
  ]);
  const manifest: MigrationManifest = {
    schemaVersion: 1,
    projectName: basename(loaded.projectRoot),
    package: loaded.config.build.package,
    world: loaded.config.build.world,
    inputDigest: inspection.inputDigest,
    configDigest,
    lockDigest,
    toolchain: {
      provider: 'jco',
      jco: versions.jco,
      componentizeJs: versions.componentizeJs,
      node: process.versions.node,
    },
    tools: inspection.tools.map((tool) => ({
      name: tool.name,
      witName: names.get(tool.name) ?? tool.name,
      schemaDigest: sha256(canonicalJson(tool.inputSchema)),
    })),
    artifacts: artifacts.sort((left, right) => left.path.localeCompare(right.path)),
    reproducibility: {
      canonicalSerialization: true,
      deliveryMode: cacheEnabled ? 'content-addressed-cache' : 'direct',
      cacheKey,
      componentDigestCompared: observation.componentDigestCompared,
      componentDigestStable: observation.componentDigestStable,
      note: reproducibilityNote(cacheEnabled, observation),
    },
  };
  await Promise.all([
    writeFile(manifestPath, `${canonicalJson(manifest)}\n`, 'utf8'),
    writeFile(reportPath, buildMarkdown(manifest), 'utf8'),
  ]);
  return { manifest, outputDirectory, manifestPath, reportPath, componentPath };
}

interface CacheObservation {
  readonly schemaVersion: 1;
  readonly artifactDigest: string;
  readonly componentDigestCompared: boolean;
  readonly componentDigestStable: boolean | null;
}

async function restoreCachedComponent(
  cachePath: string,
  observationPath: string,
  outputPath: string,
): Promise<CacheObservation | undefined> {
  let observationText: string;
  try {
    observationText = await readFile(observationPath, 'utf8');
    await assertComponent(cachePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
  let observation: CacheObservation;
  try {
    const parsed = JSON.parse(observationText) as unknown;
    if (!isCacheObservation(parsed)) throw new Error('Invalid cache observation shape');
    observation = parsed;
  } catch (error) {
    throw new WitshiftError(
      'CACHE_INTEGRITY_FAILURE',
      'Cached component observation is invalid',
      ExitCode.toolchainFailure,
      { observationPath },
      { cause: error },
    );
  }
  const actualDigest = sha256(await readFile(cachePath));
  if (actualDigest !== observation.artifactDigest) {
    throw new WitshiftError(
      'CACHE_INTEGRITY_FAILURE',
      'Cached component digest does not match its observation',
      ExitCode.toolchainFailure,
      { expected: observation.artifactDigest, actual: actualDigest },
    );
  }
  await copyFile(cachePath, outputPath);
  return observation;
}

async function admitComponentToCache(
  sourcePath: string,
  cachePath: string,
  observationPath: string,
  observation: CacheObservation,
): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  try {
    await copyFile(sourcePath, cachePath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    const existingDigest = sha256(await readFile(cachePath));
    if (existingDigest !== observation.artifactDigest) {
      throw new WitshiftError(
        'CACHE_ADMISSION_CONFLICT',
        'Concurrent builds produced different component bytes for the same cache key',
        ExitCode.toolchainFailure,
        { expected: observation.artifactDigest, actual: existingDigest },
      );
    }
  }
  try {
    await writeFile(observationPath, `${canonicalJson(observation)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await readFile(observationPath, 'utf8')) as unknown;
    if (!isCacheObservation(existing) || canonicalJson(existing) !== canonicalJson(observation)) {
      throw new WitshiftError(
        'CACHE_ADMISSION_CONFLICT',
        'Concurrent builds recorded different observations for the same cache key',
        ExitCode.toolchainFailure,
        { observationPath },
      );
    }
  }
}

function reproducibilityNote(cacheEnabled: boolean, observation: CacheObservation): string {
  const comparison = observation.componentDigestCompared
    ? observation.componentDigestStable
      ? 'Independent componentizations produced identical bytes.'
      : 'Independent upstream componentizations produced different bytes.'
    : 'Independent componentization was not compared.';
  return cacheEnabled
    ? `${comparison} Repeat delivery is stabilized by an integrity-checked content-addressed cache; this is not a clean-room reproducibility claim.`
    : `${comparison} Direct delivery does not stabilize upstream nondeterminism.`;
}

function isCacheObservation(value: unknown): value is CacheObservation {
  return (
    value !== null &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'artifactDigest' in value &&
    typeof value.artifactDigest === 'string' &&
    /^[a-f0-9]{64}$/u.test(value.artifactDigest) &&
    'componentDigestCompared' in value &&
    typeof value.componentDigestCompared === 'boolean' &&
    'componentDigestStable' in value &&
    (typeof value.componentDigestStable === 'boolean' || value.componentDigestStable === null)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function mapToolNames(tools: readonly ToolInventory[]): Map<string, string> {
  const mapping = new Map<string, string>();
  const occupied = new Set<string>();
  for (const tool of tools) {
    const normalized = tool.name
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/gu, '-')
      .replace(/[^a-z0-9-]/gu, '-')
      .replace(/-+/gu, '-')
      .replace(/^-|-$/gu, '');
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(normalized)) {
      throw new WitshiftError(
        'UNSUPPORTED_TOOL_NAME',
        `Tool name ${tool.name} cannot be represented as a WIT identifier`,
        ExitCode.unsupportedProject,
        { tool: tool.name },
      );
    }
    if (occupied.has(normalized)) {
      throw new WitshiftError(
        'AMBIGUOUS_WIT_TOOL_NAME',
        `Multiple tools normalize to ${normalized}`,
        ExitCode.unsupportedProject,
        { tool: tool.name, witName: normalized },
      );
    }
    occupied.add(normalized);
    mapping.set(tool.name, normalized);
  }
  return mapping;
}

function generateWit(loaded: LoadedConfig, names: ReadonlyMap<string, string>): string {
  const functions = [...names.values()]
    .sort()
    .map((name) => `    ${name}: func(input: string) -> string;`)
    .join('\n');
  return `package ${loaded.config.build.package}@0.1.0;

interface tools {
${functions}
}

world ${loaded.config.build.world} {
  export tools;
}
`;
}

function generateComponentSource(
  tools: readonly ToolInventory[],
  names: ReadonlyMap<string, string>,
): string {
  const handlers = tools
    .map((tool, index) => `const handler${index} = (${tool.handlerSource});`)
    .join('\n');
  const methods = tools
    .map((tool, index) => {
      const witName = names.get(tool.name);
      if (!witName) throw new Error(`Missing WIT mapping for ${tool.name}`);
      return `  ${toJsIdentifier(witName)}(input) {
    const output = handler${index}(JSON.parse(input));
    return JSON.stringify(output);
  }`;
    })
    .join(',\n');
  return `// Generated by WITShift. Edit the MCP source, then regenerate.
${handlers}

export const tools = {
${methods}
};
`;
}

function generatePolicy(loaded: LoadedConfig): string {
  const storage = new Map<string, Set<'read' | 'write'>>();
  for (const path of loaded.config.policy.storage.read) {
    const access = storage.get(path) ?? new Set<'read' | 'write'>();
    access.add('read');
    storage.set(path, access);
  }
  for (const path of loaded.config.policy.storage.write) {
    const access = storage.get(path) ?? new Set<'read' | 'write'>();
    access.add('write');
    storage.set(path, access);
  }
  const permissions: Record<string, unknown> = {};
  if (storage.size > 0) {
    permissions['storage'] = {
      allow: [...storage]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, access]) => ({ uri: `fs://${path}`, access: [...access].sort() })),
    };
  }
  if (loaded.config.policy.network.allow.length > 0) {
    permissions['network'] = {
      allow: [...loaded.config.policy.network.allow].sort().map((host) => ({ host })),
    };
  }
  return stringifyYaml({
    version: '1.0',
    description: 'Generated least-privilege policy; unspecified capabilities remain denied.',
    permissions,
  });
}

function toJsIdentifier(witName: string): string {
  return witName.replace(/-([a-z0-9])/gu, (_match, character: string) => character.toUpperCase());
}

async function assertComponent(path: string): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    throw new WitshiftError(
      'TOOLCHAIN_NO_ARTIFACT',
      'Official component toolchain did not emit the requested artifact',
      ExitCode.toolchainFailure,
      { path },
      { cause: error },
    );
  }
  const componentHeader = [0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00];
  if (
    bytes.length < componentHeader.length ||
    componentHeader.some((value, index) => bytes[index] !== value)
  ) {
    throw new WitshiftError(
      'INVALID_COMPONENT_ARTIFACT',
      'Toolchain output is not a WebAssembly Component binary',
      ExitCode.toolchainFailure,
      { path },
    );
  }
}

async function artifactDigest(root: string, path: string): Promise<ArtifactDigest> {
  const [bytes, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    path: relative(root, path).replaceAll('\\', '/'),
    sha256: sha256(bytes),
    bytes: metadata.size,
  };
}

async function optionalFileDigest(path: string): Promise<string | null> {
  try {
    return sha256(await readFile(path));
  } catch {
    return null;
  }
}

function buildMarkdown(manifest: MigrationManifest): string {
  return `# WITShift build report

- Project: \`${manifest.projectName}\`
- World: \`${manifest.package}/${manifest.world}\`
- Input digest: \`${manifest.inputDigest}\`
- Toolchain: jco ${manifest.toolchain.jco}, ComponentizeJS ${manifest.toolchain.componentizeJs}
- Repeat component digest stable: **${manifest.reproducibility.componentDigestStable === null ? 'not checked' : manifest.reproducibility.componentDigestStable ? 'yes' : 'no'}**

## Artifact evidence

${manifest.artifacts.map((artifact) => `- \`${artifact.path}\`: \`${artifact.sha256}\` (${artifact.bytes} bytes)`).join('\n')}

## Reproducibility note

${manifest.reproducibility.note}
`;
}
