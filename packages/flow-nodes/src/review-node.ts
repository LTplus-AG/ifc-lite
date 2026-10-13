/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ANY_ITEM, requireCapability, type FlowNodeDef } from './host.js';

export const reviewSnapshotNode: FlowNodeDef = {
  type: 'review.snapshot', title: 'Read native Review', category: 'review',
  doc: 'Reads actual captured native findings, model/source provenance, coverage and explicit unsupported sources. Does not rerun analyses, publish records or make human decisions.',
  inputs: [{ name: 'after', type: ANY_ITEM, optional: true, doc: 'Optional dependency on a native analysis result.' }],
  outputs: [{ name: 'snapshot', type: ANY_ITEM }],
  params: [{ name: 'sources', kind: 'json' }, { name: 'modelIds', kind: 'json' },
    { name: 'maxFindings', kind: 'number', default: 128 }],
  capabilities: ['model.read'], requires: { backend: ['review'] }, reads: 'model', volatile: true,
  run: async (ctx, _input, params) => {
    requireCapability(ctx, 'model.read');
    if (!ctx.host.review) throw new Error('review.snapshot: this host has no native Review provider');
    return { snapshot: await ctx.host.review.snapshot(params) };
  },
};
