/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What a Speckle receive did NOT write, by name and count.
 *
 * Same contract as the LandXML mapping's refusals (`@ifc-lite/create`
 * `landxml/refusals.ts`): nothing is dropped silently. "14 RevitElement
 * objects have no v1 mapping" is actionable; an element that is simply
 * absent from the IFC is not even noticeable.
 */

export type SpeckleRefusalReason =
  /** The object's type has no v1 mapping at all. */
  | 'unmapped-type'
  /** A mapped type whose geometry v1 cannot reproduce (curved, sloped, slanted, rotated, …). */
  | 'geometry'
  /** A mapped type missing a dimension its IFC builder needs (thickness, section size, height). */
  | 'missing-dimension'
  /** A floor or roof with openings, which v1 would fill in. */
  | 'openings'
  /** No length unit to convert from. */
  | 'no-units'
  /** Excluded by the node's `level` filter. */
  | 'other-level'
  /** The IFC writer rejected the mapped element. */
  | 'write-failed'
  /** Display meshes of written elements, which are not carried (the body is rebuilt parametrically). */
  | 'display-meshes'
  /** Property entries that are not scalar parameters (compound structure layers, nested tables). */
  | 'non-parameter-entries';

export interface SpeckleRefusal {
  /** The most-derived `speckle_type` link, e.g. `RevitWall`. */
  readonly speckleType: string;
  readonly reason: SpeckleRefusalReason;
  readonly count: number;
  readonly message: string;
  /** Up to five Speckle object ids, so the operator can find them. */
  readonly examples: readonly string[];
}

const MAX_EXAMPLES = 5;

interface Bucket {
  speckleType: string;
  reason: SpeckleRefusalReason;
  detail: string;
  count: number;
  examples: string[];
}

export class RefusalLog {
  private readonly buckets = new Map<string, Bucket>();

  /** Count `n` refused things of one type, for one reason, with one explanation. */
  add(speckleType: string, reason: SpeckleRefusalReason, detail: string, id: string | undefined, n = 1): void {
    if (n <= 0) return;
    const key = `${speckleType}\u0000${reason}\u0000${detail}`;
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { speckleType, reason, detail, count: 0, examples: [] }));
    b.count += n;
    if (id !== undefined && b.examples.length < MAX_EXAMPLES && !b.examples.includes(id)) b.examples.push(id);
  }

  list(): SpeckleRefusal[] {
    return [...this.buckets.values()].map((b) => ({
      speckleType: b.speckleType,
      reason: b.reason,
      count: b.count,
      message: messageOf(b),
      examples: b.examples,
    }));
  }
}

function messageOf(b: Bucket): string {
  const plural = b.count === 1 ? '' : 's';
  switch (b.reason) {
    case 'display-meshes':
      return `${b.count} display mesh${b.count === 1 ? '' : 'es'} on written ${b.speckleType} elements not carried: ${b.detail}.`;
    case 'non-parameter-entries':
      return `${b.count} property entr${b.count === 1 ? 'y' : 'ies'} on written ${b.speckleType} elements not carried: ${b.detail}.`;
    default:
      return `${b.count} ${b.speckleType} object${plural} not written: ${b.detail}.`;
  }
}
