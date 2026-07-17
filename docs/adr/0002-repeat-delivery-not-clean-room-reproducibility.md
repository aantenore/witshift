# ADR 0002: separate repeat delivery from clean-room reproducibility

- Status: accepted
- Date: 2026-07-17

## Context

Two independent ComponentizeJS 0.21.0 runs with identical generated source, WIT, Node version, and
configuration produced different component hashes. Repeating with AOT options and a deterministic
JavaScript random source did not remove the variation. Claiming deterministic componentization would
therefore be false.

## Decision

WITShift records independent comparison results in the migration manifest. With caching enabled, it
derives a cache key from every controlled input, admits one component and its observation, and verifies
the digest on every reuse. `--no-cache` exposes direct upstream bytes.

The manifest uses different terms:

- `componentDigestStable`: result of an independent byte comparison;
- `deliveryMode: content-addressed-cache`: stable reuse of an admitted artifact;
- `canonicalSerialization`: deterministic ordering and serialization, not deterministic values;
- manifest note: explicitly states that cached repeat delivery is not a clean-room reproducibility
  claim.

## Consequences

- Consumers can distinguish upstream determinism from local artifact reuse.
- Cache integrity failures stop the build.
- A first build is more expensive because it compares two componentizations by default.
- Cross-host reproducibility remains an open upstream-dependent property.
