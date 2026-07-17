import { Command } from 'commander';
import packageJson from '../package.json' with { type: 'json' };

export function createProgram(): Command {
  return new Command()
    .name('witshift')
    .description('Migrate a restricted static TypeScript MCP tool subset to WebAssembly Components')
    .version(packageJson.version)
    .option('--json', 'emit stable machine-readable output');
}

const program = createProgram();
await program.parseAsync(process.argv);
