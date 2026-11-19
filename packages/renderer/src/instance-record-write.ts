/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * One per-occurrence instance write, to the GPU buffer and to the CPU record
 * it was uploaded from (#10767).
 *
 * Model placement (`placeSceneInstances`) and device recovery re-upload a
 * whole instance buffer from the CPU record. State written to the GPU alone
 * (hide/isolate, selection, appearance suppression, override and X-Ray
 * colours) was lost there. The CPU record is the scene's own copy (decoded
 * fresh for each upload; placement already rewrites its matrices), and its
 * colour and flag lanes are read only at upload: materialization and restore
 * use the occurrence's captured `originalColor`.
 */
export function writeInstanceRecord(
  device: GPUDevice,
  gpu: GPUBuffer | undefined,
  cpu: ArrayBuffer | undefined,
  offset: number,
  data: Uint32Array | Float32Array,
): void {
  if (gpu) device.queue.writeBuffer(gpu, offset, data);
  if (cpu && offset + data.byteLength <= cpu.byteLength) {
    new Uint8Array(cpu, offset, data.byteLength).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
}
