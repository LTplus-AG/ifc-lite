/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Pure, non-UI helpers `ExecutableCodeBlock.tsx` uses for console-log
 * formatting and viewport-screenshot compression. Split out purely to keep
 * `ExecutableCodeBlock.tsx` under its module-size budget (#4918 chat slice)
 * — none of this carries user-facing copy, so it sits outside the i18n
 * sweep. `levelPrefix`'s glyphs are symbols, not translatable prose.
 */

/** Format a log arg for display */
export function formatArg(a: unknown): string {
  if (typeof a === 'object' && a !== null) {
    try {
      return JSON.stringify(a, null, 2);
    } catch {
      return String(a);
    }
  }
  return String(a);
}

/** Level prefix for console lines */
export function levelPrefix(level: string): string {
  switch (level) {
    case 'error': return '✕';
    case 'warn': return '⚠';
    case 'info': return 'ℹ';
    default: return '›';
  }
}

export function captureCompressedCanvasImage(canvas: HTMLCanvasElement): string {
  const maxSide = 1400;
  const srcW = canvas.width || canvas.clientWidth || 0;
  const srcH = canvas.height || canvas.clientHeight || 0;
  if (srcW <= 0 || srcH <= 0) {
    return canvas.toDataURL('image/jpeg', 0.72);
  }

  const scale = Math.min(1, maxSide / Math.max(srcW, srcH));
  const outW = Math.max(1, Math.round(srcW * scale));
  const outH = Math.max(1, Math.round(srcH * scale));
  const out = document.createElement('canvas');
  out.width = outW;
  out.height = outH;
  const ctx = out.getContext('2d');
  if (!ctx) {
    return canvas.toDataURL('image/jpeg', 0.72);
  }
  ctx.drawImage(canvas, 0, 0, outW, outH);
  return out.toDataURL('image/jpeg', 0.72);
}
