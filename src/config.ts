import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ExitCode, WitshiftError } from './errors.js';

const relativePathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.startsWith('/') && !value.includes('..'), {
    message: 'must be a project-relative path without parent traversal',
  });

export const witshiftConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  entry: relativePathSchema,
  build: z.object({
    package: z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u),
    world: z.string().regex(/^[a-z][a-z0-9-]*$/u),
    timeoutMs: z.number().int().min(1_000).max(600_000).default(180_000),
  }),
  policy: z
    .object({
      network: z.object({ allow: z.array(z.string().min(1)).default([]) }).default({ allow: [] }),
      storage: z
        .object({
          read: z.array(relativePathSchema).default([]),
          write: z.array(relativePathSchema).default([]),
        })
        .default({ read: [], write: [] }),
    })
    .default({ network: { allow: [] }, storage: { read: [], write: [] } }),
  verification: z
    .object({
      originalAdapter: relativePathSchema,
      componentAdapter: relativePathSchema,
      evidenceLevel: z.enum(['test-only', 'component-runtime', 'wassette-runtime']),
      timeoutMs: z.number().int().min(100).max(300_000).default(30_000),
    })
    .optional(),
});

export type WitshiftConfig = z.infer<typeof witshiftConfigSchema>;

export interface LoadedConfig {
  readonly projectRoot: string;
  readonly configPath: string;
  readonly config: WitshiftConfig;
  readonly raw: string;
}

export async function loadConfig(projectPath: string): Promise<LoadedConfig> {
  const projectRoot = resolve(projectPath);
  const configPath = resolve(projectRoot, 'witshift.config.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const config = witshiftConfigSchema.parse(parsed);
    return { projectRoot, configPath, config, raw };
  } catch (error) {
    if (error instanceof WitshiftError) throw error;
    const message = error instanceof Error ? error.message : 'Unable to load configuration';
    throw new WitshiftError(
      'INVALID_CONFIGURATION',
      `Invalid ${configPath}: ${message}`,
      ExitCode.invalidConfiguration,
      undefined,
      { cause: error },
    );
  }
}
