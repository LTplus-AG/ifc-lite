/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { buildLoadReports, buildLoadReportJSON } from '@/lib/loadReport';
import { emptySchema } from './contract';
import { modelCoordination, coordination } from './coordination-common';
import { invalidInput } from './refusals';
export const coordinationLoadReportOperations = [
  modelCoordination<{ express_id: number }>('loadReport.focusEntity', 'Select a renderable entity captured in the targeted model load report and request native camera framing. Refuses diagnostics without captured geometry.', ['view', 'selection'], {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 } }, required: ['express_id'], additionalProperties: false,
  }, async (i, c) => {
    const { focusLoadReportEntity } = await import('@/lib/load-report-focus');
    return c.commit(() => { if (!focusLoadReportEntity(c.model.id, i.express_id)) throw invalidInput('unknown-target', 'No renderable diagnostic entity matches this model-qualified id.'); return { selected: i.express_id, model_id: c.model.id, framing: 'requested' }; });
  }),
  coordination('loadReport.read', 'Read existing per-model diagnostics, omissions and affected IFC entities; never infers a successful retry.', ['read'], emptySchema, () => ({ reports: buildLoadReports(useViewerStore.getState().models) })),
  coordination('loadReport.export', 'Export native load diagnostic evidence as a host-owned JSON artifact.', ['artifact'], emptySchema, async (_, c) => {
    const data = buildLoadReportJSON(buildLoadReports(useViewerStore.getState().models)); c.checkpoint?.();
    return c.artifacts.create({ filename: 'model-load-report.json', mimeType: 'application/json', data: JSON.stringify(data, null, 2) });
  }),
];
