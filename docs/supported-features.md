# Supported feature matrix

The matrix is a contract for `0.1.0-alpha.1`, not a roadmap promise. “Reject” means inspection emits
typed evidence and exits 4 before componentization.

## Source subset

| Construct                                            | Inspect | Build | Notes                                                  |
| ---------------------------------------------------- | :-----: | :---: | ------------------------------------------------------ |
| Literal `registerTool` name                          |   yes   |  yes  | Duplicate or computed names reject                     |
| Inline literal description                           |   yes   |  yes  | Computed descriptions reject                           |
| Inline Zod object shape                              |   yes   |  yes  | String, number, integer, boolean, array, enum, literal |
| Inline literal JSON Schema                           |   yes   |  yes  | No remote references or runtime schema builders        |
| One synchronous inline handler                       |   yes   |  yes  | Expression/object transformation subset only           |
| Handler call or constructor                          | reject  |  no   | Requires a future explicit capability adapter          |
| External handler binding                             | reject  |  no   | Prevents closed extraction                             |
| Async handler, `await`, or generator                 | reject  |  no   | Outside the alpha execution model                      |
| Dynamic import, CommonJS runtime resolution, or eval | reject  |  no   | Static dependency graph required                       |
| Child process or native addon                        | reject  |  no   | Host execution is not migrated                         |
| Resources, prompts, streaming, elicitation, tasks    | reject  |  no   | Not represented in the alpha WIT world                 |

## Capability handling

| Capability                         | Inventory | Candidate policy | Automatic translation | Runtime proof |
| ---------------------------------- | :-------: | :--------------: | :-------------------: | :-----------: |
| No host capability                 |    yes    |   deny default   |          yes          | component CI  |
| Node.js filesystem import          |  coarse   | allow-list data  |          no           |      no       |
| Node.js HTTP/fetch-style import    |  coarse   | allow-list data  |          no           |      no       |
| Wassette filesystem/network denial |    n/a    |    generated     |          n/a          |   open gate   |

Import-based capability inference is deliberately conservative and may report both read and write
for a generic filesystem module. It is not a data-flow proof.

## Artifact and verification matrix

| Artifact or gate                  | Current status | Evidence                                                     |
| --------------------------------- | -------------- | ------------------------------------------------------------ |
| WIT world                         | implemented    | Generated per tool with deterministic name normalization     |
| WebAssembly Component             | implemented    | Header validated; real component runtime smoke in CI         |
| Least-privilege candidate policy  | implemented    | Deny by default; explicit network/storage allow lists        |
| Input/config/lock/artifact hashes | implemented    | Canonical migration manifest                                 |
| Independent byte comparison       | implemented    | Result can be stable or unstable; never coerced              |
| Stable repeat delivery            | implemented    | Integrity-checked content-addressed cache                    |
| Differential adapters             | implemented    | Bounded JSONL cases, schema validation, canonical comparison |
| Generated-policy denial evaluator | implemented    | Always labelled `runtimeEnforced: false`                     |
| jco component execution           | implemented    | `pnpm component:smoke`                                       |
| Wassette component load/invoke    | not verified   | Promotion gate in `docs/wassette-gate.md`                    |
| Wassette runtime policy denial    | not verified   | `wassette-runtime` label withheld                            |
