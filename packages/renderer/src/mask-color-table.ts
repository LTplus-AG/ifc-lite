/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Group 1 of the selection-mask layouts: the scene's entity colour table at
 * binding 5, which `vs_main` and `vs_instanced` read for the painted depth
 * nudge (`shaders/depth-nudge.wgsl.ts`). Visible masks test `greater-equal`
 * against the scene depth, so every vertex must be nudged exactly as the
 * colour pass nudged it, painted or not. The instanced variant also carries
 * its hover uniform at binding 0 (`SELECTION_MASK_HOVER_GROUP`).
 */
const TABLE_BINDING = 5;

interface DeviceTables { plain: GPUBindGroupLayout; hover: GPUBindGroupLayout }
const byDevice = new WeakMap<GPUDevice, DeviceTables>();

function tables(device: GPUDevice): DeviceTables {
  let t = byDevice.get(device);
  if (!t) {
    const table: GPUBindGroupLayoutEntry = { binding: TABLE_BINDING, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } };
    t = {
      plain: device.createBindGroupLayout({ label: 'mask-color-table-bgl', entries: [table] }),
      hover: device.createBindGroupLayout({ label: 'mask-color-table-hover-bgl', entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, table] }),
    };
    byDevice.set(device, t);
  }
  return t;
}

/** The mask layouts' group 1: the colour table, plus the instanced hover uniform when `withHover`. */
export function maskTableLayout(device: GPUDevice, withHover: boolean): GPUBindGroupLayout {
  return withHover ? tables(device).hover : tables(device).plain;
}

/** Group 1 for one mask user, rebuilt only when the scene's table buffer is replaced (it grows). */
export class MaskTableGroup {
  private table: GPUBuffer | null = null;
  private group: GPUBindGroup | null = null;
  /** Bound when no table is given (zero-initialised: no entries, nothing painted). */
  private empty: GPUBuffer | null = null;

  constructor(private readonly device: GPUDevice, private readonly hover?: GPUBuffer) {}

  /** The bind group for `table` (the scene's entity colour table); absent binds an empty table. */
  get(table?: GPUBuffer | null): GPUBindGroup {
    const t = table ?? (this.empty ??= this.device.createBuffer({ label: 'mask-color-table-empty', size: 16, usage: GPUBufferUsage.STORAGE }));
    if (t !== this.table || !this.group) {
      this.table = t;
      this.group = this.device.createBindGroup({
        label: 'mask-color-table',
        layout: maskTableLayout(this.device, this.hover !== undefined),
        entries: [...(this.hover ? [{ binding: 0, resource: { buffer: this.hover } }] : []), { binding: TABLE_BINDING, resource: { buffer: t } }],
      });
    }
    return this.group;
  }

  destroy(): void {
    this.empty?.destroy();
    this.empty = null; this.table = null; this.group = null;
  }
}
