/* SPDX-License-Identifier: MPL-2.0 */
/** Matches rust/export/src/schema_structural_links.rs (#9668). */
import { getCanonicalEntityName, getSchemaRegistryForVersion, type IfcDataStore } from '@ifc-lite/parser';
import { convertEntityType } from './schema-converter.js';
import { listItems } from './schema-converter-structural-axes.js';
import { refId } from './schema-ifc2x3-records.js';

const BECOMES = new Map<string, boolean>();
/** Whether IFC4 `keyword` converts to an IFC2X3 subtype of `parent`, memoized per pair. */
function becomes(keyword: string | undefined, parent: string): boolean {
  if (!keyword) return false;
  const key = `${keyword} ${parent}`;
  let known = BECOMES.get(key);
  if (known === undefined) {
    const registry = getSchemaRegistryForVersion('IFC2X3');
    const name = getCanonicalEntityName(registry, convertEntityType(keyword, 'IFC4', 'IFC2X3'));
    known = !!name && registry.entities[name]?.inheritanceChain?.includes(parent) === true;
    BECOMES.set(key, known);
  }
  return known;
}

/**
 * IFC4 -> IFC2X3: the physical-to-analytical link back to its IFC2X3 entity.
 * IFC2X3 links an element to its analytical member with
 * IfcRelConnectsStructuralElement (RelatingElement : IfcElement,
 * RelatedStructuralMember : IfcStructuralMember; IFC2X3_TC1.exp:6613). IFC4 has
 * no such entity, and the upgrade writes the link as IfcRelAssignsToProduct
 * (`structuralAttributes`). This is its inverse, for exactly that shape: one
 * related object that becomes an IFC2X3 IfcStructuralMember, no
 * RelatedObjectsType, and a relating product that becomes an IFC2X3 IfcElement.
 * Anything else stays an IfcRelAssignsToProduct. Types come from the source
 * store, so only an unedited full export arms it.
 */
export class StructuralLinks {
  private typeOf: ((id: number) => string | undefined) | null = null;

  fromStore(store: IfcDataStore): void {
    // @raw-entity-enumeration-ok conversion prepass is enabled only for an unedited full-source export
    const byId = store.entityIndex.byId;
    this.typeOf = (id) => byId.get(id)?.type.toUpperCase();
  }

  /** The IfcRelConnectsStructuralElement attributes for an IFC4 `IFCRELASSIGNSTOPRODUCT` record of that shape. */
  link(entity: string, args: readonly string[]): string | undefined {
    if (!this.typeOf || entity !== 'IFCRELASSIGNSTOPRODUCT' || args.length !== 7 || args[5].trim() !== '$') return undefined;
    const related = listItems(args[4]);
    const member = related?.length === 1 ? refId(related[0]) : null, element = refId(args[6]);
    if (member === null || element === null || !becomes(this.typeOf(member), 'IfcStructuralMember') || !becomes(this.typeOf(element), 'IfcElement')) return undefined;
    return `${args.slice(0, 4).join(',')},#${element},#${member}`;
  }
}
