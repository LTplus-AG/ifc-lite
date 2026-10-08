/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MaterialInfo } from '@ifc-lite/parser';

const text = (value: string | undefined) => value === undefined ? null
  : value.length > 240 ? `${value.slice(0, 240)}…` : value;
const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) ? value : null;

/** Bounded presentation of the canonical reader; EXPRESS attribute names stay exact. */
export function materialEvidence(material: MaterialInfo, memberLimit: number) {
  if (material.unresolved) return { type: null, verification: 'unverified' as const };
  return {
    type: `Ifc${material.type}`, verification: 'resolved' as const,
    ...(material.type === 'MaterialList' ? {} : material.type === 'MaterialLayerSet'
      ? { LayerSetName: text(material.name), Description: text(material.description) }
      : { Name: text(material.name), Description: text(material.description) }),
    ...(material.type === 'Material' ? { Category: text(material.category) } : {}),
    ...(material.layers ? {
      layerCount: material.layers.length,
      MaterialLayers: material.layers.slice(0, memberLimit).map(layer => ({
        Name: text(layer.name), Category: text(layer.category), IsVentilated: layer.isVentilated ?? null,
        Material: { Name: text(layer.materialName), Category: text(layer.materialCategory) },
        LayerThickness: { value: finite(layer.thickness), unit: finite(layer.thickness) === null ? null : 'm' },
      })),
    } : {}),
    ...(material.profiles ? {
      profileCount: material.profiles.length,
      MaterialProfiles: material.profiles.slice(0, memberLimit).map(profile => ({
        Name: text(profile.name), Category: text(profile.category),
        Material: { Name: text(profile.materialName), Category: text(profile.materialCategory) },
      })),
    } : {}),
    ...(material.constituents ? {
      constituentCount: material.constituents.length,
      MaterialConstituents: material.constituents.slice(0, memberLimit).map(constituent => ({
        Name: text(constituent.name), Category: text(constituent.category), Fraction: finite(constituent.fraction),
        Material: { Name: text(constituent.materialName), Category: text(constituent.materialCategory) },
      })),
    } : {}),
    ...(material.materials ? {
      memberCount: material.materials.length,
      Materials: material.materials.slice(0, memberLimit).map(member => ({ Name: text(member.name), Category: text(member.category) })),
    } : {}),
  };
}
