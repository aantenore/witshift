# ADR 0001: orchestrate official component tooling

- Status: accepted
- Date: 2026-07-17

## Context

Bytecode Alliance jco and ComponentizeJS already compile JavaScript implementations into WebAssembly
Components. Microsoft Wassette already owns runtime isolation, permissions, component loading, and
MCP exposure. Reimplementing either would increase security and maintenance risk.

## Decision

WITShift owns only the migration-specific workflow: static MCP inventory, supported-subset checks,
WIT and source normalization, policy suggestion, provenance manifests, and differential verification.
It invokes pinned jco/ComponentizeJS for componentization and exposes replaceable execution ports for
component or Wassette verification.

## Consequences

- Positive: the product differentiates on migration evidence rather than another runtime.
- Positive: toolchain upgrades are explicit adapter/config changes.
- Negative: ComponentizeJS availability and upstream behavior are release gates.
- Negative: generated policy is not proof of enforcement; runtime evidence remains separately labelled.

## Alternatives rejected

- Bespoke sandbox: duplicates Wasmtime/Wassette and creates an unsafe security claim.
- Source-to-source MCP wrapper only: does not create a real component artifact.
- Full TypeScript compiler: too broad to fail closed in an alpha migration tool.
