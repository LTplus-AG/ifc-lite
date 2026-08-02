/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Feature-element classification for 2D drawing projection (issue #979).
 *
 * `IfcFeatureElement` descendants — openings, voids, earthworks cuts,
 * projection/surface features — are boolean subtraction/addition operands, NOT
 * building structure. They must never participate in the construction
 * projection: their void cross-sections would draw spurious rectangles inside
 * walls and clutter the plan.
 *
 * The Rust profile extractor (`rust/geometry/src/profile_extractor.rs`) already
 * skips these at the source via `IfcType::is_subtype_of(IfcFeatureElement)`,
 * but that only covers the clean-profile path. The mesh-silhouette fallback in
 * `Drawing2DGenerator` consumes raw `MeshData` (which still contains
 * `IfcOpeningElement` meshes), and a stale/CI-lagged WASM bundle can still emit
 * opening profiles — so the projection stage filters BOTH paths with this same
 * canonical type set, keeping the TS and Rust families from drifting.
 *
 * Caveat: `MeshData.ifcType` is optional ("backward compatibility with old
 * caches"). A cache-restored mesh that lacks `ifcType` reads as a non-feature
 * element here and could still silhouette — the same exposure as before this
 * fix (such meshes were always silhouetted). Populating `ifcType` on the
 * cache-restore path would close that residual gap.
 *
 * The set is the concrete (instantiable) `IfcFeatureElement` leaf types plus
 * the abstract roots, matched case-insensitively. `IfcDoor`/`IfcWindow` are
 * deliberately absent — they descend from `IfcBuiltElement`, not
 * `IfcFeatureElement`, and are real structure that must keep projecting.
 */

/** Canonical IFC feature-element type names (lower-cased for O(1) lookup). */
const FEATURE_ELEMENT_TYPES: ReadonlySet<string> = new Set([
  'ifcfeatureelement',
  'ifcfeatureelementsubtraction',
  'ifcfeatureelementaddition',
  'ifcopeningelement',
  'ifcopeningstandardcase',
  'ifcvoidingfeature',
  'ifcearthworkscut',
  'ifcprojectionelement',
  'ifcsurfacefeature',
]);

/**
 * Whether `ifcType` is an `IfcFeatureElement` subtype (an opening/void/feature
 * operand) that must be excluded from construction projection. `undefined`/
 * unknown types are treated as real geometry (not a feature element).
 */
export function isFeatureElementType(ifcType: string | undefined | null): boolean {
  if (!ifcType) return false;
  return FEATURE_ELEMENT_TYPES.has(ifcType.toLowerCase());
}
