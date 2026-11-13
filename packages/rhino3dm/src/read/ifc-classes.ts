/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical IFC class names, looked up ignoring case. Null when the name is not one. */
export interface IfcClasses {
  /** An instantiable subtype of IfcProduct in IFC2X3, IFC4 or IFC4X3. */
  product(name: string): string | null;
  /** IfcProject, or an instantiable spatial element. */
  spatial(name: string): string | null;
}

const SPATIAL_ROOTS = new Set(['IfcSpatialElement', 'IfcSpatialStructureElement']);
let cached: Promise<IfcClasses> | undefined;

/** Build the lookups from the schema tables once. The tables load lazily: the writer never needs them. */
export function loadIfcClasses(): Promise<IfcClasses> {
  return cached ??= import('@ifc-lite/data').then(({ getEntitiesIfc2x3, getEntitiesIfc4Express, getEntitiesIfc4x3 }): IfcClasses => {
    const product = new Map<string, string>(), spatial = new Map<string, string>([['IFCPROJECT', 'IfcProject']]);
    for (const entities of [getEntitiesIfc4x3(), getEntitiesIfc4Express(), getEntitiesIfc2x3()]) {
      const parents = new Map(entities.map(e => [e.name, e.parent]));
      for (const entity of entities) {
        if (entity.abstract) continue;
        const seen = new Set<string>();
        for (let name: string | undefined = entity.name; name && !seen.has(name); name = parents.get(name)) {
          seen.add(name);
          if (name === 'IfcProduct') product.set(entity.name.toUpperCase(), entity.name);
          if (SPATIAL_ROOTS.has(name)) spatial.set(entity.name.toUpperCase(), entity.name);
        }
      }
    }
    return {
      product: name => product.get(name.toUpperCase()) ?? null,
      spatial: name => spatial.get(name.toUpperCase()) ?? null,
    };
  }).catch(error => { cached = undefined; throw error; });
}
