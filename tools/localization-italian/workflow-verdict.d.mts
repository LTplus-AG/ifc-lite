/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
export { collectPageErrors, type WorkflowReport } from '../localization-shared/workflow-verdict.mjs';
import type { WorkflowReport } from '../localization-shared/workflow-verdict.mjs';
export const expectedChecks: readonly string[];
export function workflowFailed(report: WorkflowReport): boolean;
