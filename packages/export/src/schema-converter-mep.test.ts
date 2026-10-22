// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';
import { getSchemaRegistryForVersion } from '@ifc-lite/parser';
import { convertEntityType, convertStepLine } from './schema-converter.js';
import { splitTopLevelStepArguments } from './step-argument-parser.js';
import { MEP_IFC2X3_TYPES } from './schema-converter-mep.js';

const common = ["'2fv4DZfY55exwX8QDy8dmw'", '#209', "'Duct, supply'", "'Description'", "'Authored object type'", '#326', '#327', "'Tag-1'"];
const target = getSchemaRegistryForVersion('IFC2X3').entities;
const boardTypes = new Set(['IfcElectricDistributionBoard', 'IfcDistributionBoard']);

function record(line: string | null): { type: string; values: string[] } {
  const match = line?.match(/^#\d+=(\w+)\((.*)\);$/);
  if (!match) throw new Error(`Expected STEP record: ${line}`);
  const values = splitTopLevelStepArguments(match[2]);
  if (!values) throw new Error(`Invalid arguments: ${line}`);
  return { type: match[1], values };
}

describe('MEP occurrence downgrade (#8019)', () => {
  for (const schema of ['IFC4', 'IFC4X3'] as const) {
    it(`${schema}: every missing distribution occurrence uses its native base and preserves product attributes`, () => {
      const entities = getSchemaRegistryForVersion(schema).entities;
      const missing = Object.values(entities).filter((meta) =>
        !target[meta.name] && meta.inheritanceChain?.includes('IfcDistributionElement'));
      expect(missing).toHaveLength(schema === 'IFC4' ? 65 : 71);
      for (const meta of missing) {
        const ancestor = [...(meta.inheritanceChain ?? [])].reverse().find((name) => target[name]);
        const targetName = boardTypes.has(meta.name) ? 'IfcElectricDistributionPoint' : ancestor;
        if (!targetName) throw new Error(`No native ancestor: ${meta.name}`);
        expect(target[targetName].isAbstract, targetName).toBe(false);
        const srcNames = (meta.allAttributes ?? meta.attributes).map((a) => a.name);
        const tgtNames = (target[targetName].allAttributes ?? target[targetName].attributes).map((a) => a.name);
        // All audited occurrences carry only IfcElement's eight slots plus PredefinedType.
        expect(srcNames.slice(0, 8)).toEqual(['GlobalId', 'OwnerHistory', 'Name', 'Description', 'ObjectType', 'ObjectPlacement', 'Representation', 'Tag']);
        expect(srcNames.slice(8)).toEqual(['PredefinedType']);
        const out = record(convertStepLine(`#10=${meta.name.toUpperCase()}(${common.join(',')},.NOTDEFINED.);`, schema, 'IFC2X3'));
        expect(out.type, meta.name).toBe(targetName.toUpperCase());
        expect(out.values, meta.name).toHaveLength(tgtNames.length);
        expect(out.values.slice(0, 8), meta.name).toEqual(common);
        expect(out.values.slice(8), meta.name).toEqual(boardTypes.has(meta.name) ? ['.NOTDEFINED.', '$'] : targetName === 'IfcDistributionControlElement' ? ['$'] : []);
      }
      if (schema === 'IFC4X3') expect([...MEP_IFC2X3_TYPES.keys()].sort()).toEqual(missing.map((m) => m.name.toUpperCase()).sort());
    });
  }

  it('keeps the duct type discriminator and relationship endpoints on the original express ids', () => {
    const lines = [
      `#10=IFCDUCTSEGMENT(${common.join(',')},.RIGIDSEGMENT.);`,
      "#20=IFCDUCTSEGMENTTYPE('2WSwGyLsrFNA9TLOq_ifyd',#209,'Rigid duct',$,$,(#30),(#31),'T-1','Duct',.RIGIDSEGMENT.);",
      "#40=IFCRELDEFINESBYTYPE('2WSwGyLsrFNA9TLOq_ifye',#209,$,$,(#10),#20);",
      "#41=IFCRELCONTAINEDINSPATIALSTRUCTURE('2WSwGyLsrFNA9TLOq_ifyf',#209,$,$,(#10),#50);",
      "#42=IFCRELCONNECTSPORTTOELEMENT('2WSwGyLsrFNA9TLOq_ifyg',#209,$,$,#60,#10);",
    ];
    const out = lines.map((line) => convertStepLine(line, 'IFC4', 'IFC2X3'));
    expect(record(out[0])).toEqual({ type: 'IFCFLOWSEGMENT', values: common });
    expect(out.slice(1)).toEqual(lines.slice(1));
  });

  it('does not generalize the fallback or remap supported types', () => {
    for (const type of ['IFCDUCTSEGMENTTYPE', 'IFCFLOWSEGMENT', 'IFCDISTRIBUTIONCONTROLELEMENT', 'IFCUNRECOGNIZED']) {
      expect(convertEntityType(type, 'IFC4', 'IFC2X3')).toBe(type);
    }
    expect(convertEntityType('IFCDUCTSEGMENT', 'IFC4', 'IFC4X3')).toBe('IFCDUCTSEGMENT');
  });
});
