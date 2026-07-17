import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, posix, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type {
  ExecutionPort,
  PolicyDenyEvidence,
  PolicyProbeRequest,
  ToolInventory,
  VerificationCase,
  VerificationCaseResult,
  VerifyReport,
  VerifyResult,
} from './contracts.js';
import { verificationCaseSchema } from './contracts.js';
import { loadConfig, type LoadedConfig, type WitshiftConfig } from './config.js';
import { ExitCode, WitshiftError } from './errors.js';
import { canonicalJson } from './hash.js';
import { inspectProject } from './inspect.js';
import { writeReportPair } from './reporting.js';

const MAX_FIXTURE_BYTES = 10 * 1024 * 1024;
const MAX_FIXTURE_LINES = 1_000;
const MAX_LINE_CODE_UNITS = 1_000_000;

export interface VerifyOptions {
  readonly reportDirectory?: string;
  readonly originalPort?: ExecutionPort;
  readonly componentPort?: ExecutionPort;
}

export async function verifyProject(
  projectPath: string,
  fixturesPath: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const loaded = await loadConfig(projectPath);
  const verification = loaded.config.verification;
  if (!verification && (!options.originalPort || !options.componentPort)) {
    throw new WitshiftError(
      'VERIFICATION_NOT_CONFIGURED',
      'Configure both execution adapters or inject both execution ports',
      ExitCode.invalidConfiguration,
    );
  }
  const inspection = await inspectProject(projectPath);
  if (!inspection.supported) {
    throw new WitshiftError(
      'UNSUPPORTED_PROJECT',
      'Cannot verify a project that fails static inspection',
      ExitCode.unsupportedProject,
      { unsupported: inspection.unsupported },
    );
  }
  const fixtures = await readFixtures(fixturesPath);
  const originalPort =
    options.originalPort ??
    (await loadExecutionPort(loaded, verification?.originalAdapter ?? '', 'original'));
  const componentPort =
    options.componentPort ??
    (await loadExecutionPort(loaded, verification?.componentAdapter ?? '', 'component'));
  const configuredEvidence = verification?.evidenceLevel ?? componentPort.evidenceLevel;
  if (componentPort.evidenceLevel !== configuredEvidence) {
    throw new WitshiftError(
      'ADAPTER_EVIDENCE_MISMATCH',
      `Configured evidence ${configuredEvidence} does not match component adapter evidence ${componentPort.evidenceLevel}`,
      ExitCode.invalidConfiguration,
      { configuredEvidence, adapterEvidence: componentPort.evidenceLevel },
    );
  }
  const timeoutMs = verification?.timeoutMs ?? 30_000;
  const tools = new Map(inspection.tools.map((tool) => [tool.name, tool]));
  const validators = createValidators(inspection.tools);
  const cases: VerificationCaseResult[] = [];
  for (const fixture of fixtures) {
    cases.push(
      await verifyCase(
        fixture,
        tools,
        validators,
        originalPort,
        componentPort,
        loaded.config,
        timeoutMs,
      ),
    );
  }
  const passed = cases.filter((item) => item.status === 'pass').length;
  const denied = cases.filter((item) => item.status === 'policy-denied').length;
  const mismatched = cases.filter((item) => item.status === 'mismatch').length;
  const errors = cases.filter((item) => item.status === 'error').length;
  const hasNonRuntimePolicyEvidence = cases.some(
    (item) => item.policyEvidence && !item.policyEvidence.runtimeEnforced,
  );
  const report: VerifyReport = {
    schemaVersion: 1,
    command: 'verify',
    project: basename(loaded.projectRoot),
    evidenceLevel: hasNonRuntimePolicyEvidence ? 'test-only' : configuredEvidence,
    passed: mismatched === 0 && errors === 0 && passed + denied === cases.length,
    summary: { total: cases.length, passed, mismatched, denied, errors },
    cases,
  };
  const reportDirectory = resolve(
    options.reportDirectory ?? resolve(loaded.projectRoot, '.witshift', 'reports', 'verify'),
  );
  const paths = await writeReportPair(
    reportDirectory,
    'verification-report',
    report,
    verifyMarkdown(report),
  );
  return {
    report,
    reportDirectory,
    jsonPath: paths.json,
    markdownPath: paths.markdown,
  };
}

