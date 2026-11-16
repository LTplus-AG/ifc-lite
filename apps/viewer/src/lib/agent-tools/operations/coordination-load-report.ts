/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { buildLoadReports, buildLoadReportJSON } from '@/lib/loadReport';
import { emptySchema } from './contract';
import { coordination } from './coordination-common';
export const coordinationLoadReportOperations = [
  coordination('loadReport.read', 'Read existing per-model diagnostics, omissions and affected IFC entities; never infers a successful retry.', ['read'], emptySchema, () => ({ reports: buildLoadReports(useViewerStore.getState().models) })),
  coordination('loadReport.export', 'Export native load diagnostic evidence as a host-owned JSON artifact.', ['artifact'], emptySchema, async (_, c) => {
    const data = buildLoadReportJSON(buildLoadReports(useViewerStore.getState().models)); c.checkpoint?.();
    return c.artifacts.create({ filename: 'model-load-report.json', mimeType: 'application/json', data: JSON.stringify(data, null, 2) });
  }),
];
