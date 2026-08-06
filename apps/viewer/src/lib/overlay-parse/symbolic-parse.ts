/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Symbolic-annotation (IfcAnnotation / IfcGridAxis) parse, extracted from
 * `hooks/useSymbolicAnnotations.ts` so it can run off the React tree.
 *
 * The walk takes a plain `Uint8Array` source plus the two spatial-hierarchy
 * lookups it needs, deliberately NOT an `IfcDataStore`: a worker module cannot
 * import a React hook file, and the store is not structured-cloneable. The
 * `hasEntityType` pre-filter stays at the call site because it reads
 * `store.entityIndex`, which is not part of this input.
 *
 * The parse is split at the WASM-collection seam (#2183):
 *
 *   - `collectFlatSymbolic` (`symbolic-flat.ts`) walks the WASM handles and
 *     flattens them into transferable typed arrays. WASM-bound, worker-side.
 *   - `buildParseResult` turns those arrays into the `ParseResult` the overlay
 *     renders: tessellation, text decoding, and storey bucketing. Pure JS,
 *     main-thread-side.
 *
 * `parseSymbolicAnnotations` is the two composed on one thread. It stays the
 * reference implementation — the golden-digest test drives it — so the worker
 * path is correct exactly when it reproduces this composition.
 */

import { GeometryProcessor } from '@ifc-lite/geometry';
import { decodeIfcString } from '@ifc-lite/encoding';
import {
  collectFlatSymbolic,
  createEmptyFlatSymbolic,
  type FlatSymbolic,
} from './symbolic-flat.js';
import {
  circleToSegments,
  createEmptyParseResult,
  polylineToSegments,
  type AnnotationFill2D,
  type AnnotationsForStorey,
  type AnnotationText2D,
  type ParseResult,
} from './symbolic-shapes.js';

// The result contracts and pure helpers live next door so both modules stay
// under the ~400 line house limit. Re-exported so this stays the single import
// site for consumers of the parse.
export * from './symbolic-shapes.js';
export * from './symbolic-flat.js';

/** Verbose annotation tracing, opt-in via localStorage and therefore off by
 *  default; useful when triaging "no annotations visible" reports. */
export const debugEnabled = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem('IFC_ANNOTATIONS_DEBUG') === '1';
  } catch (error) {
    // Storage access throws in some privacy modes. A debug flag is never worth
    // failing a parse over, but AGENTS.md forbids swallowing it silently.
    // eslint-disable-next-line no-console
    console.warn('[annotations] could not read the debug flag:', error);
    return false;
  }
};

/** Everything the symbolic-annotation walk needs off an `IfcDataStore`. */
export interface SymbolicParseInput {
  source: Uint8Array;
  /** store.spatialHierarchy?.elementToStorey */
  elementToStorey?: ReadonlyMap<number, number>;
  /** store.spatialHierarchy?.storeyElevations */
  storeyElevations?: ReadonlyMap<number, number>;
}

/** The spatial-hierarchy half of {@link SymbolicParseInput}. Structured-clone
 *  friendly, so the main thread can hold it while the worker parses. */
export interface SymbolicHierarchyInput {
  elementToStorey?: ReadonlyMap<number, number>;
  storeyElevations?: ReadonlyMap<number, number>;
}

/**
 * Assemble the renderable `ParseResult` from a flattened collection.
 *
 * Main-thread half of the split: tessellation, STEP text decoding, and storey
 * bucketing. Takes no WASM handle, so the worker can hand `flat` over a
 * `postMessage` and this runs unchanged on the other side.
 */
