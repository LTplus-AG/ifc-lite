/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The IFCPROXY an IFC4X3 alignment or positioning product becomes below IFC4X3
 * (`shouldSkipEntity`'s nine types, #7683 EXPORT-MERGE-8). Split out of
 * `schema-converter.ts` to stay under its line budget. Rust twin:
 * `product_proxy` in `rust/export/src/schema_convert.rs`; both are held to
 * `rust/export/tests/fixtures/schema_product_proxy_vectors.json`.
 *
 * Every one of the nine is an IfcProduct subtype, so its first seven
 * attributes are IfcProxy's first seven: GlobalId, OwnerHistory, Name,
 * Description, ObjectType, ObjectPlacement, Representation. The rule:
 * - GlobalId is the MINTED `guid`, never the source's (the federation decision
 *   documented at `convertRecord`'s call site and pinned in
 *   `merged-exporter.test.ts`);
 * - source attributes 1 to 6 are kept verbatim, so the alignment's curve
 *   representation and a referent's placement stay attached;
 * - ObjectType takes the quoted source type name when the source slot is `$`,
 *   so what the proxy stands for is still readable;
 * - then `.NOTDEFINED.` ProxyType and a `$` Tag. Source attributes past the
 *   seventh (the IFC4X3 PredefinedType and friends) have no IfcProxy slot.
 *
 * A missing source slot is written `$`.
 */
export function productProxy(prefix: string, guid: string, entityType: string, args: readonly string[]): string {
  const slot = (i: number): string => args[i] ?? '$';
  const objectType = slot(4).trim() === '$' ? `'${entityType}'` : slot(4);
  return `${prefix}IFCPROXY('${guid}',${slot(1)},${slot(2)},${slot(3)},${objectType},${slot(5)},${slot(6)},.NOTDEFINED.,$);`;
}
