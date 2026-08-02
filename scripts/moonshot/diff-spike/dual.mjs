/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Vector forward-mode automatic differentiation over dual numbers.
 *
 * A Dual carries a scalar value `v` and a dense gradient vector `g` of
 * length N (the number of design parameters). Every arithmetic operation
 * propagates both simultaneously, so evaluating a scalar function once on
 * duals yields the exact analytic gradient with respect to all N inputs.
 *
 * Self-contained: no external dependencies. min/max are implemented
 * exactly (branch on value), which makes the differentiated function
 * piecewise smooth; at branch boundaries the derivative is the one-sided
 * derivative of the winning branch. This mirrors the piecewise nature of
 * the CSG/opening-clipping path it models.
 */

export class Dual {
  /**
   * @param {number} v scalar value
   * @param {Float64Array} g gradient vector (owned, not copied)
   */
  constructor(v, g) {
    this.v = v;
    this.g = g;
  }
}

/** Number of gradient slots; set once per battery/optimization run. */
let N = 0;

export function setDim(n) {
  N = n;
}

export function dim() {
  return N;
}

/** Lift a plain number to a constant Dual (zero gradient). */
export function konst(x) {
  return new Dual(x, new Float64Array(N));
}

/** Create the i-th design variable: value x, gradient = e_i. */
export function variable(x, i) {
  const g = new Float64Array(N);
  g[i] = 1;
  return new Dual(x, g);
}

function isDual(x) {
  return x instanceof Dual;
}

/** Coerce number|Dual to Dual. */
function lift(x) {
  return isDual(x) ? x : konst(x);
}

export function add(a, b) {
  const A = lift(a), B = lift(b);
  const g = new Float64Array(N);
  for (let i = 0; i < N; i++) g[i] = A.g[i] + B.g[i];
  return new Dual(A.v + B.v, g);
}

export function sub(a, b) {
  const A = lift(a), B = lift(b);
  const g = new Float64Array(N);
  for (let i = 0; i < N; i++) g[i] = A.g[i] - B.g[i];
  return new Dual(A.v - B.v, g);
}

export function mul(a, b) {
  const A = lift(a), B = lift(b);
  const g = new Float64Array(N);
  for (let i = 0; i < N; i++) g[i] = A.g[i] * B.v + A.v * B.g[i];
  return new Dual(A.v * B.v, g);
}

export function div(a, b) {
  const A = lift(a), B = lift(b);
  const g = new Float64Array(N);
  const inv = 1 / B.v;
  const q = A.v * inv;
  for (let i = 0; i < N; i++) g[i] = (A.g[i] - q * B.g[i]) * inv;
  return new Dual(q, g);
}

/** Multiply by a plain scalar constant (cheap path). */
export function scale(a, s) {
  const A = lift(a);
  const g = new Float64Array(N);
  for (let i = 0; i < N; i++) g[i] = A.g[i] * s;
  return new Dual(A.v * s, g);
}

/** Exact max: value branch decides which gradient propagates. */
export function max2(a, b) {
  const A = lift(a), B = lift(b);
  return A.v >= B.v ? A : B;
}

/** Exact min. */
export function min2(a, b) {
  const A = lift(a), B = lift(b);
  return A.v <= B.v ? A : B;
}

/** max(0, a), the constraint-violation hinge. */
export function relu(a) {
  const A = lift(a);
  return A.v > 0 ? A : konst(0);
}

/** Sum a list of Dual|number. */
export function sum(xs) {
  let acc = konst(0);
  for (const x of xs) acc = add(acc, x);
  return acc;
}

export function value(a) {
  return isDual(a) ? a.v : a;
}

export function grad(a) {
  return isDual(a) ? a.g : new Float64Array(N);
}

/**
 * Deterministic PRNG (mulberry32). Same seed, same battery, forever.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
