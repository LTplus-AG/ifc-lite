---
"@ifc-lite/wasm": major
"@ifc-lite/diff": patch
---

Add public Rust/WASM bindings for live value normalization, identity-map derivation, lineage assembly, and sidecar creation, validation, serialization, and inspection. Preserve JavaScript observation order and arbitrary UTF-16 code units in lineage inputs. Prepare internal diff projections and iterable adapters without changing the public diff entry points in this layer. Add the raw `diffCheckFingerprintCollections` export, which the diff facade calls after projecting a sparse fingerprint collection so host string-length errors surface where the TypeScript oracle raises them (#8114).

Breaking: the generated raw `InitOutput.diffRekeyByLineage` export changed from seven numeric ABI parameters to six, and `initSync` exposes that export. Consumers that call the raw `InitOutput` entry directly must be recompiled against the new signature; the wrapped `diffRekeyByLineage(keys, value, deleted, policy)` function keeps its signature.
