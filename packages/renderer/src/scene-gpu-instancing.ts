/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The scene's side of GPU-driven instancing (`gpu-instance-pool.ts`): whether
 * new instanced uploads go to the pool, the pool itself, its hide/isolate
 * bookkeeping, and its rebuild after device loss. Off by default; the scene
 * keeps its per-template path untouched while `pool` is null.
 */
import { GpuInstancePool } from './gpu-instance-pool.js';
import { POOL_STATE_HOVER, POOL_STATE_ISOLATED, POOL_STATE_USER_HIDDEN } from './gpu-instance-cull.js';
import { INSTANCE_STRIDE_BYTES } from './instanced-render.js';
import type { InstancedOccurrence, InstancedTemplateCpu, InstancedTemplateGPU } from './scene-instance-types.js';

type Ids = ReadonlySet<number> | null | undefined;

export class SceneInstancePool {
  private on = false;
  /** New instanced uploads go to the pool (`Scene.setGpuInstancing`). */
  get enabled(): boolean { return this.on; }

  /**
   * Switch the path. Every pass draws either the pool or the per-template
   * buffers, never both, so the switch is refused while instanced templates
   * exist (set it before geometry streams in, or after the scene is cleared).
   */
  setEnabled(enabled: boolean, hasTemplates: boolean): boolean {
    if (enabled === this.on) return true;
    if (hasTemplates) {
      console.warn('[Scene] GPU-driven instancing can only change before instanced geometry loads; ignoring setGpuInstancing(' + enabled + ')');
      return false;
    }
    this.on = enabled;
    this.clear(); // an emptied pool must not outlive the switch (passes take the pool path while one exists)
    return true;
  }
  private current: GpuInstancePool | null = null;
  /** Hide/isolate inputs last applied (their own copies). */
  private hidden = new Set<number>();
  private isolated = new Set<number>();
  /** Pool occurrence count when the sets above were applied (late shards need re-application). */
  private appliedRegistrations = 0;
  /** Pool indices carrying the HOVER bit. */
  private hovered: number[] = [];

  /** The pool, or null when the per-template path is active. */
  get pool(): GpuInstancePool | null { return this.current; }

  /** The pool for a new upload, created on first use; null when disabled. */
  ensure(device: GPUDevice): GpuInstancePool | null {
    if (!this.on) return null;
    return (this.current ??= new GpuInstancePool(device));
  }

  /** GPU bytes held by the pool (source, state and compacted tables). */
  gpuBytes(): number { return this.current?.gpuBytes() ?? 0; }

  /** Mark the hovered entity's occurrences (`modelIndex` scoped) so the contribution cull keeps them for the hover outline. */
  setHover(occurrences: readonly InstancedOccurrence[] | undefined, inModel: (loc: InstancedOccurrence) => boolean): void {
    const pool = this.current;
    if (!pool) return;
    const next: number[] = [];
    for (const loc of occurrences ?? []) if (loc.poolIndex !== undefined && loc.poolIndex >= 0 && inModel(loc)) next.push(loc.poolIndex);
    if (next.length === this.hovered.length && next.every((v, i) => v === this.hovered[i])) return;
    for (const i of this.hovered) pool.setVisibilityBit(i, POOL_STATE_HOVER, false);
    for (const i of next) pool.setVisibilityBit(i, POOL_STATE_HOVER, true);
    this.hovered = next;
  }

  /** Re-upload only the moved occurrences' records and anchors (an entity move). */
  refreshOccurrences(moved: readonly InstancedOccurrence[], cpu: readonly (InstancedTemplateCpu | undefined)[]): void {
    if (!this.current) return;
    const bySlot = new Map<number, number[]>();
    for (const loc of moved) { const list = bySlot.get(loc.templateIndex); const i = loc.byteOffset / INSTANCE_STRIDE_BYTES; if (list) list.push(i); else bySlot.set(loc.templateIndex, [i]); }
    for (const [slot, indices] of bySlot) { const c = cpu[slot]; if (c) this.current.refreshTemplate(slot, c.instanceData, c.canonicalAnchors, indices); }
  }

