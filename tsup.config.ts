import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    splitting: false,
    treeshake: true,
  },
  {
    entry: ['src/bin.ts'],
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
