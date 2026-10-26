/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The `IfcValue` member rows of rust/export/src/generated/step_log_tables.rs,
// split out of scripts/generate-step-log-tables.mjs (module-size rule).

/**
 * Rows of the generated `IFC_VALUE_MEMBERS` table, one Rust literal per line,
 * sorted by token. Throws when a member resolves to no EXPRESS base or a
 * cross-schema type difference is not the expected one.
 */
export function ifcValueMemberRows({
  getSchemaRegistryForVersion,
  getSelectDefinedLeaves,
  getSelectMembers,
  CONSTRAINED_IFC_VALUE_MEMBERS,
  declaredNominalValueType,
  PropertyValueType,
}) {
  // `IfcValue` members of each schema, walked through that schema's own
  // registry. Each member's type is computed per schema only to validate
  // EXPECTED_TYPE_DIFFERENCES and to choose `ty`; the table stores one row per
  // member with IFC4's type (where IFC4 has the member, the TypeScript
  // writer's reading) plus `in_schemas`, and, for a constrained leaf, the
  // member a value outside its domain relaxes to. -1 violates every
  // constrained member's WHERE rule. Aggregate-typed members (`IfcComplexNumber`) have no
  // EXPRESS base and are typed `AGGREGATE`, so a write naming one is refused
  // for what it is. A member that resolves to neither fails the generator.
  const VALUE_SCHEMAS = ['IFC2X3', 'IFC4', 'IFC4X3'];
  const AGGREGATE = /^(LIST|ARRAY|SET|BAG)\b/;
  // `check_literal_measure` and `BaseKind` handle exactly these.
  const LEAF_BASES = ['STRING', 'REAL', 'NUMBER', 'INTEGER', 'BOOLEAN', 'LOGICAL', 'BINARY'];
  // Members whose type differs between schemas, with each schema's: the
  // table carries one type, so a difference is a gap a registry update must
  // not open silently. Any other difference, and any entry here that no longer
  // differs, fails the generator. IfcCountMeasure's is the known gap the
  // follow-up on fix/ifc4x3-count-measure closes.
  const EXPECTED_TYPE_DIFFERENCES = new Map([
    // IFC4 declares `IfcCountMeasure = NUMBER`, IFC4X3 `= INTEGER`.
    ['IFCCOUNTMEASURE', ['NUMBER', 'NUMBER', 'INTEGER']],
  ]);
  const valueMembers = new Map();
  VALUE_SCHEMAS.forEach((schema, i) => {
    const registry = getSchemaRegistryForVersion(schema);
    const resolved = getSelectDefinedLeaves('IfcValue', registry);
    for (const member of getSelectMembers('IfcValue', registry)) {
      let type = resolved.get(member);
      if (type === undefined) {
        if (!AGGREGATE.test(registry.types[member] ?? '')) throw new Error(`${schema} IfcValue member ${member} resolves to no EXPRESS base`);
        type = 'AGGREGATE';
      } else if (!LEAF_BASES.includes(type)) {
        throw new Error(`${schema} IfcValue member ${member} has base ${type}, which BaseKind does not carry`);
      }
      const token = member.toUpperCase();
      if (!valueMembers.has(token)) valueMembers.set(token, { name: member, types: VALUE_SCHEMAS.map(() => null) });
      valueMembers.get(token).types[i] = type;
    }
  });
  for (const [token, { types }] of valueMembers) {
    const differs = new Set(types.filter((t) => t !== null)).size > 1;
    const expected = EXPECTED_TYPE_DIFFERENCES.get(token);
    if (differs && JSON.stringify(expected) !== JSON.stringify(types)) {
      throw new Error(`IfcValue member ${token} is typed ${JSON.stringify(types)} across ${VALUE_SCHEMAS.join('/')}; expected ${JSON.stringify(expected ?? 'one type')}`);
    }
    if (expected && !differs) throw new Error(`IfcValue member ${token} no longer differs across schemas; drop it from EXPECTED_TYPE_DIFFERENCES`);
  }
  for (const token of EXPECTED_TYPE_DIFFERENCES.keys()) {
    if (!valueMembers.has(token)) throw new Error(`${token} is no IfcValue member; drop it from EXPECTED_TYPE_DIFFERENCES`);
  }
  const leaves = [];
  for (const [token, { name, types }] of [...valueMembers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const constrained = CONSTRAINED_IFC_VALUE_MEMBERS.includes(name);
    let relaxed = '';
    if (constrained) {
      const base = types.find((t) => t !== null && t !== 'AGGREGATE');
      const shape = base === 'INTEGER' ? PropertyValueType.Integer : PropertyValueType.Real;
      relaxed = declaredNominalValueType(-1, shape, token) ?? '';
    }
    const t = types[VALUE_SCHEMAS.indexOf('IFC4')] ?? types.find((x) => x !== null);
    const type = t === 'AGGREGATE' ? 'ValueType::Aggregate' : `ValueType::Leaf(BaseKind::${t[0]}${t.slice(1).toLowerCase()})`;
    leaves.push(
      `    ValueMember { token: ${JSON.stringify(token)}, name: ${JSON.stringify(name)}, constrained: ${constrained}, relaxed: ${JSON.stringify(relaxed)}, ty: ${type}, in_schemas: [${types.map((x) => x !== null).join(', ')}] },`,
    );
  }
  return leaves;
}
