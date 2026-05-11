/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Per-ASPRS-class visibility toggles. Renders an inline list of every
 * known LAS 1.4 standard class with a checkbox bound to the
 * `pointCloudClassMask` bitmask. Hidden classes are pushed behind the
 * near plane in the splat shader (`flags.w` cull).
 *
 * The colour swatches mirror `point-shader.wgsl.ts` so the UI stays
 * in sync with what the user actually sees on screen.
 */

import { useViewerStore } from '@/store';

interface ClassEntry {
  id: number;
  label: string;
  rgb: [number, number, number];
}

const CLASSES: ClassEntry[] = [
  { id: 0,  label: 'Never classified',   rgb: [0.65, 0.65, 0.65] },
  { id: 1,  label: 'Unclassified',       rgb: [0.65, 0.65, 0.65] },
  { id: 2,  label: 'Ground',             rgb: [0.55, 0.40, 0.25] },
  { id: 3,  label: 'Low vegetation',     rgb: [0.55, 0.85, 0.45] },
  { id: 4,  label: 'Medium vegetation',  rgb: [0.30, 0.75, 0.30] },
  { id: 5,  label: 'High vegetation',    rgb: [0.10, 0.45, 0.15] },
  { id: 6,  label: 'Building',           rgb: [0.95, 0.55, 0.20] },
  { id: 7,  label: 'Low point (noise)',  rgb: [0.95, 0.20, 0.20] },
  { id: 9,  label: 'Water',              rgb: [0.20, 0.40, 0.95] },
  { id: 10, label: 'Rail',               rgb: [0.55, 0.20, 0.85] },
  { id: 11, label: 'Road surface',       rgb: [0.30, 0.30, 0.30] },
  { id: 13, label: 'Wire — guard',       rgb: [0.95, 0.85, 0.20] },
  { id: 14, label: 'Wire — conductor',   rgb: [0.95, 0.95, 0.50] },
  { id: 15, label: 'Transmission tower', rgb: [0.20, 0.20, 0.55] },
  { id: 16, label: 'Wire-structure',     rgb: [0.30, 0.65, 0.65] },
  { id: 17, label: 'Bridge deck',        rgb: [0.85, 0.70, 0.50] },
  { id: 18, label: 'High noise',         rgb: [0.95, 0.20, 0.20] },
];

const ALL_VISIBLE = 0xFFFFFFFF;

export function PointCloudClasses() {
  const mask = useViewerStore((s) => s.pointCloudClassMask);
  const toggle = useViewerStore((s) => s.togglePointCloudClass);
  const setMask = useViewerStore((s) => s.setPointCloudClassMask);
  const allOn = (mask >>> 0) === ALL_VISIBLE;
  return (
    <details className="flex flex-col gap-0.5">
      <summary className="text-[9px] uppercase text-muted-foreground tracking-wider cursor-pointer select-none">
        Classes {!allOn && (
          <span className="text-[9px] normal-case text-amber-500"> · {countSet(mask)} of 32 visible</span>
        )}
      </summary>
      <div className="flex flex-col gap-0.5 mt-1 max-h-40 overflow-y-auto pr-1">
        <button
          type="button"
          onClick={() => setMask(ALL_VISIBLE)}
          className="text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted px-1 py-0.5 rounded text-left"
        >
          Show all
        </button>
        {CLASSES.map((c) => {
          const visible = ((mask >>> c.id) & 1) !== 0;
          return (
            <label
              key={c.id}
              className="flex items-center gap-1.5 text-[10px] cursor-pointer hover:bg-muted/40 rounded px-1 py-0.5"
            >
              <input
                type="checkbox"
                checked={visible}
                onChange={() => toggle(c.id)}
                className="accent-teal-600"
                aria-label={`Toggle ${c.label}`}
              />
              <span
                className="inline-block h-3 w-3 rounded-sm shrink-0 border border-foreground/10"
                style={{ backgroundColor: rgbCss(c.rgb) }}
                aria-hidden="true"
              />
              <span className="text-muted-foreground tabular-nums w-4 shrink-0">{c.id}</span>
              <span className={visible ? 'text-foreground truncate' : 'text-muted-foreground line-through truncate'}>
                {c.label}
              </span>
            </label>
          );
        })}
      </div>
    </details>
  );
}

function countSet(mask: number): number {
  // Hamming weight via Brian Kernighan's algorithm. JS bitwise ops
  // are 32-bit so we naturally cover the full ASPRS range.
  let n = mask >>> 0;
  let count = 0;
  while (n !== 0) {
    n &= n - 1;
    count++;
  }
  return count;
}

function rgbCss([r, g, b]: [number, number, number]): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}
