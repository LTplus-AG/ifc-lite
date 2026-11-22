/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StepExporter } from '@ifc-lite/export';

let writer: typeof StepExporter | undefined;
let loadFailure: Error | undefined;

export async function prepareSdkStepExport(): Promise<void> {
  writer ??= (await import('@/lib/export/step-export-runtime')).StepExporter;
}

export async function prepareSandboxStepExport(): Promise<void> {
  try {
    await prepareSdkStepExport();
  } catch (cause) {
    // Keep a stale-tab chunk failure on the export call. Other scripts can still run.
    loadFailure = new Error('Could not load STEP export. Reload the viewer and try again.', { cause });
    console.warn(loadFailure);
  }
}

export function getSdkStepWriter(): typeof StepExporter {
  if (writer) return writer;
  throw loadFailure ?? new Error('STEP export was not prepared before starting the SDK call');
}
