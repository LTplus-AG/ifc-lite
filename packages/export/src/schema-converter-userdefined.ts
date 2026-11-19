/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `.USERDEFINED.` rule of a PredefinedType (#10780): IFC4's
 * `CorrectPredefinedType` (and many IFC2X3 WHERE rules) allow `.USERDEFINED.`
 * only with the entity's label attribute set. A converted record that breaks
 * it is reported, not repaired: the converter does not invent a label.
 * Every non-abstract entity with both attributes has the rule except the
 * {@link EXEMPT} ones. Twin of Rust `schema_userdefined.rs`; both are held
 * to `rust/export/tests/fixtures/schema_userdefined_rules.json`.
 */

import type { SchemaVersionWithRegistry } from '@ifc-lite/parser';
import { attrNameTable } from './schema-converter.js';
import { skipStepTrivia } from './step-slot-grammar.js';

const LABELS: readonly string[] = ['ObjectType', 'ElementType', 'ProcessType', 'ResourceType'];

/** Entities with both attributes but no USERDEFINED rule, per schema. */
const EXEMPT: Readonly<Record<SchemaVersionWithRegistry, readonly string[]>> = {
  IFC2X3: [
    'IFCACTUATORTYPE', 'IFCALARMTYPE', 'IFCBEAMTYPE', 'IFCBUILDINGELEMENTPROXYTYPE',
    'IFCCABLECARRIERSEGMENTTYPE', 'IFCCABLESEGMENTTYPE', 'IFCCOLUMNTYPE', 'IFCCONTROLLERTYPE',
    'IFCCOSTSCHEDULE', 'IFCCOVERINGTYPE', 'IFCCURTAINWALLTYPE', 'IFCDISTRIBUTIONCHAMBERELEMENTTYPE',
    'IFCELECTRICAPPLIANCETYPE', 'IFCELECTRICFLOWSTORAGEDEVICETYPE', 'IFCELECTRICGENERATORTYPE', 'IFCELECTRICHEATERTYPE',
    'IFCELECTRICMOTORTYPE', 'IFCELECTRICTIMECONTROLTYPE', 'IFCFIRESUPPRESSIONTERMINALTYPE', 'IFCFLOWINSTRUMENTTYPE',
    'IFCJUNCTIONBOXTYPE', 'IFCLAMPTYPE', 'IFCLIGHTFIXTURETYPE', 'IFCMEMBERTYPE',
    'IFCMOTORCONNECTIONTYPE', 'IFCOUTLETTYPE', 'IFCPLATETYPE', 'IFCPROJECTORDER',
    'IFCPROJECTORDERRECORD', 'IFCPROTECTIVEDEVICETYPE', 'IFCRAILINGTYPE', 'IFCRAMPFLIGHTTYPE',
    'IFCSANITARYTERMINALTYPE', 'IFCSENSORTYPE', 'IFCSLABTYPE', 'IFCSPACETYPE',
    'IFCSTACKTERMINALTYPE', 'IFCSTAIRFLIGHTTYPE', 'IFCSTRUCTURALANALYSISMODEL', 'IFCSTRUCTURALCURVEMEMBER',
    'IFCSTRUCTURALCURVEMEMBERVARYING', 'IFCSTRUCTURALLOADGROUP', 'IFCSTRUCTURALSURFACEMEMBER', 'IFCSTRUCTURALSURFACEMEMBERVARYING',
    'IFCSWITCHINGDEVICETYPE', 'IFCTRANSFORMERTYPE', 'IFCTRANSPORTELEMENTTYPE', 'IFCWALLTYPE',
    'IFCWASTETERMINALTYPE',
  ],
  IFC4: [
    'IFCACTIONREQUEST', 'IFCBUILDINGSYSTEM', 'IFCCOSTITEM', 'IFCCOSTSCHEDULE',
    'IFCDISTRIBUTIONCIRCUIT', 'IFCDISTRIBUTIONPORT', 'IFCDISTRIBUTIONSYSTEM', 'IFCDOOR',
    'IFCDOORSTANDARDCASE', 'IFCEXTERNALSPATIALELEMENT', 'IFCGRID', 'IFCINVENTORY',
    'IFCOPENINGELEMENT', 'IFCOPENINGSTANDARDCASE', 'IFCPERFORMANCEHISTORY', 'IFCPERMIT',
    'IFCPROJECTIONELEMENT', 'IFCPROJECTORDER', 'IFCWINDOW', 'IFCWINDOWSTANDARDCASE',
  ],
  IFC4X3: [
    'IFCACTIONREQUEST', 'IFCALIGNMENT', 'IFCANNOTATION', 'IFCCOSTITEM',
    'IFCCOSTSCHEDULE', 'IFCDISTRIBUTIONPORT', 'IFCEXTERNALSPATIALELEMENT', 'IFCGRID',
    'IFCINVENTORY', 'IFCPERFORMANCEHISTORY', 'IFCPERMIT', 'IFCPROJECTORDER',
    'IFCREFERENT',
  ],
};

const EXEMPT_SETS = new Map(Object.entries(EXEMPT).map(([schema, list]) => [schema, new Set(list)]));

/** `[PredefinedType index, label index]` when `entityType` has the rule in `schema`. */
export function userDefinedRule(schema: SchemaVersionWithRegistry, entityType: string): readonly [number, number] | undefined {
  const names = attrNameTable(schema)?.get(entityType);
  const predefined = names?.indexOf('PredefinedType') ?? -1;
  const label = names?.findIndex((n) => LABELS.includes(n)) ?? -1;
  if (predefined < 0 || label < 0 || EXEMPT_SETS.get(schema)?.has(entityType)) return undefined;
  return [predefined, label];
}

/** True when converted `args` under `rule` say `.USERDEFINED.` and leave the label unset. */
export function breaksUserDefinedRule(args: readonly string[], [predefined, label]: readonly [number, number]): boolean {
  return args.length > Math.max(predefined, label)
    && isToken(args[predefined], '.USERDEFINED.')
    && isToken(args[label], '$');
}

/** True when `slot` is `token` (any case) with only whitespace and comments around it. */
function isToken(slot: string, token: string): boolean {
  const start = skipStepTrivia(slot, 0);
  return start !== -1 && slot.slice(start, start + token.length).toUpperCase() === token
    && skipStepTrivia(slot, start + token.length) === slot.length;
}
