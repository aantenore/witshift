# Filesystem boundary sample

This is a deliberate negative fixture. WITShift inventories the filesystem capability but refuses to
translate the handler because it contains runtime calls that cannot be proven equivalent or safely
mapped to WASI in the alpha subset.

```bash
witshift inspect .
```

The command writes evidence and exits with code 4. This sample prevents an unsupported Node.js API
from being presented as a successful migration.
