/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StepExporter } from '@ifc-lite/export';

export class StepExportUnavailableError extends Error {
  constructor(readonly reason: 'loading' | 'load-failed', cause?: unknown) {
    super(reason === 'loading'
      ? 'STEP export is still loading. Try again in a moment.'
      : 'Could not load STEP export. Reload the viewer and try again.', { cause });
    this.name = 'StepExportUnavailableError';
  }
}

export function createSdkStepWriter(importWriter: () => Promise<{ StepExporter: typeof StepExporter }>) {
  let writer: typeof StepExporter | undefined;
  let pending: Promise<void> | undefined;
  let failure: StepExportUnavailableError | undefined;
  return {
    load: () => pending ??= importWriter().then(
      module => { writer = module.StepExporter; },
      cause => {
        failure = new StepExportUnavailableError('load-failed', cause);
        throw failure;
      },
    ),
    get: () => {
      if (writer) return writer;
      throw failure ?? new StepExportUnavailableError('loading');
    },
  };
}

export type SdkStepWriter = ReturnType<typeof createSdkStepWriter>;

export const sdkStepWriter = createSdkStepWriter(() => import('@/lib/export/step-export-runtime'));

export async function prepareSandboxStepExport(): Promise<void> {
  try {
    await sdkStepWriter.load();
  } catch (error) {
    console.warn(error);
  }
}
