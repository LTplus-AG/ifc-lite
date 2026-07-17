/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Convert a parsed DXF document into a reference underlay (issue #1782):
 * tessellate entities, expand INSERT/DIMENSION blocks, resolve ACI/true
 * colours per layer, and scale $INSUNITS to metres. Output is in WORLD
 * plan coordinates (metres, +Y = north; DXF and IFC are both Z-up).
 * Consumers map world → drawing space themselves — for a plan view that
 * is `(x - shiftX, -(y - shiftY))` with the render-frame origin shift.
 */

import type { Point2D, Polygon2D, Bounds2D } from '../types.js';
import { aciToCss, rgbIntToCss } from './aci-colors.js';
import {
  expandBulgedVertices,
  matApply,
  matMultiply,
  matTRS,
  matTranslate,
  sampleArc,
  sampleCircle,
  sampleEllipse,
  tessellateSpline,
  MAT_IDENTITY,
  type Mat2d,
} from './geom.js';
import type {
  DxfDocument,
  DxfEntity,
  DxfLayerInfo,
  DxfPlacement,
  DxfUnderlay,
  DxfUnderlayLayer,
  DxfUnderlayText,
} from './types.js';

/** $INSUNITS → metres. Unknown codes fall back to 1 with a warning. */
const INSUNITS_TO_METRES: Record<number, number> = {
  0: 1, // unitless: assume metres (adjustable via placement scale)
  1: 0.0254, // inches
  2: 0.3048, // feet
  3: 1609.344, // miles
  4: 0.001, // millimetres
  5: 0.01, // centimetres
  6: 1, // metres
  7: 1000, // kilometres
  8: 2.54e-8, // microinches
  9: 2.54e-5, // mils
  10: 0.9144, // yards
  11: 1e-10, // angstroms
  12: 1e-9, // nanometres
  13: 1e-6, // microns
  14: 0.1, // decimetres
  15: 10, // decametres
  16: 100, // hectometres
};

/** Recursion guard for nested INSERTs. */
const MAX_BLOCK_DEPTH = 8;
/** Total block-instance expansion cap against pathological grids/nesting. */
const MAX_BLOCK_INSTANCES = 100_000;

const CONTINUOUS_LINETYPES = new Set(['', 'CONTINUOUS', 'BYLAYER', 'BYBLOCK']);

interface ConvertState {
  doc: DxfDocument;
  unitScale: number;
  layers: Map<string, DxfUnderlayLayer>;
  layerInfos: Map<string, DxfLayerInfo>;
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  warnings: string[];
  instanceCount: number;
  instanceCapHit: boolean;
}

interface RenderCtx {
  /** Accumulated block transform (DXF drawing units). */
  m: Mat2d;
  /** Resolved colour inherited by BYBLOCK entities (null at top level). */
  byBlockColor: string | null;
  /** INSERT's effective layer, inherited by block entities on layer "0". */
  insertLayer: string | null;
  depth: number;
  /** Block names on the current expansion stack (cycle guard). */
  stack: string[];
}

export interface DxfConvertOptions {
  /**
   * Override the unit conversion (drawing units → metres). When set, the
   * file's $INSUNITS is ignored. Used by `importDxf`'s unitless-mm
   * heuristic and available for callers that know the drawing's units.
   */
  metersPerUnit?: number;
}

/**
 * Convert a parsed DXF document to a reference underlay.
 * `name` labels the underlay (typically the file name).
 */
export function convertDxfToUnderlay(doc: DxfDocument, name = 'DXF', options: DxfConvertOptions = {}): DxfUnderlay {
  const warnings = [...doc.warnings];
  let unitScale: number;
  if (options.metersPerUnit !== undefined && options.metersPerUnit > 0) {
    unitScale = options.metersPerUnit;
  } else {
    const fromHeader = INSUNITS_TO_METRES[doc.insunits];
    if (fromHeader === undefined) {
      warnings.push(`Unknown $INSUNITS value ${doc.insunits}; drawing units treated as metres.`);
      unitScale = 1;
    } else {
      unitScale = fromHeader;
    }
    if (doc.insunits === 0) {
      warnings.push('DXF has no $INSUNITS; drawing units treated as metres (adjust with the underlay scale).');
    }
  }

  const state: ConvertState = {
    doc,
    unitScale,
    layers: new Map(),
    layerInfos: doc.layers,
    bounds: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    warnings,
    instanceCount: 0,
    instanceCapHit: false,
  };

  const ctx: RenderCtx = {
    m: MAT_IDENTITY,
    byBlockColor: null,
    insertLayer: null,
    depth: 0,
    stack: [],
  };
  emitEntities(doc.entities, ctx, state);

  const bounds: Bounds2D = Number.isFinite(state.bounds.minX)
    ? {
        min: { x: state.bounds.minX, y: state.bounds.minY },
        max: { x: state.bounds.maxX, y: state.bounds.maxY },
      }
    : { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } };

  // Stable layer order: DXF table order first, then referenced-only layers.
  const ordered: DxfUnderlayLayer[] = [];
  for (const layerName of doc.layers.keys()) {
    const bucket = state.layers.get(layerName);
    if (bucket) ordered.push(bucket);
  }
  for (const [layerName, bucket] of state.layers) {
    if (!doc.layers.has(layerName)) ordered.push(bucket);
  }

  return {
    name,
    layers: ordered.filter((l) => l.paths.length > 0 || l.fills.length > 0 || l.texts.length > 0),
    bounds,
    unitScale,
    skipped: { ...doc.skipped },
    warnings: state.warnings,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EMISSION
// ═══════════════════════════════════════════════════════════════════════════

function getBucket(state: ConvertState, layerName: string): DxfUnderlayLayer {
  let bucket = state.layers.get(layerName);
  if (!bucket) {
    const info = state.layerInfos.get(layerName);
    const color = info
      ? info.trueColor !== undefined
        ? rgbIntToCss(info.trueColor)
        : aciToCss(info.colorNumber)
      : '#000000';
    bucket = {
      name: layerName,
      color,
      visible: info ? info.visible : true,
      paths: [],
      fills: [],
      texts: [],
    };
    state.layers.set(layerName, bucket);
  }
  return bucket;
}

/** Resolve an entity's CSS colour given its layer and BYBLOCK context. */
function resolveColor(entity: DxfEntity, layerColor: string, ctx: RenderCtx): string {
  if (entity.trueColor !== undefined) return rgbIntToCss(entity.trueColor);
  const cn = entity.colorNumber;
  if (cn === 0) return ctx.byBlockColor ?? layerColor; // BYBLOCK
  if (cn >= 1 && cn <= 255) return aciToCss(cn);
  return layerColor; // BYLAYER (256) and anything unexpected
}

function isDashed(entity: DxfEntity, layerInfo: DxfLayerInfo | undefined): boolean {
  const lt = (entity.linetype ?? '').trim().toUpperCase();
  if (lt && lt !== 'BYLAYER') {
    return lt !== 'CONTINUOUS' && lt !== 'BYBLOCK';
  }
  const layerLt = (layerInfo?.linetype ?? '').trim().toUpperCase();
  return !CONTINUOUS_LINETYPES.has(layerLt);
}

/** Map a DXF-space point through the block chain into world metres. */
function toWorld(state: ConvertState, ctx: RenderCtx, x: number, y: number): Point2D {
  const p = matApply(ctx.m, x, y);
  const wx = p.x * state.unitScale;
  const wy = p.y * state.unitScale;
  if (wx < state.bounds.minX) state.bounds.minX = wx;
  if (wx > state.bounds.maxX) state.bounds.maxX = wx;
  if (wy < state.bounds.minY) state.bounds.minY = wy;
  if (wy > state.bounds.maxY) state.bounds.maxY = wy;
  return { x: wx, y: wy };
}

/** Lineweight in mm: entity group 370, else the layer default. */
function resolveWidthMm(entity: DxfEntity, layerInfo: DxfLayerInfo | undefined): number | undefined {
  return entity.lineweightMm ?? layerInfo?.lineweightMm;
}

function emitEntities(entities: DxfEntity[], ctx: RenderCtx, state: ConvertState): void {
  for (const entity of entities) {
    if (entity.invisible) continue;

    const effLayerName = entity.layer === '0' && ctx.insertLayer ? ctx.insertLayer : entity.layer;
    const bucket = getBucket(state, effLayerName);
    const layerInfo = state.layerInfos.get(effLayerName);
    const color = resolveColor(entity, bucket.color, ctx);
    const colorOverride = color !== bucket.color ? color : undefined;
    const mirror = entity.extrusionZ < 0 ? -1 : 1;
    const dashed = isDashed(entity, layerInfo) || undefined;
    const widthMm = resolveWidthMm(entity, layerInfo);

    const pushPath = (pts: Array<{ x: number; y: number }>, closed: boolean): void => {
      if (pts.length < 2) return;
      bucket.paths.push({
        points: pts.map((p) => toWorld(state, ctx, p.x * mirror, p.y)),
        closed,
        color: colorOverride,
        dashed,
        widthMm,
      });
    };

    switch (entity.kind) {
      case 'line':
        // LINE coordinates are WCS; the OCS mirror does not apply.
        bucket.paths.push({
          points: [toWorld(state, ctx, entity.x1, entity.y1), toWorld(state, ctx, entity.x2, entity.y2)],
          closed: false,
          color: colorOverride,
          dashed,
          widthMm,
        });
        break;

      case 'polyline':
        pushPath(expandBulgedVertices(entity.vertices, entity.closed), entity.closed);
        break;

      case 'spline':
        pushPath(
          tessellateSpline(entity.degree, entity.knots, entity.controlPoints, entity.fitPoints),
          entity.closed,
        );
        break;

      case 'circle':
        pushPath(sampleCircle(entity.cx, entity.cy, entity.r), true);
        break;

      case 'arc': {
        // Mirrored OCS also mirrors angles: θ → 180° − θ.
        const start = mirror < 0 ? 180 - entity.endDeg : entity.startDeg;
        const end = mirror < 0 ? 180 - entity.startDeg : entity.endDeg;
        const pts = sampleArc(entity.cx * mirror, entity.cy, entity.r, start, end);
        if (pts.length >= 2) {
          bucket.paths.push({
            points: pts.map((p) => toWorld(state, ctx, p.x, p.y)),
            closed: false,
            color: colorOverride,
            dashed,
            widthMm,
          });
        }
        break;
      }

      case 'solid': {
        const ring = entity.corners.map((p) => toWorld(state, ctx, p.x * mirror, p.y));
        if (ring.length >= 3) {
          bucket.fills.push({ polygon: { outer: ring, holes: [] }, color: colorOverride, pattern: false });
        }
        break;
      }

      case 'ellipse':
        pushPath(
          sampleEllipse(
            entity.cx,
            entity.cy,
            entity.majorX,
            entity.majorY,
            entity.ratio,
            entity.startParam,
            entity.endParam,
          ),
          Math.abs(entity.endParam - entity.startParam) >= Math.PI * 2 - 1e-9,
        );
        break;

      case 'hatch': {
        if (entity.paths.length === 0) break;
        const rings = entity.paths
          .map((path) => expandBulgedVertices(path.vertices, true).map((p) => toWorld(state, ctx, p.x * mirror, p.y)))
          .filter((ring) => ring.length >= 3);
        if (rings.length === 0) break;
        // Largest ring is the outer boundary; the rest render as holes.
        let outerIdx = 0;
        let outerArea = -1;
        rings.forEach((ring, idx) => {
          const area = Math.abs(ringArea(ring));
          if (area > outerArea) {
            outerArea = area;
            outerIdx = idx;
          }
        });
        const polygon: Polygon2D = {
          outer: rings[outerIdx],
          holes: rings.filter((_, idx) => idx !== outerIdx),
        };
        bucket.fills.push({ polygon, color: colorOverride, pattern: !entity.solid });
        break;
      }

      case 'text': {
        if (!entity.text.trim()) break;
        const anchor = toWorld(state, ctx, entity.x * mirror, entity.y);
        const rad = (entity.rotationDeg * Math.PI) / 180;
        const tip = toWorld(state, ctx, (entity.x + Math.cos(rad)) * mirror, entity.y + Math.sin(rad));
        let dirX = tip.x - anchor.x;
        let dirY = tip.y - anchor.y;
        const len = Math.hypot(dirX, dirY);
        if (len > 1e-12) {
          dirX /= len;
          dirY /= len;
        } else {
          dirX = 1;
          dirY = 0;
        }
        const scaleEstimate = Math.sqrt(Math.abs(ctx.m[0] * ctx.m[3] - ctx.m[1] * ctx.m[2]));
        const text: DxfUnderlayText = {
          position: anchor,
          text: entity.text,
          height: entity.height * scaleEstimate * state.unitScale,
          dirX,
          dirY,
          align: entity.hAlign,
          valign: entity.vAlign,
          color: colorOverride,
        };
        bucket.texts.push(text);
        break;
      }

      case 'insert':
        emitInsert(entity, ctx, state, effLayerName, color);
        break;

      case 'dimension': {
        const block = entity.blockName ? state.doc.blocks.get(entity.blockName) : undefined;
        if (!block) {
          state.doc.skipped['DIMENSION'] = (state.doc.skipped['DIMENSION'] ?? 0) + 1;
          break;
        }
        if (ctx.depth >= MAX_BLOCK_DEPTH || ctx.stack.includes(block.name)) break;
        // Dimension block geometry is already in the dimension's WCS.
        emitEntities(block.entities, {
          m: ctx.m,
          byBlockColor: color,
          insertLayer: effLayerName,
          depth: ctx.depth + 1,
          stack: [...ctx.stack, block.name],
        }, state);
        break;
      }
    }
  }
}

function emitInsert(
  entity: Extract<DxfEntity, { kind: 'insert' }>,
  ctx: RenderCtx,
  state: ConvertState,
  effLayerName: string,
  resolvedColor: string,
): void {
  const block = state.doc.blocks.get(entity.blockName);
  if (!block) {
    state.warnings.push(`INSERT references missing block "${entity.blockName}".`);
    return;
  }
  if (ctx.depth >= MAX_BLOCK_DEPTH) {
    state.warnings.push(`Block nesting deeper than ${MAX_BLOCK_DEPTH} levels; "${entity.blockName}" truncated.`);
    return;
  }
  if (ctx.stack.includes(entity.blockName)) {
    state.warnings.push(`Recursive block reference "${entity.blockName}" skipped.`);
    return;
  }

  const mirror = entity.extrusionZ < 0 ? -1 : 1;
  const cols = Math.min(entity.columnCount, 1024);
  const rows = Math.min(entity.rowCount, 1024);

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (state.instanceCount >= MAX_BLOCK_INSTANCES) {
        if (!state.instanceCapHit) {
          state.instanceCapHit = true;
          state.warnings.push(`Block instance limit (${MAX_BLOCK_INSTANCES}) reached; remaining inserts ignored.`);
        }
        return;
      }
      state.instanceCount++;

      // insert translation ∘ rotation ∘ scale ∘ grid offset ∘ base-point shift
      let local = matTRS(
        entity.x * mirror,
        entity.y,
        mirror < 0 ? -entity.rotationDeg : entity.rotationDeg,
        entity.scaleX * mirror,
        entity.scaleY,
      );
      if (col !== 0 || row !== 0) {
        local = matMultiply(local, matTranslate(col * entity.columnSpacing, row * entity.rowSpacing));
      }
      local = matMultiply(local, matTranslate(-block.baseX, -block.baseY));

      emitEntities(block.entities, {
        m: matMultiply(ctx.m, local),
        byBlockColor: resolvedColor,
        insertLayer: effLayerName,
        depth: ctx.depth + 1,
        stack: [...ctx.stack, entity.blockName],
      }, state);
    }
  }
}

function ringArea(ring: Point2D[]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

// ═══════════════════════════════════════════════════════════════════════════
// PLACEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply a user placement to an underlay point in DRAWING space — i.e.
 * after the world → drawing mapping (`x_d = x - shiftX`,
 * `y_d = -(y - shiftY)` for a plan view). Rotation is counter-clockwise
 * as seen on the plan (drawing space renders with +y downward on screen,
 * hence the transposed rotation matrix).
 */
export function applyDxfPlacement(p: Point2D, placement: DxfPlacement): Point2D {
  const rad = (placement.rotationDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const x = p.x * placement.scale;
  const y = p.y * placement.scale;
  return {
    x: x * c + y * s + placement.offsetX,
    y: -x * s + y * c + placement.offsetY,
  };
}
