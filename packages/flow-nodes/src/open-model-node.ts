/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `model.openFromSource` — open a file a previous node fetched (typically
 * `documents.download`) as a model, through the host's own load path
 * (`FlowHost.openModel`): the viewer's canonical `addModel`/`loadFile`
 * pipeline, or the CLI's / MCP's headless loader. The node never parses
 * the bytes itself, so no second ingest pipeline exists.
 *
 * The `modelId` output is what sequences the rest of the graph: wire it
 * into `model.select` / `model.byType`'s `modelId` input so those reads
 * run after the model is open and address it.
 */

import { fromBase64 } from './base64.js';
import { requireCapability, SCALAR_ITEM, type FlowNodeDef } from './host.js';

export const openModelNode: FlowNodeDef = {
  type: 'model.openFromSource',
  title: 'Open model from source',
  category: 'model',
  doc: 'Opens a downloaded IFC file (base64 `data`, e.g. from Download document) as a model on the host. Wire `modelId` into a model read node to query the opened model.',
  inputs: [
    { name: 'data', type: SCALAR_ITEM },
    { name: 'name', type: SCALAR_ITEM, optional: true, nullable: true },
  ],
  outputs: [{ name: 'modelId', type: SCALAR_ITEM }],
  params: [{ name: 'name', kind: 'string', default: 'model.ifc', doc: 'File name, used when the `name` input is not wired; its extension picks the format.' }],
  capabilities: ['model.create'],
  requires: { backend: ['openModel'] },
  // Loading a model changes what every later read sees, so it is a write
  // (never memoised, and it advances the cache's write generation).
  writes: 'model',
  volatile: true,
  run: async (ctx, i, p) => {
    requireCapability(ctx, 'model.create');
    const open = ctx.host.openModel;
    if (!open) throw new Error('model.openFromSource: this host cannot open models');
    const bytes = fromBase64(typeof i.data === 'string' ? i.data : '');
    if (bytes.byteLength === 0) throw new Error('model.openFromSource: "data" is empty');
    const name = typeof i.name === 'string' && i.name.length > 0 ? i.name : typeof p.name === 'string' && p.name.length > 0 ? p.name : 'model.ifc';
    const { modelId } = await open.call(ctx.host, bytes, name);
    return { modelId };
  },
};
