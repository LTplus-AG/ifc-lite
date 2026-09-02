/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `bsi::ifc::material` — the only channel IFCX carries which material an
 * element is made of. Our own reader (`packages/ifcx/src/property-extractor.ts`)
 * already unpacks this attribute into a "Material" pset (a real buildingSMART
 * PCERT sample scene authors it as `{code, uri}` on most physical elements),
 * but {@link Ifc5Exporter} never emitted it: an `IfcRelAssociatesMaterial`
 * association from the STEP source was silently dropped on export, so a
 * round trip through our own writer lost every element's material.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import { extractMaterialsOnDemand } from '@ifc-lite/parser';

/**
 * Build the `bsi::ifc::material` attribute value for an entity, or
 * `undefined` when it has no material association.
 *
 * The vendored buildingSMART schema
 * (`packages/export/src/__fixtures__/schemas/ifc@v5a.ifcx`) declares
 * `bsi::ifc::material` as an Object with both `code` and `uri` required
 * (neither key carries `optional: true` — the same convention `bsi::ifc::class`
 * uses right next to it, and that attribute emits both). The real
 * buildingSMART reference sample committed at
 * `apps/viewer/public/samples/hello-wall.ifcx` confirms a registry exists:
 * every `bsi::ifc::material` value there carries a `uri` resolving into
 * buildingSMART's `midas-materials` identifier registry (e.g.
 * `.../uri/fish/midas-materials/26/class/CONCRETE`).
 *
 * We cannot resolve an arbitrary IFC4 `IfcMaterial.Name` (freeform text, not
 * a midas-materials catalog code) into a real registry entry without a
 * lookup service this package does not have, so `uri` is emitted as an empty
 * string rather than a fabricated URL that would misrepresent the material
 * as officially matched to a registry entry it was never checked against.
 * An empty string still satisfies the schema's declared shape (`uri` present,
 * typed `String`), unlike omitting the key outright.
 */
export function buildMaterialAttribute(
  dataStore: IfcDataStore,
  expressId: number,
): { code: string; uri: string } | undefined {
  const material = extractMaterialsOnDemand(dataStore, expressId);
  return material?.name ? { code: material.name, uri: '' } : undefined;
}
