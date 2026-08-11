/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Space Sketch SVG canvas — the presentational layer. Pure render: it draws
 * the grid, building underlay, rooms (at the chosen boundary), leak diagnostics,
 * and all the live interaction cues (hover, cut rubber-band, snap rings, draw
 * preview, delete telegraph), plus the action-intent chip. All interaction
 * logic lives in the overlay controller; this component only receives state and
 * forwards pointer events.
 */

import type { Room } from '@/lib/space-plate-session';
import { sX, sY, centroid, polyArea, uniqueVerts, type Fit, type Pt } from '@/lib/space-sketch-geometry';
import type { SnapKind } from '@/lib/space-snap';
import type { BoundaryMode } from '@ifc-lite/create';
import type { Hover, SplitTarget, Intent, IntentTone } from './types';

const EPS = 1e-6;
const ROOM_COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#84cc16', '#a855f7', '#ef4444'];

const INTENT_TEXT_CLASS: Record<IntentTone, string> = {
  move: 'text-foreground',
  draw: 'text-emerald-600 dark:text-emerald-400',
  cut: 'text-blue-600 dark:text-blue-400',
  remove: 'text-red-600 dark:text-red-400',
  pan: 'text-muted-foreground',
};
const INTENT_DOT_CLASS: Record<IntentTone, string> = {
  move: 'bg-zinc-400',
  draw: 'bg-emerald-500',
  cut: 'bg-blue-500',
  remove: 'bg-red-500',
  pan: 'bg-zinc-400',
};

interface GridLine { x1: number; y1: number; x2: number; y2: number }
interface BoundaryInfo { disp: Pt[]; unbounded: boolean }
interface Diagnostic { a: Pt; b: Pt; bounding: boolean }

export interface SpaceSketchCanvasProps {
  svgRef: React.RefObject<SVGSVGElement | null>;
  width: number;
  height: number;
  cursor: string;
  fit: Fit;
  gridLines: GridLine[];
  underlay: React.ReactNode;
  rooms: Room[];
  boundaryInfo: BoundaryInfo[];
  boundaryMode: BoundaryMode;
  mergeFaces: Set<number> | null;
  diagnostics: Diagnostic[] | null;
  hover: Hover;
  splitPick: SplitTarget | null;
  previewEnd: Pt | null;
  splitHover: Pt | null;
  snapPos: Pt | null;
  snapKind: SnapKind;
  drawPts: Pt[];
  drawCursor: Pt | null;
  /** Rectangle tool: the 4 in-progress corners (null when not drawing one). */
  rectPreview: Pt[] | null;
  alignGuides: { vRef: Pt | null; hRef: Pt | null };
  deleteHover: Pt | null;
  intent: Intent | null;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onPointerLeave: () => void;
}

