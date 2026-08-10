# @ifc-lite/sandbox

QuickJS-in-WASM sandboxed script execution for ifc-lite. Runs user or LLM-generated scripts in a secure, isolated interpreter with only the `bim.*` API exposed: no DOM, no fetch, no network access. Permissions and resource limits (timeout, memory) are configurable per sandbox, and TypeScript input is transpiled on the fly.

## Install

```bash
npm install @ifc-lite/sandbox
```

## Usage

```ts
import { createSandbox } from '@ifc-lite/sandbox';
import { createBimContext } from '@ifc-lite/sdk';

const bim = createBimContext({ backend: myBackend });
const sandbox = await createSandbox(bim, {
  permissions: { mutate: true },
  limits: { timeoutMs: 10_000 },
});

const result = await sandbox.eval(`
  const walls = bim.query.byType('IfcWall');
  console.log('Found', walls.length, 'walls');
  walls.length;
`);

console.log(result.value); // number of walls
console.log(result.logs);  // captured console output

sandbox.dispose();
```

## Recovering from a teardown abort

A script that exhausts the memory limit inside a *drained promise job* — the post-`await` body of an `async function run()` that nothing awaits — trips an upstream assertion in `JS_FreeRuntime`, so `dispose()` comes back as an emscripten abort ([#1922](https://github.com/LTplus-AG/ifc-lite/issues/1922)). Two consequences a consumer has to handle:

**`dispose()` can throw, and that throw is the run's verdict.** It rejects with `SandboxAbortError`. The `eval()` that caused it already resolved normally — the reproducer returns `"started"` — so teardown is the *only* place the failure is observable. Treat a throwing `dispose()` as that run having failed, and settle the run's outcome after teardown rather than before it:

```ts
import { SandboxAbortError, type ScriptResult } from '@ifc-lite/sandbox';

let result: ScriptResult | null = await sandbox.eval(code);
try {
  sandbox.dispose();
} catch (err) {
  if (err instanceof SandboxAbortError) {
    result = null; // the run died; whatever it "returned" is incomplete
  }
}
```

**A long-lived sandbox must be discarded once `moduleRetired` is true.** The abort poisons the whole WASM module, so this package retires it and builds the next sandbox on a fresh one — 1-5 ms, no page reload, and nothing for a caller to do. But a host that *keeps* one sandbox across many runs (an extension runtime, a REPL) can be holding one whose module was retired by some other sandbox's abort. That sandbox still executes scripts, yet emscripten's `ABORT` latch is per module and has already fired on it: its own teardown can no longer report a failure, and it will silently leak whatever `JS_FreeRuntime` does not reach. Check before running, and replace rather than reuse:

```ts
if (sandbox.moduleRetired) {
  sandbox.dispose();
  sandbox = await createSandbox(bim, config); // built on a fresh module
}
```

`moduleRetired` is always `false` after `dispose()`, which releases the module reference — so check it while the sandbox is live. Sandboxes created per run (the viewer's script panel) never observe it: they are already gone by then.

`isSandboxRuntimeAborted()` reports whether *any* teardown abort has happened in this process. It is a diagnostic, latched for the process lifetime; it is not a health check, and a `true` does not mean scripting is dead.

## Features

- QuickJS interpreter compiled to WASM: full isolation from the host page
- Only the bridged `bim.*` API is reachable from scripts
- Configurable `SandboxPermissions` and `SandboxLimits` (with `DEFAULT_PERMISSIONS` / `DEFAULT_LIMITS`)
- Captured console logs and structured `ScriptResult` / `ScriptError`
- TypeScript support via `transpileTypeScript` (esbuild-wasm)
- Machine-readable bridge schema (`NAMESPACE_SCHEMAS`, exported at `@ifc-lite/sandbox/schema`) for LLM tool integration
- Survives the upstream QuickJS teardown abort by retiring the WASM module it poisons (`SandboxAbortError`, `Sandbox.moduleRetired` — see above)

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
