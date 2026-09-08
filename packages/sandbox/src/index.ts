/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/sandbox — QuickJS-in-WASM sandboxed script execution
 *
 * Runs user scripts in a secure, isolated environment with only the
 * `bim.*` API exposed. No DOM, no fetch, no network access.
 *
 * @example
 * ```ts
 * import { createSandbox } from '@ifc-lite/sandbox';
 * import { createBimContext } from '@ifc-lite/sdk';
 *
 * const bim = createBimContext({ backend: myBackend });
 * const sandbox = await createSandbox(bim, {
 *   permissions: { mutate: true },
 *   limits: { timeoutMs: 10_000 },
 * });
 *
 * const result = await sandbox.eval(`
 *   const walls = bim.query.byType('IfcWall');
 *   console.log('Found', walls.length, 'walls');
 *   walls.length;
 * `);
 *
 * console.log(result.value);  // number of walls
 * console.log(result.logs);   // captured console.log output
 *
 * sandbox.dispose();
 * ```
 */

export {
  Sandbox,
  ScriptError,
  SandboxAbortError,
  createSandbox,
  isSandboxRuntimeAborted,
} from './sandbox.js';
export { buildBridge } from './bridge.js';
export { NAMESPACE_SCHEMAS, marshalValue } from './bridge-schema.js';
export type {
  NamespaceSchema,
  MethodSchema,
  MethodSemanticContract,
  MethodPlacementKind,
  LlmTaskIntent,
} from './bridge-schema.js';
export { transpileTypeScript } from './transpile.js';

export type {
  SandboxConfig,
  SandboxPermissions,
  SandboxLimits,
  ScriptResult,
  LogEntry,
  SandboxConsoleLevel,
} from './types.js';

export {
  DEFAULT_PERMISSIONS,
  DEFAULT_LIMITS,
  SANDBOX_CONSOLE_LEVELS,
} from './types.js';
