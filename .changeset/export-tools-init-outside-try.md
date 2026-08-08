---
"@ifc-lite/mcp": patch
---

Move `await gp.init()` inside the `try` in `export_glb`, `export_obj`, `export_ifcx`, and `export_usd`, so an `init()` rejection reaches `dispose()` instead of skipping it.

All four handlers in `packages/mcp/src/tools/export.ts` called `await gp.init()` before the `try { ... } finally { gp.dispose(); }` block, so an `init()` rejection bypassed `dispose()` entirely. `packages/mcp/src/tools/clash.ts` already used the correct shape; all four export tools now match it.

Scope, stated precisely: this makes the cleanup path *reachable*, which is the shape the codebase already standardises on, but on today's code the recovered `dispose()` is a no-op. `IfcLiteBridge.init()` catches its own failures and calls `reset()`, which nulls `ifcApi` without calling `free()` (`packages/geometry/src/ifc-lite-bridge.ts:229`), and `dispose()` is optional-chained on that now-null handle. So a WASM handle allocated before a late `init()` throw is still not freed after this change — the leak lives one layer down, in the bridge's own error path, and is tracked separately. This change is correct and defensive, but it should not be read as closing that leak.
