/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The embedding host's class-level hide list — the embed SDK's `hideTypes` —
 * and the one definition of how a class name is matched against it.
 *
 * The list takes ARBITRARY IFC class names, so it cannot go through
 * `typeVisibility`, whose semantic toggles are a fixed set. It reaches two
 * consumers that are nowhere near each other: the embed's mesh filter
 * (`useModelViewGeometry.ts`), and `store.hostHiddenIfcTypes` →
 * `lib/symbolic-overlay-gate.ts` for the 2D overlay, which is not a mesh and
 * so cannot be filtered out of a mesh list. Both must agree on the matching,
 * hence one function each way rather than a comparison spelled out at both
 * ends.
 *
 * Case-folded on purpose. `mesh.ifcType` and the overlay's owner types are
 * PascalCase (`IfcSpace`), while the embed SDK's own documented example passes
 * SCREAMING_CASE (`IFCSPACE`, the spelling STEP files use). A raw comparison
 * would match neither the SDK's example nor a host page typing `ifcspace`, and
 * would hide nothing while reporting no error.
 */

/**
 * Normalise host-supplied class names into a lookup set. Returns `null` when
 * there is nothing to hide, so a consumer can skip its filter entirely — and
 * so "no host" and "host hid nothing" are the same value.
 */
export function toHostHiddenIfcTypes(
  names: readonly string[] | undefined,
): ReadonlySet<string> | null {
  if (!names || names.length === 0) return null;
  const set = new Set<string>();
  for (const name of names) {
    const trimmed = name.trim();
    if (trimmed.length > 0) set.add(trimmed.toLowerCase());
  }
  return set.size > 0 ? set : null;
}

/** True when `ifcType` is named by a {@link toHostHiddenIfcTypes} result. */
export function isIfcTypeHiddenByHost(
  ifcType: string | undefined,
  hidden: ReadonlySet<string> | null | undefined,
): boolean {
  if (!hidden || !ifcType) return false;
  return hidden.has(ifcType.toLowerCase());
}
