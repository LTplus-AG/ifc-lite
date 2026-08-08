---
'@ifc-lite/sandbox': minor
---

Give `bim.clash` a real declared type surface, and stop the generated `bim` declarations from needing a hand-maintained copy of another package's types.

Every `bim.clash` method was declared `Promise<unknown>` / `unknown[]` while the runtime returned a fully structured `ClashResult`. Sandbox scripts could not read `result.clashes` or `result.summary.total` off the declared type without a cast, even though both demonstrably exist — a declaration that lied by omission. `run` and `matrix` are now `Promise<BimClash.ClashResult>`, `group` takes a `BimClash.ClashResult` and returns `BimClash.ClashGroup[]`, `disciplineRules` returns `BimClash.ClashRule[]`, and `presets` returns `BimClash.ClashRulePreset[]` (a preset is the discipline *pair*, not a runnable rule). Narrowing `unknown` breaks nothing: nothing useful could be done with the old type, and `group` already rejected any argument without a `clashes` array.

Those `BimClash.*` declarations are **extracted** from `packages/clash/src` by `scripts/generate-bim-globals.mjs` rather than transcribed into it, so `pnpm check:bim-globals` goes red when the engine's types change, and a type the surface reaches but the generator cannot resolve is a hard error instead of a silent omission.

Also adds `SANDBOX_CONSOLE_LEVELS` and the `SandboxConsoleLevel` type as the single source for the console the sandbox installs, the `level` a `LogEntry` carries, and the generated ambient `console` declaration.
