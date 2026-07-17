# WITShift

WITShift is an alpha CLI and conformance lab for moving a deliberately restricted subset of static
TypeScript MCP v1 stdio tools toward WebAssembly Components and Wassette.

It does not implement a sandbox. It reuses Bytecode Alliance jco/ComponentizeJS for compilation and
treats Wassette as the runtime boundary. Unsupported or ambiguous source stops with a typed error;
the CLI never writes placeholder component bytes.

## Status

The first vertical slice is under active construction. See [the delivery contract](docs/delivery-contract.md)
and [the build-vs-buy ADR](docs/adr/0001-build-vs-buy.md).

## Planned command surface

```text
witshift doctor [project]
witshift inspect <project>
witshift build <project> --out <dir>
witshift verify <project> --fixtures <jsonl>
```

Every command supports `--json`. Success JSON is a command-specific report. Errors use
`{"ok":false,"error":{"code":"...","message":"...","details":{...}}}` and never expose source
secrets.

## License

Apache-2.0. See [LICENSE](LICENSE).