async function verifyCase(
  fixture: VerificationCase,
  tools: ReadonlyMap<string, ToolInventory>,
  validators: ReadonlyMap<string, ToolValidators>,
  originalPort: ExecutionPort,
  componentPort: ExecutionPort,
  config: WitshiftConfig,
  timeoutMs: number,
): Promise<VerificationCaseResult> {
  const tool = tools.get(fixture.tool);
  const validator = validators.get(fixture.tool);
  if (!tool || !validator) {
    return resultBase(fixture, 'error', false, false, `Unknown tool ${fixture.tool}`);
  }
  if (fixture.expectPolicyDeny) {
    return verifyPolicyCase(fixture, componentPort, config, timeoutMs);
  }
  if (!validator.input(fixture.input)) {
    return resultBase(
      fixture,
      'error',
      false,
      false,
      `Fixture input violates the tool schema: ${formatAjvErrors(validator.input)}`,
    );
  }
  try {
    const original = await invokeBounded(originalPort, fixture.tool, fixture.input, timeoutMs);
    const component = await invokeBounded(componentPort, fixture.tool, fixture.input, timeoutMs);
    assertJsonValue(original, `${originalPort.id} result`);
    assertJsonValue(component, `${componentPort.id} result`);
    const resultEqual = canonicalJson(original) === canonicalJson(component);
    const originalSchemaValid = validateOutput(validator.output, original);
    const componentSchemaValid = validateOutput(validator.output, component);
    const schemaEqual = originalSchemaValid && componentSchemaValid;
    const expectedEqual =
      fixture.expect === undefined ||
      (canonicalJson(original) === canonicalJson(fixture.expect) &&
        canonicalJson(component) === canonicalJson(fixture.expect));
    const status = resultEqual && schemaEqual && expectedEqual ? 'pass' : 'mismatch';
    const base: VerificationCaseResult = {
      id: fixture.id,
      tool: fixture.tool,
      status,
      schemaEqual,
      resultEqual: resultEqual && expectedEqual,
      original,
      component,
    };
    return status === 'pass'
      ? base
      : {
          ...base,
          message: mismatchMessage(resultEqual, schemaEqual, expectedEqual, validator.output),
        };
  } catch (error) {
    return resultBase(
      fixture,
      'error',
      false,
      false,
      error instanceof Error ? truncate(error.message) : 'Execution failed',
    );
  }
}

async function verifyPolicyCase(
  fixture: VerificationCase,
  componentPort: ExecutionPort,
  config: WitshiftConfig,
  timeoutMs: number,
): Promise<VerificationCaseResult> {
  const request = fixture.expectPolicyDeny;
  if (!request) throw new Error('Policy fixture is missing its request');
  try {
    const evidence = componentPort.probePolicy
      ? await policyProbeBounded(componentPort, request, timeoutMs)
      : evaluateGeneratedPolicy(config, request);
    if (!evidence) {
      return resultBase(
        fixture,
        'mismatch',
        true,
        false,
        `Policy allowed ${request.capability} target ${request.target}`,
      );
    }
    if (!isPolicyDenyEvidence(evidence)) {
      return resultBase(
        fixture,
        'error',
        true,
        false,
        'Policy probe returned malformed denial evidence',
      );
    }
    if (evidence.capability !== request.capability || evidence.target !== request.target) {
      return resultBase(
        fixture,
        'error',
        true,
        false,
        'Policy evidence does not bind to the requested capability and target',
      );
    }
    return {
      id: fixture.id,
      tool: fixture.tool,
      status: 'policy-denied',
      schemaEqual: true,
      resultEqual: true,
      policyEvidence: evidence,
    };
  } catch (error) {
    return resultBase(
      fixture,
      'error',
      true,
      false,
      error instanceof Error ? truncate(error.message) : 'Policy probe failed',
    );
  }
}

