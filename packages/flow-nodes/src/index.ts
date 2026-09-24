/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NodeRegistry, type HostFeatures } from '@ifc-lite/flow';
import { applyTableNode } from './apply-table-node.js';
import { bcfNodes } from './bcf-nodes.js';
import { connectorNodes } from './connector-nodes.js';
import { coreNodes } from './core-nodes.js';
import { csvNodes } from './csv-nodes.js';
import { elementNodes } from './element-nodes.js';
import { httpRequestNode } from './http-request-node.js';
import type { FlowHost } from './host.js';
import { modelNodes } from './model-nodes.js';
import { scriptListNode, scriptNode } from './script-node.js';
import { tableNodes } from './table-nodes.js';
import { viewerNodes } from './viewer-nodes.js';
import { writeNodes } from './write-nodes.js';
import { xlsxNodes } from './xlsx-nodes.js';

export type { FlowHost, FlowNodeDef, TableAccess, StringLookup } from './host.js';
export { requireCapability, toRef, toSdkRef, resolveByGlobalId, rememberGlobalId, forgetGlobalId, invalidateGlobalIdIndex } from './host.js';
export { columnTypeOf, VALUE_TYPE_BY_COLUMN_TYPE } from './table-nodes.js';
export type { ElementSpec } from './element-nodes.js';
export { readXlsxTable, writeXlsxTable } from './xlsx-io.js';
export type { ReadXlsxOptions, ReadXlsxResult, XlsxColumnSpec } from './xlsx-io.js';

export {
  declaredSecrets,
  referencedSecrets,
  validateSecretReferences,
  resolveSecretValues,
  interpolateSecrets,
  buildRedactionMap,
  redactText,
  redactDeep,
  MIN_REDACTED_SECRET_LENGTH,
  usableSecretNames,
} from './secrets.js';
export type { SecretValidationError } from './secrets.js';

/** Every standard node, in one registry. */
export function createStandardRegistry(): NodeRegistry<FlowHost> {
  return new NodeRegistry<FlowHost>().registerAll([
    ...coreNodes,
    ...modelNodes,
    ...tableNodes,
    ...viewerNodes,
    ...writeNodes,
    ...elementNodes,
    ...csvNodes,
    ...xlsxNodes,
    ...connectorNodes,
    applyTableNode,
    scriptNode,
    scriptListNode,
    httpRequestNode,
    ...bcfNodes,
  ]);
}

/**
 * What a viewer-embedded host offers. `network` is `true`: the viewer DOES
 * attempt `network.fetch` (subject to the browser's own CORS enforcement —
 * a blocked request surfaces as an explicit CORS error, not an empty
 * success; see `HttpRequest`'s node doc and `runner.ts`). `secrets` is
 * always empty: the browser has no `process.env` and must never persist a
 * secret, so a graph that references one shows `unavailable` before it
 * runs rather than failing mid-run (#5167 phase 3.5).
 */
export const BROWSER_FEATURES: HostFeatures = {
  backend: new Set(['viewer', 'visibility', 'selection', 'mutate', 'store', 'files', 'sandbox']),
  network: true,
  secrets: new Set(),
};

/**
 * What the CLI's / MCP's headless backend offers. It implements the viewer
 * methods as inert no-ops, so `viewer`/`visibility`/`selection` are
 * deliberately absent here: a viewer node must report `noop`, not pretend.
 * `network` is always `true`: both headless callers have a real, unrestricted
 * `fetch` (no CORS), so a `network.fetch` bridge is always configured — the
 * per-request host allow-list check still runs against the graph's actual
 * grants (see `network-request.ts`). `secrets` is exactly the set of env var
 * names the caller passes (CLI: `Object.keys(process.env)`; MCP: the same —
 * see `flow.ts` in `@ifc-lite/cli` and `@ifc-lite/mcp`), never guessed here.
 */
export function headlessFeatures(secrets: Iterable<string> = []): HostFeatures {
  return { backend: new Set(['mutate', 'store', 'files', 'sandbox']), network: true, secrets: new Set(secrets) };
}