export function SpaceSketchCanvas(props: SpaceSketchCanvasProps) {
  const {
    svgRef, width, height, cursor, fit: f, gridLines, underlay, rooms, boundaryInfo,
    boundaryMode, mergeFaces, diagnostics, hover, splitPick, previewEnd, splitHover,
    snapPos, snapKind, drawPts, drawCursor, rectPreview, alignGuides, deleteHover, intent,
    onPointerDown, onPointerMove, onPointerUp, onDoubleClick, onContextMenu, onPointerLeave,
  } = props;

  return (
    <div className="relative">
      {/* Live action preview — tells you what the next click will do, colour-keyed
          to the on-canvas cues (green draw · blue cut · red remove/merge). */}
      {intent && (
        <div className="pointer-events-none absolute right-2 top-2 z-20 flex items-center gap-1.5 rounded-md border bg-background/85 px-2 py-1 text-[11px] font-semibold shadow-sm backdrop-blur">
          <span className={`h-1.5 w-1.5 rounded-full ${INTENT_DOT_CLASS[intent.tone]}`} />
          <span className={INTENT_TEXT_CLASS[intent.tone]}>{intent.text}</span>
        </div>
      )}
      <svg ref={svgRef} width={width} height={height} style={{ cursor }}
        className="rounded border bg-muted/20 touch-none"
        // Suppress the browser's native HTML5 drag: without this, pressing a
        // vertex/edge and moving starts a native element drag that the viewer's
        // file-drop zone catches ("Drop to federate"), hijacking the edit drag.
        onDragStart={(e) => e.preventDefault()}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onPointerLeave={onPointerLeave}>
        {gridLines.map((l, i) => <line key={`g${i}`} {...l} stroke="currentColor" strokeOpacity={0.06} strokeWidth={1} />)}

        {/* Building-element underlay (plan cut ~1.2 m above the storey) for orientation. */}
        {underlay}

        {rooms.map((r, ri) => {
          const color = ROOM_COLORS[ri % ROOM_COLORS.length];
          const { disp, unbounded } = boundaryInfo[ri];
          const pts = disp.map((p) => `${sX(f, p[0])},${sY(f, p[1])}`).join(' ');
          const [cwx, cwy] = centroid(disp);
          const cx = sX(f, cwx), cy = sY(f, cwy);
          const lit = mergeFaces?.has(r.face);
          const bad = !r.simple;
          const area = boundaryMode === 'center' ? r.area : polyArea(disp);
          return (
            <g key={r.face}>
              {boundaryMode !== 'center' && (
                <polygon points={r.outline.map((p) => `${sX(f, p[0])},${sY(f, p[1])}`).join(' ')}
                  fill="none" stroke={color} strokeOpacity={0.25} strokeDasharray="3 3" strokeWidth={1} />
              )}
              <polygon points={pts} fill={bad ? '#ef4444' : color} fillOpacity={lit ? 0.42 : bad ? 0.3 : 0.16}
                stroke={bad ? '#ef4444' : color} strokeWidth={lit ? 3 : 2}
                strokeDasharray={unbounded && !bad ? '5 4' : undefined}>
                {unbounded && <title>Boundary “{boundaryMode}” made no change to this room — no wall offset applies (no wall runs along its edges, or it's fully internal in Outer mode).</title>}
              </polygon>
              <text x={cx} y={cy - 5} textAnchor="middle" fontSize={12} fontWeight={600} fill="currentColor" className="pointer-events-none">{area.toFixed(2)}</text>
              <text x={cx} y={cy + 9} textAnchor="middle" fontSize={9} fill="currentColor" opacity={0.55} className="pointer-events-none">m²</text>
            </g>
          );
        })}

        {/* Issue 7 — leak diagnostics: walls that bound a room (green) vs walls
            that bound nothing (red dashed = a stray segment / leak suspect). */}
        {diagnostics && diagnostics.map((s, i) => (
          <line key={`dg${i}`} x1={sX(f, s.a[0])} y1={sY(f, s.a[1])} x2={sX(f, s.b[0])} y2={sY(f, s.b[1])}
            stroke={s.bounding ? '#22c55e' : '#ef4444'} strokeOpacity={s.bounding ? 0.45 : 0.95}
            strokeWidth={s.bounding ? 1.2 : 2.2} strokeDasharray={s.bounding ? undefined : '4 3'} pointerEvents="none" />
        ))}

        {hover?.kind === 'edge' && (
          <line x1={sX(f, hover.a[0])} y1={sY(f, hover.a[1])} x2={sX(f, hover.b[0])} y2={sY(f, hover.b[1])} stroke="#ef4444" strokeWidth={4} strokeLinecap="round" />
        )}
        {splitPick && previewEnd && (
          <line x1={sX(f, splitPick.pos[0])} y1={sY(f, splitPick.pos[1])} x2={sX(f, previewEnd[0])} y2={sY(f, previewEnd[1])}
            stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="5 4" />
        )}
        {/* Cut/insert cue on a wall — the "+" handle that telegraphs "click to
            place a cut point here" (and previews the second cut point). */}
        {splitHover && (
          <g pointerEvents="none">
            <circle cx={sX(f, splitHover[0])} cy={sY(f, splitHover[1])} r={6} fill="#3b82f6" fillOpacity={0.15} stroke="#3b82f6" strokeWidth={1.5} />
            <line x1={sX(f, splitHover[0]) - 3} y1={sY(f, splitHover[1])} x2={sX(f, splitHover[0]) + 3} y2={sY(f, splitHover[1])} stroke="#3b82f6" strokeWidth={1.5} />
            <line x1={sX(f, splitHover[0])} y1={sY(f, splitHover[1]) - 3} x2={sX(f, splitHover[0])} y2={sY(f, splitHover[1]) + 3} stroke="#3b82f6" strokeWidth={1.5} />
          </g>
        )}
        {/* first committed split pick */}
        {splitPick && (
          <circle cx={sX(f, splitPick.pos[0])} cy={sY(f, splitPick.pos[1])} r={5} fill="#3b82f6" stroke="#fff" strokeWidth={1.5} pointerEvents="none" />
        )}
        {snapPos && (
          <g pointerEvents="none">
            {snapKind === 'line' ? (
              // On-wall snap — amber diamond.
              <rect x={sX(f, snapPos[0]) - 5} y={sY(f, snapPos[1]) - 5} width={10} height={10} fill="none"
                stroke="#f59e0b" strokeWidth={1.5} transform={`rotate(45 ${sX(f, snapPos[0])} ${sY(f, snapPos[1])})`} />
            ) : (
              // Corner/vertex snap — green ring.
              <circle cx={sX(f, snapPos[0])} cy={sY(f, snapPos[1])} r={9} fill="none" stroke="#22c55e" strokeWidth={1.5} />
            )}
            <circle cx={sX(f, snapPos[0])} cy={sY(f, snapPos[1])} r={2.5} fill={snapKind === 'line' ? '#f59e0b' : '#22c55e'} />
          </g>
        )}

        {/* First-corner preview: before any point is placed, show where the
            click will land + the snap cue, so the snap is visible up front. */}
        {drawPts.length === 0 && drawCursor && (
          <g pointerEvents="none">
            {snapKind === 'line' && (
              <rect x={sX(f, drawCursor[0]) - 5} y={sY(f, drawCursor[1]) - 5} width={10} height={10} fill="none"
                stroke="#f59e0b" strokeWidth={1.5} transform={`rotate(45 ${sX(f, drawCursor[0])} ${sY(f, drawCursor[1])})`} />
            )}
            {snapKind === 'vertex' && (
              <circle cx={sX(f, drawCursor[0])} cy={sY(f, drawCursor[1])} r={7} fill="none" stroke="#22c55e" strokeWidth={1.5} />
            )}
            <circle cx={sX(f, drawCursor[0])} cy={sY(f, drawCursor[1])} r={4} fill="#22c55e" stroke="#16a34a" strokeWidth={1.5} />
          </g>
        )}

        {/* Draw-room in progress (Issue 2): placed points, rubber band, close hint. */}
        {drawPts.length > 0 && (
          <g pointerEvents="none">
            {/* Alignment guides — the dashed lines that telegraph "this corner
                is lined up with that earlier corner" (e.g. under the first). */}
            {drawCursor && alignGuides.vRef && (
              <line x1={sX(f, drawCursor[0])} y1={sY(f, alignGuides.vRef[1])} x2={sX(f, drawCursor[0])} y2={sY(f, drawCursor[1])}
                stroke="#f59e0b" strokeOpacity={0.7} strokeDasharray="3 3" strokeWidth={1} />
            )}
            {drawCursor && alignGuides.hRef && (
              <line x1={sX(f, alignGuides.hRef[0])} y1={sY(f, drawCursor[1])} x2={sX(f, drawCursor[0])} y2={sY(f, drawCursor[1])}
                stroke="#f59e0b" strokeOpacity={0.7} strokeDasharray="3 3" strokeWidth={1} />
            )}
            {drawPts.length >= 3 && (
              <polygon points={drawPts.map((p) => `${sX(f, p[0])},${sY(f, p[1])}`).join(' ')} fill="#22c55e" fillOpacity={0.1} stroke="none" />
            )}
            <polyline points={drawPts.map((p) => `${sX(f, p[0])},${sY(f, p[1])}`).join(' ')} fill="none" stroke="#22c55e" strokeWidth={1.5} />
            {drawCursor && (
              <line x1={sX(f, drawPts[drawPts.length - 1][0])} y1={sY(f, drawPts[drawPts.length - 1][1])}
                x2={sX(f, drawCursor[0])} y2={sY(f, drawCursor[1])} stroke="#22c55e" strokeOpacity={0.5} strokeDasharray="4 3" strokeWidth={1.2} />
            )}
            {drawCursor && snapKind !== 'none' && (
              snapKind === 'line'
                ? <rect x={sX(f, drawCursor[0]) - 5} y={sY(f, drawCursor[1]) - 5} width={10} height={10} fill="none"
                    stroke="#f59e0b" strokeWidth={1.5} transform={`rotate(45 ${sX(f, drawCursor[0])} ${sY(f, drawCursor[1])})`} />
                : <circle cx={sX(f, drawCursor[0])} cy={sY(f, drawCursor[1])} r={7} fill="none" stroke="#22c55e" strokeWidth={1.5} />
            )}
            {drawPts.map((p, i) => (
              <circle key={`d${i}`} cx={sX(f, p[0])} cy={sY(f, p[1])} r={i === 0 && drawPts.length >= 3 ? 6 : 3.5}
                fill={i === 0 && drawPts.length >= 3 ? '#22c55e' : '#fff'} stroke="#16a34a" strokeWidth={1.5} />
            ))}
          </g>
        )}

        {/* Rectangle tool — the live rubber-band rectangle between the first
            corner and the cursor (committed as a room on the next click). */}
        {rectPreview && rectPreview.length === 4 && (
          <g pointerEvents="none">
            <polygon points={rectPreview.map((p) => `${sX(f, p[0])},${sY(f, p[1])}`).join(' ')}
              fill="#22c55e" fillOpacity={0.1} stroke="#22c55e" strokeWidth={1.5} strokeDasharray="4 3" />
            {rectPreview.map((p, i) => (
              <circle key={`r${i}`} cx={sX(f, p[0])} cy={sY(f, p[1])} r={3.5} fill="#fff" stroke="#16a34a" strokeWidth={1.5} />
            ))}
          </g>
        )}

        {uniqueVerts(rooms).map((p, i) => {
          const isHover = hover?.kind === 'vertex' && Math.abs(hover.pos[0] - p[0]) < EPS && Math.abs(hover.pos[1] - p[1]) < EPS;
          return (
            <circle key={i} cx={sX(f, p[0])} cy={sY(f, p[1])} r={isHover ? 6 : 4}
              fill={isHover ? '#fbbf24' : '#fff'} stroke="#334155" strokeWidth={1.5} pointerEvents="none" />
          );
        })}

        {/* ⌥/Ctrl-click delete telegraph (Issue 3): a red ring + minus over the node. */}
        {deleteHover && (
          <g pointerEvents="none">
            <circle cx={sX(f, deleteHover[0])} cy={sY(f, deleteHover[1])} r={8} fill="#ef4444" fillOpacity={0.15} stroke="#ef4444" strokeWidth={1.5} />
            <line x1={sX(f, deleteHover[0]) - 4} y1={sY(f, deleteHover[1])} x2={sX(f, deleteHover[0]) + 4} y2={sY(f, deleteHover[1])} stroke="#ef4444" strokeWidth={2} />
          </g>
        )}
      </svg>
    </div>
  );
}
