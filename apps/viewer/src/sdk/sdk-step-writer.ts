/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StepExporter } from '@ifc-lite/export';

export type SdkStepWriter = () => typeof StepExporter;

let writer: Promise<SdkStepWriter> | undefined;

/** React waits for this before publishing the synchronous SDK context. */
export function loadSdkStepWriter(): Promise<SdkStepWriter> {
  return writer ??= import('@/lib/export/step-export-runtime').then(
    ({ StepExporter }) => () => StepExporter,
    (cause: unknown) => {
      // Allow the viewer and unrelated script operations to mount after a chunk failure.
      const error = new Error('Could not load STEP export. Reload the viewer and try again.', { cause });
      console.warn(error);
      return () => { throw error; };
    },
  );
}
