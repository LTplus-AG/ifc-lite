/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect } from 'vitest';
import { StepTokenizer } from '../src/tokenizer.js';
import { ColumnarParser } from '../src/columnar-parser.js';
import { extractStructuralOnDemand } from '../src/structural-extractor.js';

// READ-completeness regression: literal STEP orders are independent of the reader's registry.
async function extract(schema: string, lines: string[]) {
  const source = new TextEncoder().encode(`ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('${schema}'));\nENDSEC;\nDATA;\n${lines.join('\n')}\nENDSEC;\nEND-ISO-10303-21;`);
  const refs = Array.from(new StepTokenizer(source).scanEntitiesFast()).map(ref => ({
    expressId: ref.expressId, type: ref.type, byteOffset: ref.offset,
    byteLength: ref.length, lineNumber: ref.line,
  }));
  const store = await new ColumnarParser().parseLite(source.buffer as ArrayBuffer, refs, {});
  return extractStructuralOnDemand(store);
}

for (const schema of ['IFC2X3', 'IFC4', 'IFC4X3']) {
  const old = schema === 'IFC2X3';
  const member = `#10=IFCSTRUCTURALCURVEMEMBER('m',$,'Member',$,$,$,$,.RIGID_JOINED_MEMBER.${old ? '' : ',#90'});`;
  const point = `#20=IFCSTRUCTURALPOINTCONNECTION('c',$,'Support',$,$,$,$,$${old ? '' : ',#91'});`;
  describe(`structural READ completeness ${schema}`, () => {
    it('links physical elements in either assignment direction and deduplicates both sources', async () => {
      const out = await extract(schema, [member, point,
        "#30=IFCBEAM('b',$,$,$,$,$,$,$);",
        "#31=IFCCOLUMN('p',$,$,$,$,$,$,$);",
        "#32=IFCSLAB('s',$,$,$,$,$,$,$);",
        "#33=IFCWALL('w',$,$,$,$,$,$,$);",
        // AxisVM-style orientation: structural RelatedObjects, physical RelatingProduct.
        "#40=IFCRELASSIGNSTOPRODUCT('r1',$,$,$,(#10),.PRODUCT.,#30);",
        "#41=IFCRELASSIGNSTOPRODUCT('r2',$,$,$,(#31,#32),.PRODUCT.,#10);",
        "#42=IFCRELASSIGNSTOPRODUCT('r3',$,$,$,(#20,#10),.PRODUCT.,#33);",
        "#43=IFCRELASSIGNSTOPRODUCT('invalid',$,$,$,(#20),.PRODUCT.,#10);",
        "#44=IFCRELASSIGNSTOPRODUCT('nonproduct',$,$,$,(#90),.PRODUCT.,#10);",
        // A spatial product is not the analysed physical element.
        "#35=IFCBUILDINGSTOREY('st',$,$,$,$,$,$,$,.ELEMENT.,$);",
        "#47=IFCRELASSIGNSTOPRODUCT('storey',$,$,$,(#10),.PRODUCT.,#35);",
        '#90=IFCDIRECTION((0.,0.,1.));',
        ...(old ? ["#45=IFCRELCONNECTSSTRUCTURALELEMENT('legacy',$,$,$,#30,#10);",
          "#34=IFCBEAM('legacy-beam',$,$,$,$,$,$,$);",
          "#46=IFCRELCONNECTSSTRUCTURALELEMENT('legacy-only',$,$,$,#34,#10);"] : []),
      ]);
      expect(out.members[0].physicalElementIds).toEqual(old ? [30,31,32,33,34] : [30,31,32,33]);
      expect(out.connections[0].physicalElementIds).toEqual([33]);
    });

    it('reads member connection conditions, length, coordinates and eccentricity values', async () => {
      const release = old ? '1.,2.,3.,4.,5.,6.' : 'IFCBOOLEAN(.T.),IFCLINEARSTIFFNESSMEASURE(2.),IFCBOOLEAN(.T.),IFCBOOLEAN(.F.),IFCROTATIONALSTIFFNESSMEASURE(5.),IFCBOOLEAN(.F.)';
      const out = await extract(schema, [member, point,
        "#40=IFCRELCONNECTSSTRUCTURALMEMBER('normal',$,$,$,#10,#20,#55,#50,2.75,#91);",
        `#55=IFCBOUNDARYNODECONDITION('Release',${release});`,
        "#41=IFCRELCONNECTSWITHECCENTRICITY('ecc',$,$,$,#10,#20,$,#50,3.5,#91,#60);",
        "#50=IFCSLIPPAGECONNECTIONCONDITION('Slip',0.1,0.2,0.3);",
        '#60=IFCCONNECTIONPOINTECCENTRICITY(#70,#71,1.25,-2.5,3.75);',
        '#70=IFCCARTESIANPOINT((1.,2.,3.));', '#71=IFCCARTESIANPOINT((4.,5.,6.));',
        '#90=IFCDIRECTION((0.,0.,1.));', '#91=IFCAXIS2PLACEMENT3D(#70,$,$);',
      ]);
      expect(out.members[0].Axis).toBe(old ? undefined : 90);
      expect(out.connections[0].ConditionCoordinateSystem).toBe(old ? undefined : 91);
      expect(out.members[0].connectionGlobalIds).toEqual(['c']);
      const relations = out.members[0].IfcRelConnectsStructuralMember;
      expect(relations?.map(r => [r.expressId, r.RelatedStructuralConnection, r.SupportedLength, r.ConditionCoordinateSystem])).toEqual([[40,20,2.75,91],[41,20,3.5,91]]);
      expect(relations?.[0].AdditionalConditions).toEqual({expressId:50,type:'IfcSlippageConnectionCondition',name:'Slip',components:{SlippageX:0.1,SlippageY:0.2,SlippageZ:0.3}});
      // Member-end release, carried by 547 relations across five real analysis exports.
      const t = old ? 'Linear' : 'Translational';
      expect(relations?.[0].AppliedCondition).toEqual({expressId:55,type:'IfcBoundaryNodeCondition',name:'Release',components:{[`${t}StiffnessX`]:old ? 1 : true,[`${t}StiffnessY`]:2,[`${t}StiffnessZ`]:old ? 3 : true,RotationalStiffnessX:old ? 4 : false,RotationalStiffnessY:5,RotationalStiffnessZ:old ? 6 : false}});
      expect(relations?.[1].AppliedCondition).toBeUndefined();
      expect(relations?.[0].ConnectionConstraint).toBeUndefined();
      expect(relations?.[1].ConnectionConstraint).toEqual({expressId:60,EccentricityInX:1.25,EccentricityInY:-2.5,EccentricityInZ:3.75,PointOnRelatingElement:70,PointOnRelatedElement:71});
    });

    it('reads edge, face and warping support component values in the declared schema', async () => {
      const values = old ? '11.,22.,33.,44.,55.,66.' : 'IFCBOOLEAN(.T.),IFCBOOLEAN(.F.),IFCLINEARSTIFFNESSMEASURE(33.),44.,55.,66.';
      const out = await extract(schema, [
        `#10=IFCSTRUCTURALCURVECONNECTION('edge',$,$,$,$,$,$,#40${old ? '' : ',#95'});`,
        '#95=IFCDIRECTION((0.,0.,1.));',
        "#20=IFCSTRUCTURALSURFACECONNECTION('face',$,$,$,$,$,$,#41);",
        "#30=IFCSTRUCTURALPOINTCONNECTION('warp',$,$,$,$,$,$,#42,$);",
        `#40=IFCBOUNDARYEDGECONDITION('Edge',${values.replace('IFCLINEARSTIFFNESSMEASURE', 'IFCMODULUSOFLINEARSUBGRADEREACTIONMEASURE')});`,
        `#41=IFCBOUNDARYFACECONDITION('Face',${old ? '12.,23.,34.' : 'IFCBOOLEAN(.F.),IFCMODULUSOFSUBGRADEREACTIONMEASURE(23.),IFCBOOLEAN(.T.)'});`,
        `#42=IFCBOUNDARYNODECONDITIONWARPING('Warp',${values},${old ? '77.' : 'IFCWARPINGMOMENTMEASURE(77.)'});`,
      ]);
      const prefix = old ? 'Linear' : 'Translational';
      // IfcStructuralCurveConnection: IFC4 Axis, IFC4X3 AxisDirection, IFC2X3 neither.
      const edge = out.connections.find(c => c.expressId === 10);
      expect([edge?.Axis, edge?.AxisDirection]).toEqual(old ? [undefined, undefined] : schema === 'IFC4' ? [95, undefined] : [undefined, 95]);
      const byId = new Map(out.connections.map(c => [c.expressId,c.appliedCondition]));
      expect(byId.get(10)?.components).toEqual({[`${prefix}StiffnessByLengthX`]:old ? 11 : true,[`${prefix}StiffnessByLengthY`]:old ? 22 : false,[`${prefix}StiffnessByLengthZ`]:33,RotationalStiffnessByLengthX:44,RotationalStiffnessByLengthY:55,RotationalStiffnessByLengthZ:66});
      expect(byId.get(20)?.components).toEqual({[`${prefix}StiffnessByAreaX`]:old ? 12 : false,[`${prefix}StiffnessByAreaY`]:23,[`${prefix}StiffnessByAreaZ`]:old ? 34 : true});
      expect(byId.get(30)?.components).toEqual({[`${prefix}StiffnessX`]:old ? 11 : true,[`${prefix}StiffnessY`]:old ? 22 : false,[`${prefix}StiffnessZ`]:33,RotationalStiffnessX:44,RotationalStiffnessY:55,RotationalStiffnessZ:66,WarpingStiffness:77});
    });

    it('returns all temperature, planar force, displacement, distortion and warping load values', async () => {
      const loads = [
        ['IFCSTRUCTURALLOADTEMPERATURE', "'Temp',12.,-3.,4.", old ? {DeltaT_Constant:12,DeltaT_Y:-3,DeltaT_Z:4} : {DeltaTConstant:12,DeltaTY:-3,DeltaTZ:4}],
        ['IFCSTRUCTURALLOADPLANARFORCE', "'Planar',1.,2.,-3.", {PlanarForceX:1,PlanarForceY:2,PlanarForceZ:-3}],
        ['IFCSTRUCTURALLOADSINGLEDISPLACEMENT', "'Move',1.,2.,3.,4.,5.,6.", {DisplacementX:1,DisplacementY:2,DisplacementZ:3,RotationalDisplacementRX:4,RotationalDisplacementRY:5,RotationalDisplacementRZ:6}],
        ['IFCSTRUCTURALLOADSINGLEDISPLACEMENTDISTORTION', "'Distort',1.,2.,3.,4.,5.,6.,7.", {DisplacementX:1,DisplacementY:2,DisplacementZ:3,RotationalDisplacementRX:4,RotationalDisplacementRY:5,RotationalDisplacementRZ:6,Distortion:7}],
        ['IFCSTRUCTURALLOADSINGLEFORCEWARPING', "'Force',1.,2.,3.,4.,5.,6.,7.", {ForceX:1,ForceY:2,ForceZ:3,MomentX:4,MomentY:5,MomentZ:6,WarpingMoment:7}],
      ] as const;
      const out = await extract(schema, loads.flatMap(([type, attrs], i) => [
        `#${10+i}=IFCSTRUCTURALPOINTACTION('a${i}',$,$,$,$,$,$,#${100+i},.LOCAL_COORDS.,.T.${old ? ',$' : ''});`,
        `#${100+i}=${type}(${attrs});`,
      ]));
      expect(out.activities.map(a => a.appliedLoad?.components)).toEqual(loads.map(l => l[2]));
    });

    it('reads action/reaction subtype attributes without shifting IFC2X3 CausedBy into projection', async () => {
      const actionTypes = old ? ['POINTACTION','LINEARACTION','LINEARACTIONVARYING','PLANARACTION','PLANARACTIONVARYING'] : ['POINTACTION','CURVEACTION','LINEARACTION','SURFACEACTION','PLANARACTION'];
      const reactionTypes = old ? ['POINTREACTION'] : ['POINTREACTION','CURVEREACTION','SURFACEREACTION'];
      const out = await extract(schema, [
        ...actionTypes.map((type, i) => `#${10+i}=IFCSTRUCTURAL${type}('a${i}',$,$,$,$,$,$,#100,.LOCAL_COORDS.,.T.${type === 'POINTACTION' && !old ? '' : ','}${type === 'POINTACTION' ? (old ? '#200' : '') : (old ? '#200,.PROJECTED_LENGTH.' : '.TRUE_LENGTH.,.CONST.')}${type.endsWith('VARYING') ? ',#201,(#100)' : ''});`),
        ...reactionTypes.map((type, i) => `#${30+i}=IFCSTRUCTURAL${type}('r${i}',$,$,$,$,$,$,#100,.GLOBAL_COORDS.${type === 'POINTREACTION' ? '' : ',.CONST.'});`),
        "#100=IFCSTRUCTURALLOADTEMPERATURE('T',1.,2.,3.);",
      ]);
      for (const a of out.activities.filter(a => a.kind === 'Action')) {
        expect(a.globalOrLocal).toBe('LOCAL_COORDS');
        expect(a.destabilizingLoad).toBe(true);
        expect(a.ProjectedOrTrue).toBe(a.type === 'IfcStructuralPointAction' ? undefined : old ? 'PROJECTED_LENGTH' : 'TRUE_LENGTH');
        expect(a.predefinedType).toBe(old || a.type === 'IfcStructuralPointAction' ? undefined : 'CONST');
        expect(a.appliedLoad?.components).toEqual(old ? {DeltaT_Constant:1,DeltaT_Y:2,DeltaT_Z:3} : {DeltaTConstant:1,DeltaTY:2,DeltaTZ:3});
      }
      for (const r of out.activities.filter(a => a.kind === 'Reaction')) {
        expect(r.globalOrLocal).toBe('GLOBAL_COORDS');
        expect(r.destabilizingLoad).toBeUndefined();
        expect(r.predefinedType).toBe(r.type === 'IfcStructuralPointReaction' ? undefined : 'CONST');
      }
      expect(out.activities).toHaveLength(actionTypes.length+reactionTypes.length);
    });
  });
}
