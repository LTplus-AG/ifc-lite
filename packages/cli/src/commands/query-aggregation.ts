/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Aggregation utilities for query command — quantity lookup, sorting,
 * and standard QTO maps.
 */

import { findPropertyInSets, findQuantityInSets } from '@ifc-lite/query';

/**
 * Standard IFC quantity set definitions — maps entity type to its standard Qto_ sets
 * and the quantities within each set. Used for disambiguation warnings.
 */
export const STANDARD_QTO_MAP: Record<string, Record<string, string[]>> = {
  IfcWall: {
    Qto_WallBaseQuantities: ['Length', 'Width', 'Height', 'GrossFootprintArea', 'NetFootprintArea', 'GrossSideArea', 'NetSideArea', 'GrossVolume', 'NetVolume'],
  },
  IfcSlab: {
    Qto_SlabBaseQuantities: ['Width', 'Length', 'Depth', 'Perimeter', 'GrossArea', 'NetArea', 'GrossVolume', 'NetVolume'],
  },
  IfcDoor: {
    Qto_DoorBaseQuantities: ['Width', 'Height', 'Perimeter', 'Area'],
  },
  IfcWindow: {
    Qto_WindowBaseQuantities: ['Width', 'Height', 'Perimeter', 'Area'],
  },
  IfcColumn: {
    Qto_ColumnBaseQuantities: ['Length', 'CrossSectionArea', 'OuterSurfaceArea', 'GrossSurfaceArea', 'NetSurfaceArea', 'GrossVolume', 'NetVolume', 'GrossWeight', 'NetWeight'],
  },
  IfcBeam: {
    Qto_BeamBaseQuantities: ['Length', 'CrossSectionArea', 'OuterSurfaceArea', 'GrossSurfaceArea', 'NetSurfaceArea', 'GrossVolume', 'NetVolume', 'GrossWeight', 'NetWeight'],
  },
  IfcSpace: {
    Qto_SpaceBaseQuantities: ['Height', 'FinishCeilingHeight', 'FinishFloorHeight', 'GrossPerimeter', 'NetPerimeter', 'GrossFloorArea', 'NetFloorArea', 'GrossWallArea', 'NetWallArea', 'GrossCeilingArea', 'NetCeilingArea', 'GrossVolume', 'NetVolume'],
  },
  IfcRoof: {
    Qto_RoofBaseQuantities: ['GrossArea', 'NetArea', 'ProjectedArea'],
  },
  IfcStair: {
    Qto_StairBaseQuantities: ['Length', 'GrossVolume', 'NetVolume'],
  },
  IfcRailing: {
    Qto_RailingBaseQuantities: ['Length'],
  },
  IfcMember: {
    Qto_MemberBaseQuantities: ['Length', 'CrossSectionArea', 'OuterSurfaceArea', 'GrossSurfaceArea', 'NetSurfaceArea', 'GrossVolume', 'NetVolume', 'GrossWeight', 'NetWeight'],
  },
  IfcPlate: {
    Qto_PlateBaseQuantities: ['Width', 'Length', 'Perimeter', 'GrossArea', 'NetArea', 'GrossVolume', 'NetVolume', 'GrossWeight', 'NetWeight'],
  },
  IfcCovering: {
    Qto_CoveringBaseQuantities: ['Width', 'Length', 'GrossArea', 'NetArea'],
  },
  IfcFooting: {
    Qto_FootingBaseQuantities: ['Length', 'Width', 'Height', 'CrossSectionArea', 'OuterSurfaceArea', 'GrossVolume', 'NetVolume', 'GrossWeight', 'NetWeight'],
  },
};

/**
 * Helper: get a quantity value for an entity by name (searching all qsets).
 */
export function getQuantityValue(bim: any, ref: any, quantityName: string): number | null {
  const qsets = bim.quantities(ref);
  for (const qset of qsets) {
    for (const q of qset.quantities) {
      if (q.name === quantityName) {
        // `Number(x) || 0` only catches NaN (an unparseable value): an
        // extreme STEP REAL literal (e.g. 1.0E400) parses to Infinity
        // without erroring at the decode boundary, and `Number(Infinity) ||
        // 0` stays Infinity because Infinity is truthy. Left uncaught, that
        // one entity poisons every downstream sum/avg/min/max over the
        // whole result set. Number.isFinite catches NaN and both infinities
        // alike, so a present-but-non-finite value is treated the same as
        // the existing present-but-unparseable case: substituted with 0.
        const n = Number(q.value);
        return Number.isFinite(n) ? n : 0;
      }
    }
  }
  return null;
}

/**
 * F7: Sort entities by quantity, attribute, or property value.
 * Supports: quantity names, entity attributes (name/type/globalId), PsetName.PropName
 */
export function sortEntities(entities: any[], sortBy: string, descending: boolean, bim: any): any[] {
  const ATTR_KEYS = ['name', 'type', 'globalId', 'globalid', 'description', 'objectType', 'objecttype'];
  const isAttr = ATTR_KEYS.includes(sortBy) || ATTR_KEYS.includes(sortBy.toLowerCase());
  const isDotted = sortBy.includes('.');

  return entities.slice().sort((a, b) => {
    let valA: any;
    let valB: any;

    if (isAttr) {
      // Sort by entity attribute (alphabetical)
      const key = sortBy.toLowerCase() === 'globalid' ? 'globalId'
        : sortBy.toLowerCase() === 'objecttype' ? 'objectType'
        : sortBy.toLowerCase();
      valA = a[key] ?? '';
      valB = b[key] ?? '';
      const cmp = String(valA).localeCompare(String(valB));
      return descending ? -cmp : cmp;
    } else if (isDotted) {
      // Sort by PsetName.PropName
      const [psetName, propName] = sortBy.split('.', 2);
      const getVal = (e: any) => {
        const props = bim.properties(e.ref);
        const prop = findPropertyInSets<any>(props, psetName, propName);
        if (prop?.value != null) return prop.value;
        // Also check quantity sets
        const qsets = bim.quantities(e.ref);
        const qty = findQuantityInSets<any>(qsets, psetName, propName);
        return qty?.value ?? null;
      };
      valA = getVal(a);
      valB = getVal(b);
      if (typeof valA === 'number' && typeof valB === 'number') {
        return descending ? valB - valA : valA - valB;
      }
      const cmp = String(valA ?? '').localeCompare(String(valB ?? ''));
      return descending ? -cmp : cmp;
    } else {
      // Sort by quantity name (numeric)
      valA = getQuantityValue(bim, a.ref, sortBy) ?? 0;
      valB = getQuantityValue(bim, b.ref, sortBy) ?? 0;
      return descending ? valB - valA : valA - valB;
    }
  });
}
