import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectProject } from '../src/inspect.js';
import { verifyProject } from '../src/verify.js';

const repositoryRoot = resolve(import.meta.dirname, '..');

describe('shipped samples', () => {
  it('keeps the weather sample inside the supported subset with passing fixtures', async () => {
    const project = resolve(repositoryRoot, 'samples', 'weather');

    const inspection = await inspectProject(project);
    const verification = await verifyProject(project, resolve(project, 'fixtures', 'verify.jsonl'));

    expect(inspection.supported).toBe(true);
    expect(inspection.tools.map((tool) => tool.name)).toEqual(['get_forecast']);
    expect(verification.report.passed).toBe(true);
    expect(verification.report.summary).toMatchObject({ passed: 1, denied: 2 });
    expect(verification.report.evidenceLevel).toBe('test-only');
  });

  it('keeps direct Node.js filesystem access outside the supported subset', async () => {
    const inspection = await inspectProject(resolve(repositoryRoot, 'samples', 'filesystem'));

    expect(inspection.supported).toBe(false);
    expect(inspection.capabilities).toContain('filesystem-read');
    expect(inspection.unsupported.map((item) => item.code)).toContain('UNSUPPORTED_HANDLER_CALL');
  });
});