interface ToolValidators {
  readonly input: ValidateFunction;
  readonly output?: ValidateFunction;
}

function createValidators(tools: readonly ToolInventory[]): Map<string, ToolValidators> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return new Map(
    tools.map((tool) => {
      const input = ajv.compile(tool.inputSchema);
      const output = tool.outputSchema ? ajv.compile(tool.outputSchema) : undefined;
      return [tool.name, output ? { input, output } : { input }];
    }),
  );
}

async function readFixtures(path: string): Promise<VerificationCase[]> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch (error) {
    throw new WitshiftError(
      'FIXTURES_NOT_READABLE',
      `Cannot read fixtures at ${path}`,
      ExitCode.ioFailure,
      { path },
      { cause: error },
    );
  }
  if (!metadata.isFile() || metadata.size > MAX_FIXTURE_BYTES) {
    throw new WitshiftError(
      'INVALID_FIXTURES',
      `Fixture file must be at most ${MAX_FIXTURE_BYTES} bytes`,
      ExitCode.invalidArguments,
      { bytes: metadata.size },
    );
  }
  const text = await readFile(path, 'utf8');
  if (text.length > MAX_FIXTURE_BYTES) {
    throw new WitshiftError(
      'INVALID_FIXTURES',
      'Fixture text exceeds the configured bound',
      ExitCode.invalidArguments,
    );
  }
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > MAX_FIXTURE_LINES) {
    throw new WitshiftError(
      'INVALID_FIXTURES',
      `Fixture file must contain between 1 and ${MAX_FIXTURE_LINES} JSON lines`,
      ExitCode.invalidArguments,
    );
  }
  const fixtures: VerificationCase[] = [];
  const ids = new Set<string>();
  for (const [index, line] of lines.entries()) {
    if (line.length > MAX_LINE_CODE_UNITS) {
      throw invalidFixture(index, 'line exceeds the configured bound');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw invalidFixture(index, error instanceof Error ? error.message : 'invalid JSON');
    }
    const result = verificationCaseSchema.safeParse(parsed);
    if (!result.success) throw invalidFixture(index, result.error.message);
    if (ids.has(result.data.id)) throw invalidFixture(index, `duplicate id ${result.data.id}`);
    ids.add(result.data.id);
    fixtures.push(result.data);
  }
  return fixtures;
}

function invalidFixture(index: number, message: string): WitshiftError {
  return new WitshiftError(
    'INVALID_FIXTURES',
    `Invalid fixture at line ${index + 1}: ${truncate(message)}`,
    ExitCode.invalidArguments,
    { line: index + 1 },
  );
}

