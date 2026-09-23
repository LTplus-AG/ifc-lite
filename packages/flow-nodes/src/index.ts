/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { NodeRegistry, type HostFeatures } from '@ifc-lite/flow';
import { coreNodes } from './core-nodes.js';
import { elementNodes } from './element-nodes.js';
import type { FlowHost } from './host.js';
import { modelNodes } from './model-nodes.js';
import { scriptListNode, scriptNode } from './script-node.js';
import { tableNodes } from './table-nodes.js';
import { viewerNodes } from './viewer-nodes.js';
import { writeNodes } from './write-nodes.js';

export type { FlowHost, FlowNodeDef } from './host.js';
export { requireCapability, toRef, toSdkRef, resolveByGlobalId, rememberGlobalId, forgetGlobalId, invalidateGlobalIdIndex } from './host.js';
export { columnTypeOf, VALUE_TYPE_BY_COLUMN_TYPE } from './table-nodes.js';
export type { ElementSpec } from './element-nodes.js';

/** Every standard node, in one registry. */
export function createStandardRegistry(): NodeRegistry<FlowHost> {
  return new NodeRegistry<FlowHost>().registerAll([...coreNodes, ...modelNodes, ...tableNodes, ...viewerNodes, ...writeNodes, ...elementNodes, scriptNode, scriptListNode]);
}

/** What a viewer-embedded host offers. Secrets are never available in the browser. */
export const BROWSER_FEATURES: HostFeatures = {
  backend: new Set(['viewer', 'visibility', 'selection', 'mutate', 'store', 'files', 'sandbox']),
  network: false,
  secrets: new Set(),
};

/**
 * What the CLI's `HeadlessBackend` offers. It implements the viewer
 * methods as inert no-ops, so `viewer`/`visibility`/`selection` are
 * deliberately absent here: a viewer node must report `noop`, not pretend.
 */
export function headlessFeatures(secrets: Iterable<string> = []): HostFeatures {
  return { backend: new Set(['mutate', 'store', 'files', 'sandbox']), network: false, secrets: new Set(secrets) };
}
