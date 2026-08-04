---
"@ifc-lite/sandbox": patch
---

Make the swallowed failures in the sandbox's transpile and console paths report their cause.

`getEsbuild()` swallowed both the `esbuild.wasm?url` asset resolution and the `esbuild.initialize()` call. The first silently swaps a bundled asset for a `unpkg.com` network fetch — a change of behaviour a host embedding the sandbox has no other way to notice — and the second is the only place that still holds the reason esbuild is unavailable, which the caller's existing "using fallback transpiler" warning does not carry. Both now `console.warn` with the error; the fallback still happens exactly as before. The outer `transpileTypeScript` catch now passes its error to the warning it was already emitting.

The bridge's per-entry log sizing (`JSON.stringify` against the host memory budget) swallowed serialization failures. A `BigInt` argument reaches it — `console.log(1n)` survives `vm.dump` but not `JSON.stringify` — and the entry was then silently charged zero bytes. It now warns, but at most once per sandbox context: the trigger is script-supplied, so a per-entry warning would let `for(;;) console.log(1n)` flood the host console. The entry is still captured and still charged zero, so the log output itself is unchanged. Covered by `bridge-console.test.ts`.

No control flow changed at any of these sites — every fallback still falls back and every swallow still swallows, it just says so.
