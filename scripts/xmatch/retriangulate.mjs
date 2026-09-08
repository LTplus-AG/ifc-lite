/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The CALIBRATION mutation: re-discretize an element's curved boundary.
 *
 * Every arc in the chosen element's profile (`IfcTrimmedCurve` on an
 * `IfcCircle`) is replaced by an `IfcPolyline` sampled from the SAME arc at a
 * different angular step. Nothing else about the element changes: same
 * placement, same extrusion, same properties, same nominal shape to a human
 * reader — which is exactly what a foreign round trip does to a curve, because
 * no two exporters agree on how finely to sample one.
 *
 * **This is the stratum that must score imperfectly.** The geometry hash is a
 * world-space QUANTIZED TRIANGLE MULTISET (`rust/geometry/src/geom_hash.rs`):
 * it hashes the triangles a mesher produced, not the surface they approximate.
 * Two different samplings of one arc therefore produce different triangles and
 * a different hash, with certainty rather than probability — so tier 1 (the
 * geometry-hash sub-bucket) provably CANNOT pair these elements, and the
 * harness fails if it reports that it did. A pass at 100% everywhere would mean
 * the instrument had stopped being able to tell "matched" from "should have
 * missed".
 *
 * The lower tiers are expected to recover them: the data hash is untouched, so
 * the pair still shares a bucket and reaches the 1:1 residue, where an unequal
 * geometry hash reads as `reshaped` (the chord polygon is inscribed, so the
 * box shrinks by up to the sagitta).
 *
 * The angular step is deliberately not a divisor of anything the kernel uses.
 */

import { isExclusivelyOwnedBy, reachable, structuralRefCount, PRODUCT_REPRESENTATION } from './edits.mjs';
import { real, splitArgs } from './step-file.mjs';

/** Sampling step for the replacement polyline, in degrees. */
const RESAMPLE_STEP_DEGREES = 7.3;

/**
 * Radians per unit of the file's plane-angle measure.
 *
 * A STEP `IFCPARAMETERVALUE` trim on a circle is expressed in the model's plane
 * angle unit, and most authoring tools write DEGREES via an
 * `IfcConversionBasedUnit`. Reading 92.3 as radians would sample fourteen turns
 * of the wrong arc, so the unit is read from the file rather than guessed.
 */
export function planeAngleFactor(file) {
  for (const statement of file.statements) {
    if (statement.type !== 'IFCCONVERSIONBASEDUNIT') continue;
    const parts = splitArgs(statement.args);
    if (!parts[1]?.includes('PLANEANGLEUNIT')) continue;
    if (/degree/i.test(parts[2] ?? '')) return Math.PI / 180;
  }
  return 1;
}

/** Coordinates of an `IfcCartesianPoint` / `IfcDirection` argument list. */
function tuple(statement) {
  const inner = statement.args.trim().replace(/^\(/, '').replace(/\)$/, '');
  return splitArgs(inner).map((value) => Number.parseFloat(value));
}

function refOf(part) {
  const match = /^#(\d+)$/.exec(String(part).trim());
  return match ? Number.parseInt(match[1], 10) : undefined;
}

/** The single `IFCPARAMETERVALUE(x)` inside a trim set, in radians. */
function trimAngle(part, factor) {
  const match = /IFCPARAMETERVALUE\s*\(\s*(-?[\d.eE+-]+)\s*\)/i.exec(String(part));
  return match ? Number.parseFloat(match[1]) * factor : undefined;
}

/**
 * The element's `Body` shape representations, and only when it owns them
 * exclusively.
 *
 * Two filters, both load-bearing:
 *
 * - **`Body` only.** An arc in an `Axis`, `FootPrint` or `Profile`
 *   representation is never meshed, so resampling it changes the file and
 *   NOTHING about the geometry the hash sees. The first run of this fixture
 *   found exactly that: half the `retriangulated` elements matched at tier 1
 *   with an identical hash, because their arcs were in a representation the
 *   mesher does not read. That is the calibration stratum catching a defect in
 *   its own mutation, which is what it is for.
 * - **exclusively owned.** A shape reached through an `IfcMappedItem`, or a
 *   `IfcProductDefinitionShape` with more than one referrer, is shared with
 *   other occurrences; resampling it would silently mutate elements the answer
 *   key calls untouched.
 */
function ownBodyRepresentations(index, productId) {
  const product = index.byId.get(productId);
  if (!product) return [];
  const shapeId = refOf(splitArgs(product.args)[PRODUCT_REPRESENTATION]);
  if (shapeId === undefined) return [];
  if (structuralRefCount(index, shapeId) !== 1) return [];
  const shape = index.byId.get(shapeId);
  if (!shape) return [];
  const bodies = [];
  for (const id of reachable(index, [shapeId])) {
    const statement = index.byId.get(id);
    if (statement?.type === 'IFCMAPPEDITEM') return [];
    if (statement?.type !== 'IFCSHAPEREPRESENTATION') continue;
    const identifier = splitArgs(statement.args)[1];
    if (/^'Body'$/i.test(String(identifier).trim())) bodies.push(id);
  }
  return bodies;
}

