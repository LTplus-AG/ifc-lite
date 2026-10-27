// SPDX-License-Identifier: MPL-2.0
import type { RetainedShapePart, RetainedShapeProduct } from '../../../wasm/pkg-retained/ifc-lite.js';

/** Absolute IFC Z-up metres, preserving the producer's f64 coordinates. */
export function worldPoints(part: RetainedShapePart): number[][] {
  const { positions: p, indices, worldFromObject: m } = part;
  if (p.length === 0 || p.length % 3 || indices.length === 0 || indices.length % 3 || m.length !== 16 ||
      !p.every(Number.isFinite) || !m.every(Number.isFinite) ||
      indices.some(i => i >= p.length / 3) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) {
    throw new Error('Invalid retained shape part; refusing partial product');
  }
  const points: number[][] = [];
  for (let i = 0; i < p.length; i += 3) {
    const point = [0, 1, 2].map(j => m[j] * p[i] + m[j + 4] * p[i + 1] + m[j + 8] * p[i + 2] + m[j + 12]);
    if (!point.every(Number.isFinite)) throw new Error('Nonfinite retained world coordinate');
    points.push(point);
  }
  return points;
}

export function partVolume(part: RetainedShapePart): number {
  const points = worldPoints(part), origin = points[0];
  let volume = 0;
  for (let i = 0; i < part.indices.length; i += 3) {
    const [a, b, c] = Array.from(part.indices.subarray(i, i + 3), index => points[index].map((v, j) => v - origin[j]));
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  if (!Number.isFinite(volume)) throw new Error('Nonfinite retained volume');
  return Math.abs(volume);
}

function fixed(value: number): string {
  if (Object.is(value, -0)) return '-0.000000';
  // Number.toFixed switches to exponent notation at 1e21; OBJ's contract is %.6f.
  if (Math.abs(value) >= 1e21) return `${BigInt(value)}.000000`;
  const text = value.toFixed(6);
  // Rust's %.6f uses ties-to-even; JS toFixed chooses away from zero. An
  // exactly representable half-micro-unit is an odd multiple of 1/128
  // (1e6 = 2^6 * 5^6). Power-of-two scaling tests that tie without rounding.
  const scaled = Math.abs(value) * 128, last = Number(text.at(-1));
  return Number.isInteger(scaled) && scaled % 2 === 1 && last % 2 === 1
    ? text.slice(0, -1) + String(last - 1) : text;
}

export function retainedObj(products: RetainedShapeProduct[]): string {
  const obligations = [...new Set(products.flatMap(p => p.obligationsUnmet))].sort();
  const lines = ['# ifc-lite OBJ export', '# units: metres (renderer Y-up frame, origin-folded world coords)',
    '# kernel: retained', `# retained shape-only: presentation obligations unmet: ${obligations.join(', ')}`,
    '# PresentationObligationsUnmet'];
  let base = 1;
  for (const product of products) {
    if (product.marker !== 'PresentationObligationsUnmet' || !product.obligationsUnmet.length || !product.parts.length ||
        !/^Ifc[A-Za-z0-9]+$/.test(product.ifcType) || !Number.isSafeInteger(product.expressId)) {
      throw new Error('Invalid retained shape-only product');
    }
    lines.push(`o ${product.ifcType}_${product.expressId}`, `g ${product.ifcType}_${product.expressId}`);
    for (const part of product.parts) {
      const points = worldPoints(part);
      for (const [x, y, z] of points) lines.push(`v ${fixed(x)} ${fixed(z)} ${fixed(-y)}`);
      for (let i = 0; i < part.indices.length; i += 3) {
        lines.push(`f ${part.indices[i] + base} ${part.indices[i + 1] + base} ${part.indices[i + 2] + base}`);
      }
      base += points.length;
    }
  }
  return `${lines.join('\n')}\n`;
}
