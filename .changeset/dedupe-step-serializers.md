---
"@ifc-lite/data": minor
"@ifc-lite/parser": patch
"@ifc-lite/codegen": patch
---

De-duplicate the STEP serializer into a single source of truth. The
schema-agnostic STEP serialization logic (`serializeValue`, `generateHeader`,
`parseStepValue`, `ref`/`enumVal`/`isEntityRef`/`isEnumValue`, and the
registry-injected `toStepLineWithRegistry` / `generateStepFileWithRegistry`)
previously existed as four hand-synced copies — the codegen template plus three
generated `serializers.ts` files — which had already silently drifted (the
runtime copy carried a `?? []` hardening the template lacked). It now lives once
in `@ifc-lite/data`; the per-schema bundles (parser runtime + codegen outputs)
are thin re-exports that only bind their own `SCHEMA_REGISTRY` to the
registry-coupled helpers, so the copies can never diverge again. A codegen test
asserts the generated bundle stays a thin re-export rather than re-inlining
logic.

Also fixes the broken `generate:ifc4` script (it pointed at a non-existent
`schemas/IFC4.exp`; the real file is `schemas/IFC4_ADD2_TC1.exp`). No public
behaviour change: `@ifc-lite/parser` re-exports the same serializer symbols as
before; `@ifc-lite/data` gains the shared primitives; `@ifc-lite/codegen` now
declares `@ifc-lite/data` as a dependency since the generated bundle imports it.
