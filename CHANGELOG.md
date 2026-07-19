# Changelog

All notable changes are documented here. WITShift follows semantic versioning while alpha APIs may
change with explicit release notes.

## Unreleased

### Changed

- emit each migrated tool as a direct WIT world export so capability runtimes can discover and
  invoke it without a product-specific nested-interface bridge;
- add an opt-in, version-pinned Wassette MCP load/discovery/invocation smoke with artifact hashes.

## 0.1.0-alpha.1 - 2026-07-17

### Added

- fail-closed static inspection for literal MCP v1 tool registrations and schema subset;
- real WebAssembly Component build through pinned jco and ComponentizeJS;
- WIT, generated source, least-privilege candidate policy, manifest, digests, and reports;
- integrity-checked content-addressed repeat delivery with honest upstream comparison evidence;
- bounded differential JSONL verification with replaceable execution and policy ports;
- stable CLI JSON errors and exit codes;
- positive weather and negative filesystem samples;
- Node 24 cross-platform and Node 26 Linux CI matrix;
- production audit, packed consumer, publint, type-surface, and real component runtime gates.

### Known alpha limits

- Wassette load, MCP exposure, and runtime-denial evidence remain an explicit open gate;
- handler calls, async handlers, arbitrary host APIs, and non-tool MCP features reject;
- independent upstream componentization can produce different bytes.
