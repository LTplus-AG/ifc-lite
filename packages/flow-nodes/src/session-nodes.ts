/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ANY_ITEM, SCALAR_ITEM, requireCapability, type FlowNodeDef, type Ctx } from './host.js';
import type { SessionAutomationHost } from './session-contracts.js';

function services(ctx: Ctx, grants: readonly string[]): SessionAutomationHost {
  for (const grant of grants) requireCapability(ctx, grant);
  ctx.signal?.throwIfAborted();
  if (!ctx.host.automation) throw new Error('This host does not provide session automation');
  return ctx.host.automation;
}
const files = { name: 'files', kind: 'json', default: {} } as const;
const jobs = { name: 'jobs', kind: 'json', default: [] } as const;
const optionalToken = (name: string) => ({ name, type: SCALAR_ITEM, optional: true, nullable: true });

export const sessionNodes: FlowNodeDef[] = [
  {
    type: 'session.loadModels', title: 'Load local models', category: 'session',
    doc: 'Load selected local IFC files, or explicitly bind loaded models, through the canonical loader.',
    inputs: [], outputs: [{ name: 'models', type: ANY_ITEM }],
    params: [files, { name: 'selectors', kind: 'json', default: [] }],
    capabilities: ['model.create'], requires: { backend: ['sessionModels'] }, writes: 'model', volatile: true,
    run: async (ctx, _i, p) => ({ models: await services(ctx, ['model.create']).loadModels(p.files, p.selectors, ctx.signal) }),
  },
  {
    type: 'session.assignModelTags', title: 'Assign filename tags', category: 'session',
    inputs: [{ name: 'models', type: ANY_ITEM }], outputs: [{ name: 'models', type: ANY_ITEM }],
    params: [{ name: 'rules', kind: 'json', default: [] }],
    capabilities: ['storage.write:modelTags'], requires: { backend: ['modelTags'] }, writes: 'model', volatile: true,
    run: async (ctx, i, p) => ({ models: await services(ctx, ['storage.write:modelTags']).assignTags(i.models, p.rules, ctx.signal) }),
  },
  {
    type: 'validation.runChecks', title: 'Run validation checks', category: 'session',
    inputs: [{ name: 'models', type: ANY_ITEM }], outputs: [{ name: 'reports', type: SCALAR_ITEM }],
    params: [jobs, files], capabilities: ['model.read', 'storage.write:validationReports'],
    requires: { backend: ['validationChecks'] }, reads: 'model', volatile: true,
    run: async (ctx, i, p) => ({ reports: await services(ctx, ['model.read', 'storage.write:validationReports']).validate(i.models, p.jobs, p.files, ctx.signal) }),
  },
  {
    type: 'comparison.runChecks', title: 'Run comparison recipes', category: 'session',
    inputs: [{ name: 'models', type: ANY_ITEM }], outputs: [{ name: 'reports', type: SCALAR_ITEM }],
    params: [jobs, files], capabilities: ['model.read', 'storage.write:savedComparisons'],
    requires: { backend: ['comparisonChecks'] }, reads: 'model', volatile: true,
    run: async (ctx, i, p) => ({ reports: await services(ctx, ['model.read', 'storage.write:savedComparisons']).compare(i.models, p.jobs, p.files, ctx.signal) }),
  },
  {
    type: 'report.importComparisons', title: 'Import comparison reports', category: 'report',
    inputs: [], outputs: [{ name: 'reports', type: SCALAR_ITEM }], params: [files],
    capabilities: ['storage.write:savedComparisons'], requires: { backend: ['comparisonReports'] }, volatile: true,
    run: async (ctx, _i, p) => ({ reports: await services(ctx, ['storage.write:savedComparisons']).importComparisons(p.files, ctx.signal) }),
  },
  {
    type: 'report.buildDocument', title: 'Build report document', category: 'report',
    inputs: [optionalToken('validation'), optionalToken('comparisons'), optionalToken('historical')],
    outputs: [{ name: 'document', type: SCALAR_ITEM }],
    params: [{ name: 'config', kind: 'json', default: {} }],
    capabilities: ['storage.write:documents'], requires: { backend: ['reportDocuments'] }, volatile: true,
    run: async (ctx, i, p) => ({ document: await services(ctx, ['storage.write:documents']).buildDocument(i.validation, i.comparisons, i.historical, p.config, ctx.signal) }),
  },
  {
    type: 'report.exportPdf', title: 'Generate report PDF', category: 'report',
    inputs: [{ name: 'document', type: SCALAR_ITEM }], outputs: [{ name: 'artifact', type: SCALAR_ITEM }], params: [],
    capabilities: ['export.create:pdf'], requires: { backend: ['pdfArtifacts'] }, volatile: true,
    run: async (ctx, i) => ({ artifact: await services(ctx, ['export.create:pdf']).exportPdf(i.document, ctx.signal) }),
  },
];