/**
 * Every `IfcTrimmedCurve` on an `IfcCircle` under this element's own body,
 * with a 2D placement and parameter trims — the ones this module can resample.
 *
 * Owning the shape is necessary but NOT sufficient, and the difference is a
 * real defect this check closes: profiles and curves are shared aggressively in
 * IFC, so an element can own its `IfcProductDefinitionShape` outright and still
 * reach an `IfcTrimmedCurve` that a dozen other occurrences also reach.
 * `retriangulateElement` rewrites the arc IN PLACE, so a shared one would
 * re-sample geometry the answer key calls untouched — the same class of leak
 * that the feature/host rules and `exclusiveSolids` already guard against, and
 * the same one this module's own header claims to be free of. Each arc is
 * therefore proved exclusively owned all the way up to the element's shape.
 */
export function resampleableArcs(index, productId) {
  const bodies = ownBodyRepresentations(index, productId);
  if (bodies.length === 0) return [];
  const shapeId = refOf(splitArgs(index.byId.get(productId).args)[PRODUCT_REPRESENTATION]);
  const arcs = [];
  for (const id of reachable(index, bodies)) {
    const statement = index.byId.get(id);
    if (!statement || statement.type !== 'IFCTRIMMEDCURVE') continue;
    const args = splitArgs(statement.args);
    const circle = index.byId.get(refOf(args[0]));
    if (!circle || circle.type !== 'IFCCIRCLE') continue;
    const placement = index.byId.get(refOf(splitArgs(circle.args)[0]));
    if (!placement || placement.type !== 'IFCAXIS2PLACEMENT2D') continue;
    if (!isExclusivelyOwnedBy(index, id, shapeId)) continue;
    arcs.push(id);
  }
  return arcs;
}

/**
 * Replace every resampleable arc under `productId` with a polyline through
 * points ON the same arc, sampled at {@link RESAMPLE_STEP_DEGREES}.
 *
 * The trimmed-curve statement is rewritten IN PLACE (same express id, new type
 * and arguments) so every reference to it — the composite-curve segment that
 * owns it, and the profile that owns that — stays valid without touching a
 * single other statement.
 *
 * Returns the number of arcs converted.
 */
export function retriangulateElement(file, index, productId, angleFactor) {
  let converted = 0;
  for (const arcId of resampleableArcs(index, productId)) {
    const arc = index.byId.get(arcId);
    const args = splitArgs(arc.args);
    const circle = index.byId.get(refOf(args[0]));
    const [placementRef, radiusText] = splitArgs(circle.args);
    const radius = Number.parseFloat(radiusText);
    const placement = index.byId.get(refOf(placementRef));
    const placementParts = splitArgs(placement.args);
    const centre = tuple(index.byId.get(refOf(placementParts[0])));
    const directionId = refOf(placementParts[1]);
    const direction = directionId === undefined ? [1, 0] : tuple(index.byId.get(directionId));

    const start = trimAngle(args[1], angleFactor);
    const end = trimAngle(args[2], angleFactor);
    if (start === undefined || end === undefined || !Number.isFinite(radius)) continue;

    const increasing = !String(args[3]).includes('.F.');
    let sweep = end - start;
    // Normalize into the direction the sense flag declares; a zero sweep means
    // the full circle, which is how STEP writes t1 == t2.
    while (increasing && sweep <= 0) sweep += 2 * Math.PI;
    while (!increasing && sweep >= 0) sweep -= 2 * Math.PI;

    const length = Math.hypot(direction[0], direction[1]) || 1;
    const ux = direction[0] / length;
    const uy = direction[1] / length;
    const steps = Math.max(
      3,
      Math.ceil(Math.abs(sweep) / ((RESAMPLE_STEP_DEGREES * Math.PI) / 180)),
    );

    const pointIds = [];
    for (let step = 0; step <= steps; step++) {
      const angle = start + (sweep * step) / steps;
      const cos = Math.cos(angle) * radius;
      const sin = Math.sin(angle) * radius;
      const x = centre[0] + cos * ux - sin * uy;
      const y = centre[1] + cos * uy + sin * ux;
      const point = { id: index.nextId++, type: 'IFCCARTESIANPOINT', args: `(${real(x)},${real(y)})`, raw: '' };
      file.statements.push(point);
      index.byId.set(point.id, point);
      pointIds.push(point.id);
    }

    arc.type = 'IFCPOLYLINE';
    arc.args = `(${pointIds.map((id) => `#${id}`).join(',')})`;
    converted++;
  }
  return converted;
}
