import { z } from 'zod';

export const capabilityKindSchema = z.enum(['network', 'filesystem-read', 'filesystem-write']);
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

export const unsupportedConstructSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
  fatal: z.boolean(),
});
export type UnsupportedConstruct = z.infer<typeof unsupportedConstructSchema>;

export const toolInventorySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  handlerSource: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().positive(),
  capabilities: z.array(capabilityKindSchema),
});
export type ToolInventory = z.infer<typeof toolInventorySchema>;

export const inspectReportSchema = z.object({
  schemaVersion: z.literal(1),
  command: z.literal('inspect'),
  project: z.string(),
  entry: z.string(),
  supported: z.boolean(),
  tools: z.array(toolInventorySchema),
  imports: z.array(z.string()),
  capabilities: z.array(capabilityKindSchema),
  unsupported: z.array(unsupportedConstructSchema),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type InspectReport = z.infer<typeof inspectReportSchema>;

export const artifactDigestSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.number().int().nonnegative(),
});
export type ArtifactDigest = z.infer<typeof artifactDigestSchema>;

export const migrationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  projectName: z.string().min(1),
  package: z.string().min(1),
  world: z.string().min(1),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  lockDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  toolchain: z.object({
    provider: z.literal('jco'),
    jco: z.string().min(1),
    componentizeJs: z.string().min(1),
    node: z.string().min(1),
  }),
  tools: z.array(z.object({ name: z.string(), witName: z.string(), schemaDigest: z.string() })),
  artifacts: z.array(artifactDigestSchema),
  reproducibility: z.object({
    manifestDeterministic: z.literal(true),
    deliveryMode: z.enum(['content-addressed-cache', 'direct']),
    cacheKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    componentDigestCompared: z.boolean(),
    componentDigestStable: z.boolean().nullable(),
    note: z.string(),
  }),
});
export type MigrationManifest = z.infer<typeof migrationManifestSchema>;

export const verificationCaseSchema = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  input: z.unknown(),
  expect: z.unknown().optional(),
  expectPolicyDeny: z
    .object({
      capability: capabilityKindSchema,
      target: z.string().min(1),
    })
    .optional(),
});
export type VerificationCase = z.infer<typeof verificationCaseSchema>;

export const verificationCaseResultSchema = z.object({
  id: z.string(),
  tool: z.string(),
  status: z.enum(['pass', 'mismatch', 'policy-denied', 'error']),
  schemaEqual: z.boolean(),
  resultEqual: z.boolean(),
  original: z.unknown().optional(),
  component: z.unknown().optional(),
  policyEvidence: z
    .object({
      decision: z.literal('deny'),
      capability: capabilityKindSchema,
      target: z.string(),
      reason: z.string(),
    })
    .optional(),
  message: z.string().optional(),
});
export type VerificationCaseResult = z.infer<typeof verificationCaseResultSchema>;

export const verifyReportSchema = z.object({
  schemaVersion: z.literal(1),
  command: z.literal('verify'),
  project: z.string(),
  evidenceLevel: z.enum(['test-only', 'component-runtime', 'wassette-runtime']),
  passed: z.boolean(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    mismatched: z.number().int().nonnegative(),
    denied: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }),
  cases: z.array(verificationCaseResultSchema),
});
export type VerifyReport = z.infer<typeof verifyReportSchema>;

export interface ExecutionPort {
  readonly id: string;
  readonly evidenceLevel: 'test-only' | 'component-runtime' | 'wassette-runtime';
  invoke(tool: string, input: unknown): Promise<unknown>;
}

export interface ComponentToolchainPort {
  readonly id: 'jco';
  componentize(input: {
    sourcePath: string;
    witPath: string;
    outputPath: string;
    cwd: string;
    timeoutMs: number;
  }): Promise<void>;
  versions(cwd: string): Promise<{ jco: string; componentizeJs: string }>;
}

export interface BuildResult {
  readonly manifest: MigrationManifest;
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly reportPath: string;
  readonly componentPath: string;
}
