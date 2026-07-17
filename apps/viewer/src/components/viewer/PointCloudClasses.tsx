/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-LAS-class visibility toggles (#1783). Lists the classification
 * codes actually present in the loaded scans — aggregated from the
 * per-asset histograms the ingest paths write to the store — with the
 * ASPRS name and point count for each, and a checkbox bound to the
 * 256-bit `pointCloudClassMask`. Hidden classes are pushed behind the
 * near plane in the splat shader (classMask cull). Works like an
 * IfcPresentationLayer toggle, but for scan points.
 *
 * The colour swatches mirror `point-shader.wgsl.ts` so the UI stays
 * in sync with what the user actually sees on screen.
 */

import { useMemo } from 'react';
import { lasClassificationName } from '@ifc-lite/pointcloud';
import { useViewerStore } from '@/store';
import {
  ALL_POINT_CLOUD_CLASSES_VISIBLE,
  isPointCloudClassVisible,
} from '@/store/slices/pointCloudSlice';

/**
 * Classification palette — mirrors `classification_color()` in
 * `point-shader.wgsl.ts`. Codes without an entry render gray there
 * (the shader's `default` arm), so fall back to the same gray here.
 */
const CLASS_COLORS: ReadonlyMap<number, [number, number, number]> = new Map([
  [2,  [0.55, 0.40, 0.25]],
  [3,  [0.55, 0.85, 0.45]],
  [4,  [0.30, 0.75, 0.30]],
  [5,  [0.10, 0.45, 0.15]],
  [6,  [0.95, 0.55, 0.20]],
  [7,  [0.95, 0.20, 0.20]],
  [8,  [0.20, 0.85, 0.95]],
  [9,  [0.20, 0.40, 0.95]],
  [10, [0.55, 0.20, 0.85]],
  [11, [0.30, 0.30, 0.30]],
  [13, [0.95, 0.85, 0.20]],
  [14, [0.95, 0.95, 0.50]],
  [15, [0.20, 0.20, 0.55]],
  [16, [0.30, 0.65, 0.65]],
  [17, [0.85, 0.70, 0.50]],
  [18, [0.95, 0.20, 0.20]],
]);
const DEFAULT_CLASS_COLOR: [number, number, number] = [0.65, 0.65, 0.65];

export function PointCloudClasses() {
  const mask = useViewerStore((s) => s.pointCloudClassMask);
  const countsByAsset = useViewerStore((s) => s.pointCloudClassCounts);
  const toggle = useViewerStore((s) => s.togglePointCloudClass);
  const setMask = useViewerStore((s) => s.setPointCloudClassMask);

  // Sum the per-asset histograms into one classId → count list. Assets
  // report their counts independently (streamed scans by handle id,
  // inline IFCx assets under 'ifcx') so removal keeps this honest.
  const present = useMemo(() => {
    const totals = new Map<number, number>();
    for (const assetCounts of Object.values(countsByAsset)) {
      for (const [id, count] of Object.entries(assetCounts)) {
        const classId = Number(id);
        totals.set(classId, (totals.get(classId) ?? 0) + count);
      }
    }
    return [...totals.entries()]
      .map(([classId, count]) => ({ classId, count }))
      .sort((a, b) => a.classId - b.classId);
  }, [countsByAsset]);

  const visibleCount = useMemo(
    () => present.filter((c) => isPointCloudClassVisible(mask, c.classId)).length,
    [present, mask],
  );
  const allOn = visibleCount === present.length;

  return (
    <details className="flex flex-col gap-0.5">
      <summary className="text-[9px] uppercase text-muted-foreground tracking-wider cursor-pointer select-none">
        Classes {!allOn && (
          <span className="text-[9px] normal-case text-amber-500"> · {visibleCount} of {present.length} visible</span>
        )}
      </summary>
      {present.length === 0 ? (
        <span className="text-[10px] text-muted-foreground px-1 py-0.5 leading-tight">
          No classification data in the loaded scans.
        </span>
      ) : (
        <div className="flex flex-col gap-0.5 mt-1 max-h-40 overflow-y-auto pr-1">
          {!allOn && (
            <button
              type="button"
              onClick={() => setMask([...ALL_POINT_CLOUD_CLASSES_VISIBLE])}
              className="text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted px-1 py-0.5 rounded text-left"
            >
              Show all
            </button>
          )}
          {present.map(({ classId, count }) => {
            const visible = isPointCloudClassVisible(mask, classId);
            const label = lasClassificationName(classId);
            return (
              <label
                key={classId}
                className="flex items-center gap-1.5 text-[10px] cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
              >
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={() => toggle(classId)}
                  className="accent-teal-600"
                  aria-label={`Toggle ${label} (class ${classId})`}
                />
                <span
                  className="inline-block h-3 w-3 rounded-sm shrink-0 border border-foreground/10"
                  style={{ backgroundColor: rgbCss(CLASS_COLORS.get(classId) ?? DEFAULT_CLASS_COLOR) }}
                  aria-hidden="true"
                />
                <span className="text-muted-foreground tabular-nums w-5 shrink-0">{classId}</span>
                <span className={visible ? 'text-foreground truncate' : 'text-muted-foreground line-through truncate'}>
                  {label}
                </span>
                <span className="ml-auto text-muted-foreground tabular-nums shrink-0">
                  {count.toLocaleString()}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </details>
  );
}

function rgbCss([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
