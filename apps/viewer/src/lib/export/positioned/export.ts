/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createDecodeWorkerSource } from '@ifc-lite/pointcloud';
import { positionedGaussianChunks } from '@ifc-lite/renderer';
import { detectPointCloudFormat } from '@/hooks/ingest/pointCloudIngest';
import { decodeGaussianInWorker } from '@/hooks/ingest/gaussianWorker';
import { restoreGaussianOrigin, type positionedExportSnapshot } from './frame';
import { PositionedPly } from './ply';
import { exportPositionedScan } from './scan';
import { preflightPositionedScan } from './preflight';

export async function exportPositionedFile(snapshot: ReturnType<typeof positionedExportSnapshot>, signal: AbortSignal,
  progress: (count: number) => void): Promise<Blob> {
  signal.throwIfAborted();
  if (snapshot.kind === 'scan') {
    const format = detectPointCloudFormat(snapshot.file.name, await snapshot.file.slice(0, 4096).arrayBuffer());
    signal.throwIfAborted();
    if (!format) throw new Error('Unsupported scan source format.');
    await preflightPositionedScan(snapshot.file, format, signal);
    // A separate full-resolution reader: never reopen the renderer's live LOD stream.
    const source = createDecodeWorkerSource({ blob: snapshot.file, format, stride: 1, originOffset: snapshot.origin });
    return exportPositionedScan(source, snapshot.matrix, signal, progress);
  }
  const decoded = await decodeGaussianInWorker(snapshot.file, signal);
  const ply = new PositionedPly();
  let count = 0;
  const matrix = restoreGaussianOrigin(snapshot.matrix, decoded.decodeOrigin);
  for await (const columns of positionedGaussianChunks(decoded, matrix)) {
    signal.throwIfAborted();
    ply.add(columns);
    progress(count += columns.x.length);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return ply.finish();
}
