/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GaussianCompositionFallback } from './gaussian-composition.js';

/**
 * Holds the main pass's transparent IFC draws and the selection highlight that
 * follows them (#8564), so the nearest-glass split can replay them after the
 * splats behind the glass: once depth-only (P1), once as recorded. Nothing is
 * re-enumerated, and anything it cannot replay goes back into the main pass in
 * order, which is the frame as it was without the split.
 */

const REPLAYED = new Set<PropertyKey>([
  'setPipeline', 'setBindGroup', 'setVertexBuffer', 'setIndexBuffer', 'draw', 'drawIndexed',
  'setViewport', 'setScissorRect', 'setBlendConstant', 'setStencilReference',
  'pushDebugGroup', 'popDebugGroup', 'insertDebugMarker',
]);
const DRAWS = new Set<PropertyKey>(['draw', 'drawIndexed']);

type Command = readonly [method: string, args: unknown[]];

/** Decides, at the end of the transparent group, whether the frame can split. */
export type GlassSplitPrepare = (pipelines: ReadonlySet<GPURenderPipeline>) => GaussianCompositionFallback | null;

export class DeferredPassRecorder {
  private commands: Command[] = [];
  private highlightStart = -1;
  private pipeline: GPURenderPipeline | null = null;
  private unsupported = false;
  private recording = false;
  /** Pipelines that drew transparent IFC (the highlight excluded). */
  readonly glassPipelines = new Set<GPURenderPipeline>();
  /** The group contained transparent draws this frame. */
  transparent = false;
  /** The group is held for the split; false once it went back into the main pass. */
  deferred = false;
  fallback: GaussianCompositionFallback | null = null;
  /** Records every replayable call; any other call makes the group unreplayable. */
  readonly pass: GPURenderPassEncoder;

  constructor(private readonly enabled: GaussianCompositionFallback | null, private readonly prepare: GlassSplitPrepare) {
    this.pass = new Proxy({} as GPURenderPassEncoder, { get: (_target, key) => {
      if (key === 'label') return 'ifc-lite-gaussian-deferred-transparent';
      return (...args: unknown[]) => this.record(key, args);
    } });
  }

  /**
   * Start of the transparent group. Returns whether the caller must draw into
   * `pass` (and set the current pipeline on it first) instead of the main pass.
   */
  begin(transparent: boolean): boolean {
    this.transparent = transparent;
    this.fallback = transparent ? this.enabled : null;
    this.recording = this.deferred = transparent && this.enabled === null;
    return this.recording;
  }

  /** The selection highlight starts; it replays only into the colour pass. */
  markHighlight(): void {
    if (this.recording && this.highlightStart < 0) this.highlightStart = this.commands.length;
  }

  /** End of the group: keep it for the split, or put it back into `main` now. */
  end(main: GPURenderPassEncoder): void {
    if (!this.recording) return;
    this.recording = false;
    const fallback = this.unsupported ? 'unsupported-draw' : this.glassPipelines.size ? this.prepare(this.glassPipelines) : null;
    if (fallback === null && this.glassPipelines.size > 0) return;
    // Nothing transparent drew after all (for example every mesh failed RTE packing): the frame needs no split.
    this.transparent = this.glassPipelines.size > 0;
    this.fallback = this.transparent ? fallback : null;
    this.deferred = false;
    this.replay(main);
  }

  get highlightDraws(): number {
    return this.highlightStart < 0 ? 0 : this.commands.slice(this.highlightStart).filter(([method]) => DRAWS.has(method)).length;
  }

  /**
   * Replay into `pass`. `depthOnly` maps each glass pipeline to its depth-only
   * variant and stops before the highlight; `initial` restores bind groups the
   * group inherited from the main pass.
   */
  replay(pass: GPURenderPassEncoder, options: { depthOnly?: (pipeline: GPURenderPipeline) => GPURenderPipeline; initial?: ReadonlyArray<readonly [number, GPUBindGroup]> } = {}): void {
    for (const [group, bindGroup] of options.initial ?? []) pass.setBindGroup(group, bindGroup);
    const end = options.depthOnly && this.highlightStart >= 0 ? this.highlightStart : this.commands.length;
    for (let i = 0; i < end; i++) {
      const [method, args] = this.commands[i];
      if (method === 'setPipeline' && options.depthOnly) {
        // Only glass pipelines draw before the highlight; any other one (the main pass's current pipeline) is skipped.
        if (this.glassPipelines.has(args[0] as GPURenderPipeline)) pass.setPipeline(options.depthOnly(args[0] as GPURenderPipeline));
      } else Reflect.apply(Reflect.get(pass, method) as (...a: unknown[]) => unknown, pass, args);
    }
  }

  /** Everything is kept so the main-pass fallback replays the group verbatim; only the split needs `REPLAYED`. */
  private record(method: PropertyKey, args: unknown[]): void {
    if (typeof method !== 'string') return;
    if (!REPLAYED.has(method)) this.unsupported = true;
    if (method === 'setPipeline') {
      this.pipeline = args[0] as GPURenderPipeline;
      // A pipeline set that no draw used has no effect; dropping it keeps, for example, the main
      // pass's current (depth-writing) pipeline out of the read-only-depth passes.
      if (this.commands.at(-1)?.[0] === 'setPipeline') this.commands.pop();
      if (this.highlightStart > this.commands.length) this.highlightStart = this.commands.length;
    }
    if (DRAWS.has(method) && this.highlightStart < 0 && this.pipeline) this.glassPipelines.add(this.pipeline);
    this.commands.push([method, args]);
  }
}
