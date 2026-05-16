---
"@ifc-lite/extensions": minor
---

Phase 1 — extension activation runtime (security layer).

Three new host-side modules:

- **`host/permissions.ts`** — `capabilitiesToPermissions(grants)`
  derives the existing `@ifc-lite/sandbox` permission flags from a
  fine-grained capability set. This is the **outer ring**: a
  whole-namespace gate the sandbox enforces.
- **`host/runtime.ts`** — `ExtensionRuntime` manages a sandbox per
  active extension. Uses a pluggable `RuntimeSandboxFactory` so the
  viewer can wire `@ifc-lite/sandbox` in while tests / CLI use stubs.
  Idempotent activate / deactivate / disposeAll.
- **`host/check.ts`** — `checkMethodCall` / `assertMethodCall` /
  `CapabilityDeniedError`. The **inner ring**: per-`bim.<ns>.<method>`
  capability check used by the future bridge wrapper. Defence in depth
  — even if the sandbox flag would allow the call, the method-level
  check refuses it without an explicit capability grant.

The runtime does **not** yet invoke `entry.activate(ctx)` — that
requires settling a cross-realm `ctx` calling convention for QuickJS
(the existing sandbox uses globals, not parameter passing). That
design lands with the viewer-side UI wiring. The runtime exposes the
sandbox handle so the host can drive script evaluation when ready.

Test count: 269 (up from 231 / +38). Coverage includes every
capability scope's permission derivation, the activation lifecycle,
idempotence, factory error propagation, and the inner-ring method
check for both pass and deny paths.
