/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { generateViewPdf, type ViewPdfExportInput } from './view-pdf/generate-view-pdf';
/** Native writer with a captured sink: both UI download and agent artifacts await real bytes. */
export async function produceNativeViewPdf(input: ViewPdfExportInput, checkpoint = () => {}) {
  checkpoint(); const output: { blob?: Blob } = {};
  const result = await generateViewPdf({ ...input, onProgress: (stage, progress) => { checkpoint(); input.onProgress?.(stage, progress); } }, { download: blob => { checkpoint(); output.blob = blob; } });
  checkpoint(); if (!output.blob) throw new Error('Native view PDF did not produce bytes.');
  return { result, blob: output.blob };
}