  /** Re-upload moved templates' records and anchors (radii are rigid-invariant). */
  refresh(slots: Iterable<number>, cpu: readonly (InstancedTemplateCpu | undefined)[]): void {
    if (!this.current) return;
    for (const slot of new Set(slots)) {
      const c = cpu[slot];
      if (c) this.current.refreshTemplate(slot, c.instanceData, c.canonicalAnchors);
    }
  }

  /**
   * Hide/isolate in O(changed ids), not O(all instanced entities): hidden ids
   * set USER_HIDDEN on their occurrences; isolation sets ISOLATED on members
   * and flips one uniform bit.
   */
  applyVisibility(occurrences: ReadonlyMap<number, readonly InstancedOccurrence[]>, hiddenIds: Ids, isolatedIds: Ids): void {
    const pool = this.current;
    if (!pool) return;
    // A shard that streamed in since the last apply carries fresh (zero) state: re-apply all.
    const full = pool.registrations !== this.appliedRegistrations;
    const apply = (prev: Set<number>, next: Ids, bit: number): Set<number> => {
      const nextSet = new Set<number>();
      for (const eid of next ?? []) if (occurrences.has(eid)) nextSet.add(eid);
      const write = (eid: number, on: boolean): void => {
        for (const loc of occurrences.get(eid) ?? []) if (loc.poolIndex !== undefined && loc.poolIndex >= 0) pool.setVisibilityBit(loc.poolIndex, bit, on);
      };
      for (const eid of prev) if (!nextSet.has(eid)) write(eid, false);
      for (const eid of nextSet) if (full || !prev.has(eid)) write(eid, true);
      return nextSet;
    };
    this.hidden = apply(this.hidden, hiddenIds, POOL_STATE_USER_HIDDEN);
    this.isolated = apply(this.isolated, isolatedIds, POOL_STATE_ISOLATED);
    pool.setIsolationActive(isolatedIds != null);
    this.appliedRegistrations = pool.registrations;
  }

  /**
   * Device recovery: the old pool's buffers died with the device. Re-register
   * every restored template on the replacement device, in slot order, and
   * re-point each occurrence's pool index. Appearance (selection, colour,
   * ghost) is re-written afterwards through the scene's lane writes;
   * hide/isolate re-applies in full on the next visibility sync.
   */
  rebuild(device: GPUDevice, templates: readonly (InstancedTemplateGPU | undefined)[], cpu: readonly (InstancedTemplateCpu | undefined)[],
    occurrences: ReadonlyMap<number, readonly InstancedOccurrence[]>, radiiBySlot: ReadonlyMap<number, Float32Array>): void {
    this.current?.destroy();
    const pool = new GpuInstancePool(device);
    this.current = pool;
    const bases = new Map<number, number>();
    for (let slot = 0; slot < templates.length; slot++) {
      const t = templates[slot]; const c = cpu[slot]; const radii = radiiBySlot.get(slot);
      if (!t || !c || !radii) continue;
      const base = pool.allocate(t.instanceCount);
      bases.set(slot, base);
      t.poolGroup = pool.addTemplate(slot, base, { vertexBuffer: t.vertexBuffer, indexBuffer: t.indexBuffer, indexCount: t.indexCount, positions: c.positions, normals: c.normals, indices: c.indices },
        c.instanceData, c.canonicalAnchors, radii);
    }
    for (const list of occurrences.values()) {
      for (const loc of list) {
        const base = bases.get(loc.templateIndex);
        loc.poolIndex = base === undefined ? -1 : base + loc.byteOffset / INSTANCE_STRIDE_BYTES;
      }
    }
    this.hidden = new Set(); this.isolated = new Set(); this.appliedRegistrations = -1; this.hovered = [];
  }

  /** Scene clear: drop the pool; the next instanced upload starts a new one if still enabled. */
  clear(): void {
    this.current?.destroy(); this.current = null;
    this.hidden = new Set(); this.isolated = new Set(); this.appliedRegistrations = 0; this.hovered = [];
  }
}