async function loadExecutionPort(
  loaded: LoadedConfig,
  relativePath: string,
  role: 'original' | 'component',
): Promise<ExecutionPort> {
  const unresolvedModulePath = resolve(loaded.projectRoot, relativePath);
  let modulePath: string;
  let realRoot: string;
  try {
    [modulePath, realRoot] = await Promise.all([
      realpath(unresolvedModulePath),
      realpath(loaded.projectRoot),
    ]);
  } catch (error) {
    throw new WitshiftError(
      'ADAPTER_LOAD_FAILED',
      `Cannot resolve ${role} adapter ${relativePath}`,
      ExitCode.invalidConfiguration,
      { role, path: relativePath },
      { cause: error },
    );
  }
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (!modulePath.startsWith(prefix)) {
    throw new WitshiftError(
      'ADAPTER_OUTSIDE_PROJECT',
      `${role} adapter resolves outside the project`,
      ExitCode.invalidConfiguration,
    );
  }
  let namespace: unknown;
  try {
    namespace = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    throw new WitshiftError(
      'ADAPTER_LOAD_FAILED',
      `Cannot load ${role} adapter ${relativePath}`,
      ExitCode.invalidConfiguration,
      { role, path: relativePath },
      { cause: error },
    );
  }
  if (!isRecord(namespace) || typeof namespace['createAdapter'] !== 'function') {
    throw new WitshiftError(
      'INVALID_ADAPTER',
      `${role} adapter must export createAdapter(context)`,
      ExitCode.invalidConfiguration,
      { role, path: relativePath },
    );
  }
  const createAdapter = namespace['createAdapter'] as (context: { projectRoot: string }) => unknown;
  const candidate: unknown = await createAdapter({ projectRoot: loaded.projectRoot });
  if (!isExecutionPort(candidate)) {
    throw new WitshiftError(
      'INVALID_ADAPTER',
      `${role} adapter returned an invalid execution port`,
      ExitCode.invalidConfiguration,
      { role, path: relativePath },
    );
  }
  const port: ExecutionPort = {
    id: candidate.id,
    evidenceLevel: candidate.evidenceLevel,
    invoke: candidate.invoke.bind(candidate),
  };
  return candidate.probePolicy
    ? { ...port, probePolicy: candidate.probePolicy.bind(candidate) }
    : port;
}

async function invokeBounded(
  port: ExecutionPort,
  tool: string,
  input: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const invocation = port.invoke(tool, deepFreeze(structuredClone(input)), {
    signal: controller.signal,
  });
  return withTimeout(invocation, controller, timeoutMs, `${port.id} invocation`);
}

async function policyProbeBounded(
  port: ExecutionPort,
  request: PolicyProbeRequest,
  timeoutMs: number,
): Promise<PolicyDenyEvidence | undefined> {
  if (!port.probePolicy) return undefined;
  const controller = new AbortController();
  const probe = port.probePolicy(request, { signal: controller.signal });
  return withTimeout(probe, controller, timeoutMs, `${port.id} policy probe`);
}