export function buildParseResult(
  flat: FlatSymbolic,
  hierarchy: SymbolicHierarchyInput,
): ParseResult {
  const result: ParseResult = createEmptyParseResult();
  const elementToStorey = hierarchy.elementToStorey;
  const storeyElevations = hierarchy.storeyElevations;

  // Resolve a bucket by elevation rather than by storey id.
  //
  // The legacy path used `elementToStorey` exclusively — which breaks for
  // 3DEXPERIENCE / IfcPlusPlus exports whose `IfcRelAggregates` leaves
  // storeys orphaned so `SpatialHierarchyBuilder` reports "No storeys
  // found". Those files still encode the elevation on each item's
  // geometry (the IfcCartesianPoint.Z), which the WASM extractor now
  // surfaces as `primitive.worldY`. Bucketing by Y means every annotation
  // lands at the right floor regardless of whether the spatial hierarchy
  // could be built.
  //
  // Priority: explicit primitive worldY → fall back to storey-table
  // elevation → null (loose bucket, renders at fallbackY).
  //
  // Bucket keys are millimetre-rounded Y so two storeys 1mm apart still
  // collapse to one bucket — that's the precision Revit etc. round to.
  const ensureBucket = (
    expressId: number,
    primitiveWorldY: number,
    ifcType: string,
  ): AnnotationsForStorey | null => {
    let effectiveY: number | null = null;
    if (Number.isFinite(primitiveWorldY) && primitiveWorldY !== 0) {
      effectiveY = primitiveWorldY;
    } else {
      const storeyId = elementToStorey?.get(expressId);
      if (storeyId !== undefined) {
        const elev = storeyElevations?.get(storeyId);
        if (typeof elev === 'number' && Number.isFinite(elev)) effectiveY = elev;
      }
    }
    if (effectiveY === null) return null;
    const key = Math.round(effectiveY * 1000);
    // Issue #862: IfcGridAxis primitives land in a parallel bucket
    // collection so the renderer can section-clip + visibility-toggle
    // them independently of IfcAnnotation (text/dimension symbols).
    const storeyMap = ifcType === 'IfcGridAxis' ? result.gridByStorey : result.byStorey;
    let bucket = storeyMap.get(key);
    if (!bucket) {
      bucket = {
        storeyId: key,
        storeyElevation: effectiveY,
        lines: [],
        texts: [],
        fills: [],
      };
      storeyMap.set(key, bucket);
    }
    return bucket;
  };

  const typeNames = flat.typeNames;

  for (let i = 0; i < flat.polyOwner.length; i++) {
    const ifcType = typeNames[flat.polyType[i]];
    const expressId = flat.polyOwner[i];
    const bucket = ensureBucket(expressId, flat.polyWorldY[i], ifcType);
    const looseTarget = ifcType === 'IfcGridAxis' ? result.gridLoose : result.loose;
    const out = bucket ? bucket.lines : looseTarget;
    // The points are consumed synchronously here (not stored), so a subarray
    // view over the shared buffer is enough — no copy needed.
    const start = flat.polyStart[i];
    const pointCount = flat.polyStart[i + 1] - start;
    const points = flat.polyPoints.subarray(start * 2, (start + pointCount) * 2);
    polylineToSegments(points, pointCount, (flat.polyFlags[i] & 1) !== 0, out, expressId);
  }

  for (let i = 0; i < flat.circleOwner.length; i++) {
    const ifcType = typeNames[flat.circleType[i]];
    const expressId = flat.circleOwner[i];
    const bucket = ensureBucket(expressId, flat.circleWorldY[i], ifcType);
    const looseTarget = ifcType === 'IfcGridAxis' ? result.gridLoose : result.loose;
    const out = bucket ? bucket.lines : looseTarget;
    circleToSegments(
      flat.circleCenterX[i],
      flat.circleCenterY[i],
      flat.circleRadius[i],
      flat.circleStartAngle[i],
      flat.circleEndAngle[i],
      (flat.circleFlags[i] & 1) !== 0,
      out,
      expressId,
    );
  }

  for (let i = 0; i < flat.textOwner.length; i++) {
    const ifcType = typeNames[flat.textType[i]];
    const expressId = flat.textOwner[i];
    // Skip empty literals so the renderer doesn't waste an instance slot.
    // Decode STEP escapes — `\X2\NNNN\X0\` (UTF-16 hex code units) and
    // `\X\NN` (Latin-1 hex byte). The Rust parser intentionally passes
    // the literal through verbatim; this is where the JS encoding
    // package gets applied. Without it, non-ASCII annotation labels
    // (e.g. CJK content) render as raw escape sequences in the atlas.
    const decoded = decodeIfcString(flat.textContent[i]);
    if (decoded.length === 0) continue;

    // Multi-line split: IfcTextLiteralWithExtent.SizeInY is the LAYOUT BOX
    // height, not the glyph cap height. The Rust extractor multiplies
    // SizeInY × 0.7 to recover a single-line cap; for multi-line literals
    // we further divide by line count and stack lines downward in world-Y.
    // Source: IFC4 spec — IfcPlanarExtent describes the bounding box of
    // the typeset string; one literal per line is the conventional
    // rendering model (matches BIMvision / Solibri / Revit).
    const lines = decoded.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const height = flat.textHeight[i];
    const perLineHeight = lines.length > 1 ? height / lines.length : height;
    // Industry-standard line-spacing (CSS line-height ≈ 1.2). Picks up
    // a little air between rows so descenders don't kiss the next cap.
    const lineSpacing = perLineHeight * 1.2;
    const bucket = ensureBucket(expressId, flat.textWorldY[i], ifcType);
    const looseTextTarget = ifcType === 'IfcGridAxis' ? result.gridLooseTexts : result.looseTexts;
    // All annotation text — grid bubbles, dimension callouts, leader labels —
    // billboards to the camera so it stays legible in any view orientation
    // (top-down, eye-level, oblique). The shader rebuilds the quad in the
    // screen-aligned basis at render time. Authored orientation is intentionally
    // dropped: at oblique viewing angles, flat-in-plane text becomes a smeared
    // sliver of pixels (issue #812). Anchor + alignment are preserved, so each
    // label still sits at its authored insertion point.
    // Read per-instance style metadata. WASM emits these for grid
    // bubble parts (● fill / ○ outline / tag) and reserves them for
    // future IfcTextStyle resolution on regular annotation text.
    const colorA = flat.textColor[i * 4 + 3];
    const hasColor = colorA > 0;
    const textColor: [number, number, number, number] | undefined = hasColor
      ? [flat.textColor[i * 4], flat.textColor[i * 4 + 1], flat.textColor[i * 4 + 2], colorA]
      : undefined;
    const rawTargetPx = flat.textTargetPx[i];
    const targetPx = rawTargetPx > 0 ? rawTargetPx : undefined;
    const alignment = flat.textAlignment[i];
    for (let li = 0; li < lines.length; li++) {
      const t2d: AnnotationText2D = {
        x: flat.textX[i],
        y: flat.textY[i],
        dirX: flat.textDirX[i],
        dirY: flat.textDirY[i],
        height: perLineHeight,
        content: lines[li],
        alignment,
        lineYOffset: -li * lineSpacing,
        billboard: true,
        color: textColor,
        targetPx,
        ownerId: expressId,
      };
      (bucket ? bucket.texts : looseTextTarget).push(t2d);
    }
  }

  for (let i = 0; i < flat.fillOwner.length; i++) {
    const ifcType = typeNames[flat.fillType[i]];
    const expressId = flat.fillOwner[i];
    // The ring vertices and hole table are STORED into f2d (they outlive this
    // iteration), so slice them out of the shared buffers rather than viewing
    // them. Element types match the AnnotationFill2D fields.
    const points = flat.fillPoints.slice(flat.fillPointStart[i], flat.fillPointStart[i + 1]);
    if (points.length < 6) continue; // <3 vertices = no polygon
    const holesOffsets = flat.fillHoles.slice(flat.fillHoleStart[i], flat.fillHoleStart[i + 1]);
    const f2d: AnnotationFill2D = {
      points,
      holesOffsets,
      color: [
        flat.fillColor[i * 4],
        flat.fillColor[i * 4 + 1],
        flat.fillColor[i * 4 + 2],
        flat.fillColor[i * 4 + 3],
      ],
      ownerId: expressId,
      hatching: (flat.fillFlags[i] & 1) !== 0
        ? {
            spacing: flat.fillHatch[i * 4],
            angle: flat.fillHatch[i * 4 + 1],
            angleSecondary: Number.isNaN(flat.fillHatch[i * 4 + 2]) ? null : flat.fillHatch[i * 4 + 2],
            lineWidth: flat.fillHatch[i * 4 + 3],
          }
        : undefined,
    };
    const bucket = ensureBucket(expressId, flat.fillWorldY[i], ifcType);
    const looseFillTarget = ifcType === 'IfcGridAxis' ? result.gridLooseFills : result.looseFills;
    (bucket ? bucket.fills : looseFillTarget).push(f2d);
  }

  return result;
}

