/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * HeroScene — the hero’s living building. Real WebGL via Three.js.
 *
 * Twelve agent steps now, picked to span every visible primitive on the MCP
 * surface (Discovery, Query, Validation, Mutation, BCF, bSDD, Viewer):
 *
 *   00  viewer_open                       neutral framing
 *   01  model_audit                       audit badge appears
 *   02  count_entities(group_by="type")   element-count panel slides in
 *   03  viewer_color_by_storey            storey-0 cool blue, storey-1 warm orange
 *   04  viewer_color_by_property(IsExt.)  outer walls vs inner walls split colour
 *   05  viewer_isolate(IfcWall)           non-walls fade out
 *   06  viewer_colorize(IfcWall, "#d6ff3f") chartreuse paint
 *   07  bsdd_property_sets(IfcWall)       Pset list overlay
 *   08  entity_create(IfcDoor)            new door slides into the south wall
 *   09  viewer_set_section(z=2.2)         section plane clips top storey progressively
 *   10  bcf_topic_create("missing rating") red pin appears beside a wall
 *   11  viewer_describe_selection         info card overlays the canvas
 *
 * Steps own three things in parallel:
 *
 *   • visual scene state (driven by `hero-scene.ts` / `hero-scene-steps.ts`
 *     via tweened materials, positions, and three.js clipping planes),
 *   • a transcript line (printed under the canvas by the parent),
 *   • optional UI overlays (badges, pins, panels) the parent renders on
 *     top of the canvas via the exported `HERO_STEPS` data.
 *
 * This file owns the React half only: the step data below, and the mount that
 * forwards `step` into the scene handle.
 */

import { useEffect, useRef } from 'react';
import { useThreeScene } from './useThreeScene';
import { createScene, type SceneHandle } from './hero-scene';

/** McpLanding's `PAPER_DIM` as CSS, for the no-WebGL caption (#2401). The
 *  three.js palette lives in `hero-scene-building.ts` as hex numbers and
 *  cannot be handed to CSS; this is kept in sync by eye, same as
 *  ChunkErrorBoundary's `night` tone. */
const CAPTION_DIM_CSS = '#9c9486';

/** Step descriptor — `verb` carries the story-arc headline (1-2 words),
 *  `line` is the technical tool call shown beneath it. Overlays are kept
 *  intentionally sparse: each one shows the smallest piece of evidence
 *  that proves the agent's action landed. */
export interface HeroStep {
  /** One- or two-word verb shown big in display serif. The story arc. */
  verb: string;
  /** Tool call line shown under the verb in mono. The detail. */
  line: string;
  /** Tool category badge ("Validation", "Viewer", …). */
  family: string;
  /** Optional overlay UI key the parent renders inside the canvas frame. */
  overlay?:
    | { kind: 'audit'; score: number; note: string }
    | { kind: 'counts'; rows: Array<{ type: string; n: number }> }
    | { kind: 'psets'; psets: string[] }
    | { kind: 'pin'; ref: string }
    | { kind: 'card'; ref: string; lines: string[] };
}

export const HERO_STEPS: HeroStep[] = [
  { verb: 'Open',      line: 'viewer_open()',                                  family: 'Viewer' },
  { verb: 'Audit',     line: 'model_audit()',                                  family: 'Validation', overlay: { kind: 'audit', score: 74, note: '1 issue' } },
  { verb: 'Survey',    line: 'count_entities(group_by: "type")',               family: 'Query',      overlay: { kind: 'counts', rows: [
      { type: 'Wall',   n: 8 },
      { type: 'Window', n: 12 },
      { type: 'Slab',   n: 3 },
    ] } },
  { verb: 'Layer',     line: 'viewer_color_by_storey()',                       family: 'Viewer' },
  { verb: 'Classify',  line: 'viewer_color_by_property("IsExternal")',         family: 'Viewer' },
  { verb: 'Focus',     line: 'viewer_isolate(IfcWall)',                        family: 'Viewer' },
  { verb: 'Paint',     line: 'viewer_colorize(IfcWall, "#d6ff3f")',            family: 'Viewer' },
  { verb: 'Standardize', line: 'bsdd_property_sets("IfcWall")',                family: 'bSDD',      overlay: { kind: 'psets', psets: ['Pset_WallCommon', 'Qto_WallBaseQuantities', 'Pset_ConcreteElementGeneral'] } },
  { verb: 'Add',       line: 'entity_create(IfcDoor)',                         family: 'Mutation' },
  { verb: 'Section',   line: 'viewer_set_section(z = 2.2)',                    family: 'Viewer' },
  { verb: 'Issue',     line: 'bcf_topic_create("missing fire rating")',        family: 'BCF',       overlay: { kind: 'pin', ref: 'BCF #04' } },
  { verb: 'Inspect',   line: 'viewer_describe_selection()',                    family: 'Viewer',    overlay: { kind: 'card', ref: 'IfcWall #262', lines: ['Pset_WallCommon · IsExternal=true', 'FireRating=EI60 · 240 mm concrete'] } },
];

/** ms each step gets before advancing. */
export const HERO_STEP_MS = 2000;

export interface HeroSceneProps {
  /** 0..HERO_STEPS.length-1 — drives material/camera/section animation. */
  step: number;
  className?: string;
  /**
   * Optional callback fired every animation frame with the current
   * screen-space position of the BCF pin (relative to this element's
   * top-left). Used by HeroOverlay to anchor the pin caption.
   */
  onPinFrame?: (frame: { x: number; y: number; visible: boolean } | null) => void;
}

export function HeroScene({ step, className, onPinFrame }: HeroSceneProps) {
  const onPinRef = useRef(onPinFrame);
  onPinRef.current = onPinFrame;

  // The hero is decorative: when the device refuses a WebGL context the right
  // answer is a quiet caption in the same box, NOT the whole /mcp page being
  // replaced by an error card (#2401). Everything else on the stage — the
  // transcript, the step overlays, the progress dots, and the entire page of
  // copy around it — needs no GPU and keeps working.
  const { containerRef, handleRef, unavailable } = useThreeScene<SceneHandle>(
    'hero',
    createScene,
    (handle) => {
      let raf = 0;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        onPinRef.current?.(handle.projectPin());
      };
      tick();
      return () => cancelAnimationFrame(raf);
    },
  );

  useEffect(() => {
    handleRef.current?.update(step);
  }, [step, handleRef]);

  return (
    <div
      ref={containerRef}
      className={className ?? 'relative aspect-[4/5] w-full overflow-hidden rounded-lg'}
      style={{ background: '#0a0a0c' }}
    >
      {unavailable && (
        <div className="flex h-full w-full items-center justify-center px-6 text-center">
          <span
            className="text-[10px] uppercase tracking-[0.22em]"
            style={{ color: CAPTION_DIM_CSS, fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}
          >
            3D preview unavailable on this device
          </span>
        </div>
      )}
    </div>
  );
}