async function withTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`${label} exceeded ${timeoutMs}ms`));
      reject(new Error(`${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function evaluateGeneratedPolicy(
  config: WitshiftConfig,
  request: PolicyProbeRequest,
): PolicyDenyEvidence | undefined {
  const allowed =
    request.capability === 'network'
      ? networkAllowed(config.policy.network.allow, request.target)
      : storageAllowed(
          request.capability === 'filesystem-read'
            ? config.policy.storage.read
            : config.policy.storage.write,
          request.target,
        );
  return allowed
    ? undefined
    : {
        decision: 'deny',
        capability: request.capability,
        target: request.target,
        reason: 'Target is absent from the generated allow list',
        source: 'generated-policy-evaluator',
        runtimeEnforced: false,
      };
}

function networkAllowed(allow: readonly string[], target: string): boolean {
  let hostname: string;
  try {
    hostname = target.includes('://') ? new URL(target).hostname : target;
  } catch {
    return false;
  }
  const normalized = hostname.toLowerCase().replace(/\.$/u, '');
  if (!/^[a-z0-9.-]+$/u.test(normalized)) return false;
  return allow.some((entry) => {
    const candidate = entry.toLowerCase().replace(/\.$/u, '');
    return candidate.startsWith('*.')
      ? normalized.endsWith(candidate.slice(1)) && normalized !== candidate.slice(2)
      : normalized === candidate;
  });
}

function storageAllowed(allow: readonly string[], target: string): boolean {
  if (isAbsolute(target) || /^[a-z]:[\\/]/iu.test(target)) return false;
  const normalized = posix.normalize(target.replaceAll('\\', '/'));
  if (normalized === '..' || normalized.startsWith('../')) return false;
  return allow.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

function validateOutput(validator: ValidateFunction | undefined, result: unknown): boolean {
  return validator ? validator(extractStructuredContent(result)) : true;
}

function extractStructuredContent(result: unknown): unknown {
  return isRecord(result) && 'structuredContent' in result ? result['structuredContent'] : result;
}

function mismatchMessage(
  resultEqual: boolean,
  schemaEqual: boolean,
  expectedEqual: boolean,
  outputValidator: ValidateFunction | undefined,
): string {
  const reasons = [];
  if (!resultEqual) reasons.push('original and component results differ');
  if (!schemaEqual)
    reasons.push(`output schema validation failed: ${formatAjvErrors(outputValidator)}`);
  if (!expectedEqual) reasons.push('results differ from fixture expectation');
  return reasons.join('; ');
}

function formatAjvErrors(validator: ValidateFunction | undefined): string {
  if (!validator?.errors) return 'no details';
  return truncate(
    validator.errors
      .map((error) => `${error.instancePath || '/'} ${error.message ?? 'invalid'}`)
      .join(', '),
  );
}

function resultBase(
  fixture: VerificationCase,
  status: 'mismatch' | 'error',
  schemaEqual: boolean,
  resultEqual: boolean,
  message: string,
): VerificationCaseResult {
  return {
    id: fixture.id,
    tool: fixture.tool,
    status,
    schemaEqual,
    resultEqual,
    message,
  };
}

function assertJsonValue(value: unknown, label: string): void {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): void => {
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry))
    ) {
      return;
    }
    if (typeof entry !== 'object') throw new Error(`${label} is not a JSON value`);
    if (seen.has(entry)) throw new Error(`${label} contains a cycle`);
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    const prototype = Object.getPrototypeOf(entry) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} contains a non-JSON object`);
    }
    if (Reflect.ownKeys(entry).some((key) => typeof key === 'symbol')) {
      throw new Error(`${label} contains a symbol key`);
    }
    for (const item of Object.values(entry)) visit(item);
  };
  try {
    visit(value);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
    throw new Error(`${label} is not a JSON value`, { cause: error });
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

function verifyMarkdown(report: VerifyReport): string {
  const rows = report.cases.map(
    (item) =>
      `| \`${item.id}\` | \`${item.tool}\` | ${item.status} | ${item.schemaEqual ? 'yes' : 'no'} | ${item.resultEqual ? 'yes' : 'no'} |`,
  );
  return `# WITShift verification report

- Project: \`${report.project}\`
- Passed: **${report.passed ? 'yes' : 'no'}**
- Evidence level: **${report.evidenceLevel}**
- Cases: ${report.summary.total}; mismatches: ${report.summary.mismatched}; errors: ${report.summary.errors}; policy denials: ${report.summary.denied}

| Case | Tool | Status | Schema | Result |
| --- | --- | --- | --- | --- |
${rows.join('\n')}

Policy evidence with runtimeEnforced set to false proves only the generated policy evaluator, not a runtime sandbox denial.
`;
}

function isExecutionPort(value: unknown): value is ExecutionPort {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    (value['evidenceLevel'] === 'test-only' ||
      value['evidenceLevel'] === 'component-runtime' ||
      value['evidenceLevel'] === 'wassette-runtime') &&
    typeof value['invoke'] === 'function' &&
    (value['probePolicy'] === undefined || typeof value['probePolicy'] === 'function')
  );
}

function isPolicyDenyEvidence(value: unknown): value is PolicyDenyEvidence {
  return (
    isRecord(value) &&
    value['decision'] === 'deny' &&
    (value['capability'] === 'network' ||
      value['capability'] === 'filesystem-read' ||
      value['capability'] === 'filesystem-write') &&
    typeof value['target'] === 'string' &&
    typeof value['reason'] === 'string' &&
    value['reason'].length > 0 &&
    typeof value['source'] === 'string' &&
    value['source'].length > 0 &&
    typeof value['runtimeEnforced'] === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncate(value: string): string {
  return value.length <= 1_000 ? value : `${value.slice(0, 997)}...`;
}
