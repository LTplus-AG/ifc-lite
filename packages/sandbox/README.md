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

## Features

- QuickJS interpreter compiled to WASM: full isolation from the host page
- Only the bridged `bim.*` API is reachable from scripts
- Configurable `SandboxPermissions` and `SandboxLimits` (with `DEFAULT_PERMISSIONS` / `DEFAULT_LIMITS`)
- Captured console logs and structured `ScriptResult` / `ScriptError`
- TypeScript support via `transpileTypeScript` (esbuild-wasm)
- Machine-readable bridge schema (`NAMESPACE_SCHEMAS`, exported at `@ifc-lite/sandbox/schema`) for LLM tool integration

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
