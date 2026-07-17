import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { InspectReport, MigrationManifest, VerifyReport } from './contracts.js';
import { canonicalJson } from './hash.js';

export async function writeReportPair(
  directory: string,
  basename: string,
  report: InspectReport | VerifyReport | MigrationManifest,
  markdown: string,
): Promise<{ json: string; markdown: string }> {
  const outputDirectory = resolve(directory);
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = resolve(outputDirectory, `${basename}.json`);
  const markdownPath = resolve(outputDirectory, `${basename}.md`);
  await Promise.all([
    writeFile(jsonPath, `${canonicalJson(report)}\n`, 'utf8'),
    writeFile(markdownPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`, 'utf8'),
  ]);
  return { json: jsonPath, markdown: markdownPath };
}

export function inspectMarkdown(report: InspectReport): string {
  const lines = [
    '# WITShift inspection',
    '',
    `- Project: \`${report.project}\``,
    `- Entry: \`${report.entry}\``,
    `- Supported: **${report.supported ? 'yes' : 'no'}**`,
    `- Input digest: \`${report.inputDigest}\``,
    '',
    '## Tools',
    '',
  ];
  if (report.tools.length === 0) lines.push('No supported static tools found.', '');
  for (const tool of report.tools) {
    lines.push(
      `### \`${tool.name}\``,
      '',
      tool.description || '_No description._',
      '',
      `Capabilities: ${tool.capabilities.length === 0 ? 'none' : tool.capabilities.join(', ')}`,
      '',
      '```json',
      JSON.stringify(tool.inputSchema, null, 2),
      '```',
      '',
    );
  }
  lines.push('## Unsupported constructs', '');
  if (report.unsupported.length === 0) lines.push('None.', '');
  for (const item of report.unsupported) {
    lines.push(`- **${item.code}** at \`${item.file}:${item.line}\`: ${item.message}`);
  }
  return lines.join('\n');
}