export async function parseSymbolicAnnotations(
  input: SymbolicParseInput,
): Promise<ParseResult> {
  const source = input.source;
  if (!source || source.byteLength === 0) {
    if (debugEnabled()) console.log('[annotations] skip: missing/empty source');
    return createEmptyParseResult();
  }

  const processor = new GeometryProcessor();
  // An empty flatten builds the empty ParseResult, so the "no collection" and
  // "empty collection" exits need no separate early return.
  let flat: FlatSymbolic = createEmptyFlatSymbolic();
  try {
    await processor.init();
    // SymbolicRepresentationCollection and each getPolyline/getCircle/getText/
    // getFill item are wasm-bindgen handles owning WASM memory — free them
    // deterministically (AGENTS.md §7). Leaking them to GC lets the
    // FinalizationRegistry free them later against an already-grown/reused
    // shared dlmalloc heap, corrupting the allocator free-list.
    const collection = processor.parseSymbolicRepresentations(source);
    if (debugEnabled()) {
      console.log(
        `[annotations] parsed ${source.byteLength} bytes →`,
        collection
          ? `${collection.polylineCount} polylines, ${collection.circleCount} circles, ${collection.textCount} texts, ${collection.fillCount} fills`
          : 'null',
      );
    }
    if (collection) {
      try {
        if (!collection.isEmpty) flat = collectFlatSymbolic(collection);
      } finally {
        collection.free();
      }
    }
  } finally {
    processor.dispose();
  }

  return buildParseResult(flat, input);
}
