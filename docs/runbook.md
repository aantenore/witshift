# Operator runbook

## Prerequisites

- Node.js 24 or newer;
- Corepack and pnpm 11.13.0;
- supported jco/ComponentizeJS host architecture for real builds;
- no credentials in source fixtures or output directories.

## Repository setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm audit --prod
```

## Secure toolchain setup

The packed core declares jco 1.25.2 and ComponentizeJS 0.21.0 as exact optional peers. This avoids
silently installing the abandoned `decompress` package present below the official toolchain. A host
that enables build commands must install the peers and replace that one extractor with
`@xhmikosr/decompress` 11.1.3 or newer.

For pnpm, add this root setting to `pnpm-workspace.yaml`:

```yaml
overrides:
  decompress: npm:@xhmikosr/decompress@11.1.3
```

Then install exact toolchain peers:

```bash
pnpm add -D @bytecodealliance/jco@1.25.2 @bytecodealliance/componentize-js@0.21.0
pnpm audit --prod
witshift doctor .
```

The override follows the patched fork recommended by
[GitHub advisory GHSA-mp2f-45pm-3cg9](https://github.com/advisories/GHSA-mp2f-45pm-3cg9).
Do not suppress this advisory without an equivalent containment fix.

## Project configuration

Create `witshift.config.json` at the project root. All paths are project-relative and parent traversal
is rejected.

```json
{
  "$schema": "./node_modules/witshift/schemas/witshift.config.schema.json",
  "version": 1,
  "entry": "src/server.ts",
  "build": {
    "package": "example:weather",
    "world": "mcp-tools",
    "timeoutMs": 180000
  },
  "policy": {
    "network": { "allow": [] },
    "storage": { "read": [], "write": [] }
  },
  "verification": {
    "originalAdapter": "verify/original.mjs",
    "componentAdapter": "verify/component.mjs",
    "evidenceLevel": "test-only",
    "timeoutMs": 30000
  }
}
```

## Normal operation

```bash
witshift doctor .
witshift inspect .
witshift build . --out .witshift/build
witshift verify . --fixtures fixtures/verify.jsonl
```

Reports default to `.witshift/reports`; builds and the component cache also remain below `.witshift`.
Keep that directory out of version control and protect it if fixtures contain sensitive values.

## Fixture contract

Each non-empty line is one bounded JSON object. IDs must be unique.

```json
{"id":"rome","tool":"forecast","input":{"city":"Rome"},"expect":{"structuredContent":{"forecast":"Sunny in Rome"}}}
{"id":"deny-net","tool":"forecast","input":{},"expectPolicyDeny":{"capability":"network","target":"blocked.example"}}
```

Expected values compare the entire adapter result. Output schema validation applies to
`structuredContent` when present, otherwise to the whole result.

## Adapter contract

Each configured ESM module exports `createAdapter({ projectRoot })` and returns:

```js
{
  id: 'unique-adapter-id',
  evidenceLevel: 'test-only',
  async invoke(tool, input, { signal }) {
    return { structuredContent: { value: input.value } };
  },
  async probePolicy(request, { signal }) {
    return undefined;
  }
}
```

`probePolicy` returns `undefined` for allowed access or a denial object bound to the requested
capability/target. Set `runtimeEnforced: true` only when the runtime itself rejected the operation and
the evidence source identifies that runtime.

## Cache operation

The cache key binds inspected source, parsed config, lockfile, generated WIT/source/policy, Node, and
toolchain versions. A digest mismatch is a hard failure. Delete `.witshift/cache/components` to force
fresh admission; this is safe but loses stable repeat delivery. Use `--no-cache` when studying direct
upstream nondeterminism.

## Troubleshooting

| Symptom or code                   | Action                                                                    |
| --------------------------------- | ------------------------------------------------------------------------- |
| `TOOLCHAIN_UNAVAILABLE`           | Install exact peers using the secure setup and rerun `doctor`             |
| Exit 4 / unsupported report       | Read every fatal construct; redesign rather than bypassing the gate       |
| `INVALID_COMPONENT_ARTIFACT`      | Confirm official versions and remove only the affected build output       |
| `CACHE_INTEGRITY_FAILURE`         | Quarantine the cache, rebuild directly, inspect host write access         |
| Exit 6 / verification mismatch    | Compare captured original/component values and output schema errors       |
| Policy case is `test-only`        | Supply a real runtime `probePolicy` adapter before claiming isolation     |
| Independent component hashes vary | Expected upstream behavior; inspect manifest note and cache delivery mode |

## Release gate

```bash
pnpm release:check
```

This runs formatting, linting, strict types, 22+ tests, bundling, production audit, publint, packed
type analysis, isolated consumer installation, and a real component runtime smoke. A tag additionally
requires green CI and a documented Wassette gate status.
