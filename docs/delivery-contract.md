# WITShift delivery contract

## Objective

Deliver a fail-closed CLI and conformance lab that migrates a deliberately restricted, statically
provable subset of TypeScript MCP v1 stdio tool servers into WebAssembly Components loadable by
capability runtimes such as Wassette.

## Scope

Must:

- inventory literal `registerTool` registrations and statically representable schemas;
- reject ambiguous code, dangerous host APIs, and unsupported handlers before generation;
- invoke pinned Bytecode Alliance tooling and never substitute placeholder bytes;
- emit WIT, component source, least-privilege policy, digests, and reports;
- compare replaceable original/component execution ports and retain policy-denial evidence;
- distinguish deterministic test evidence from component-runtime and Wassette-runtime proof.

Out of scope for the alpha:

- general TypeScript-to-component compilation;
- dynamic tool registration, resources, prompts, streaming, elicitation, or tasks;
- implementing a sandbox or claiming Wassette runtime equivalence from an in-process adapter;
- automatically translating arbitrary Node.js filesystem or network clients to WASI interfaces.

## Acceptance threshold

Release only when all deterministic inspect/build/verify gates pass, forbidden constructs fail
closed, package consumption works on Node 24, CI covers Node 24 on three operating systems and
Node 26 on Linux, dependency audit has no known production vulnerability, and docs explicitly
mark any unverified Wassette runtime-enforcement gate.

## Architecture

- Domain contracts: inventory, migration manifest, artifact digests, fixture results, exit codes.
- Application services: inspect, build, verify.
- Adapters: ts-morph analyzer, official jco/ComponentizeJS subprocess, execution ports, report sinks.
- Configuration: one validated `witshift.config.json`; policy and adapters are data, not branches.

## Risks and decisions

| Risk                                                          | Handling                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Arbitrary JavaScript cannot be proven safe or componentizable | Accept only a documented AST subset and fail closed                            |
| Toolchain output may vary by version/platform                 | Pin versions, hash inputs and outputs, report repeat-build evidence honestly   |
| Policy generation may be confused with enforcement            | Treat policy as an artifact; only a runtime denial counts as runtime proof     |
| Wassette is evolving                                          | Pin the opt-in smoke and isolate future denial probes behind an execution port |
