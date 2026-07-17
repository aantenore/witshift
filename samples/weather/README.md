# Weather sample

This MCP v1 stdio server intentionally keeps one handler inside WITShift's statically provable alpha
subset. The forecast is deterministic so inspect, component generation, and differential fixtures do
not depend on a live service.

```bash
witshift inspect .
witshift build . --out .witshift/build
witshift verify . --fixtures fixtures/verify.jsonl
```

Its generated policy grants no network or filesystem capability.

The included adapters are deterministic contract doubles and therefore emit `test-only` evidence.
They do not claim that Wassette enforced a denial. The repository runtime smoke gate separately
executes the generated component through jco's component-model transpilation path.
