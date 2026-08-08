---
'@ifc-lite/sandbox': minor
---

Give `bim.clash` a real declared type surface, and stop the generated `bim` declarations from needing a hand-maintained copy of another package's types.

Every `bim.clash` method was declared `Promise<unknown>` / `unknown[]` while the runtime returned a fully structured `ClashResult`. Sandbox scripts could not read `result.clashes` or `result.summary.total` off the declared type without a cast, even though both demonstrably exist — a declaration that lied by omission. `run` and `matrix` are now `Promise<BimClash.ClashResult>`, `group` takes `Pick<BimClash.ClashResult, "clashes"> & Partial<BimClash.ClashResult>` — exactly what the runtime accepts, since the guard requires only a `clashes` array — and returns `BimClash.ClashGroup[]`, `disciplineRules` returns `BimClash.ClashRule[]`, and `presets` returns `BimClash.ClashRulePreset[]` (a preset is the discipline *pair*, not a runnable rule). Narrowing `unknown` breaks nothing: nothing useful could be done with the old type, and `group` already rejected any argument without a `clashes` array.

Those `BimClash.*` declarations are **extracted** from `packages/clash/src` by `scripts/generate-bim-globals.mjs` rather than transcribed into it, so `pnpm check:bim-globals` goes red when the engine's types change, and a type the surface reaches but the generator cannot resolve is a hard error instead of a silent omission.

Also adds `SANDBOX_CONSOLE_LEVELS` and the `SandboxConsoleLevel` type as the single source for the console the sandbox installs, the `level` a `LogEntry` carries, and the generated ambient `console` declaration.

**Why minor and not major** (raised in review on #2437, for `bim.clash.group`). The narrowed signatures are `tsReturn` / `tsParamTypes` **string values** inside `NAMESPACE_SCHEMAS`, read by a code generator. They are not TypeScript types in this package, and they materialise only in `apps/viewer/.../bim-globals.d.ts` — an unpublished app file of ambient declarations for user-authored sandbox scripts. `MethodSchema` still declares `tsReturn?: string` and `tsParamTypes?: (string | undefined)[]`, unchanged.

So the published delta for a package consumer is: two additive exports, plus `LogEntry.level` restated as `SandboxConsoleLevel` — which resolves to `'log' | 'warn' | 'error' | 'info'`, the identical union, mutually assignable with what it replaced. Nothing is removed or renamed, which is what the house rule ties `major` to at >=1.0 (this package is 2.0.1).

On the specific claim: `group` was `unknown[]` before this change, so its return goes `unknown[]` -> `ClashGroup[]`. That is a **narrowing of a return type** — covariant, so existing code holding the result as `unknown[]` still compiles. The genuinely breaking direction is the *parameter* (`unknown` -> `ClashResult`, contravariant), and that one is confined to the generated script-facing `.d.ts` described above; no built-in template calls `bim.clash`, and nothing types a function against these signatures.
