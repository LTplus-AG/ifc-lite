/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * A small IFC2X3 building georeferenced through ePset_MapConversion (as the
 * ifc-georeferencer tool writes it), with technical equipment written the only
 * way IFC2X3 allows: generic occurrences (IfcEnergyConversionDevice,
 * IfcFlowMovingDevice, ...) typed by IfcBoilerType, IfcPumpType, ...
 * Local (0,0,0) is E 2 600 000, N 1 200 000, H 500, no rotation.
 */

export function equipment2x3(): string {
  const lines: string[] = [];
  let next = 1;
  let guid = 0;
  const add = (body: string): number => {
    const id = next++;
    lines.push(`#${id}=${body};`);
    return id;
  };
  const g = () => `'${String(++guid).padStart(22, '0')}'`;
  const n = (v: number) => (Number.isInteger(v) ? `${v}.` : String(v));
  const pt = (x: number, y: number, z = 0) => add(`IFCCARTESIANPOINT((${n(x)},${n(y)},${n(z)}))`);
  const axis = (x: number, y: number, z: number) => add(`IFCAXIS2PLACEMENT3D(#${pt(x, y, z)},$,$)`);
  const place = (rel: number | null, x: number, y: number, z: number) =>
    add(`IFCLOCALPLACEMENT(${rel === null ? '$' : `#${rel}`},#${axis(x, y, z)})`);
  const label = (name: string, value: string) => add(`IFCPROPERTYSINGLEVALUE('${name}',$,${value},$)`);

  const units = add(`IFCUNITASSIGNMENT((#${add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')}))`);
  const ctx = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${axis(0, 0, 0)},$)`);
  const body = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#${ctx},$,.MODEL_VIEW.,$)`);
  const project = add(`IFCPROJECT(${g()},$,'P',$,$,$,$,(#${ctx}),#${units})`);
  const sitePl = place(null, 0, 0, 0);
  const site = add(`IFCSITE(${g()},$,'Site',$,$,#${sitePl},$,$,.ELEMENT.,$,$,$,$,$)`);
  const crsSet = add(`IFCPROPERTYSET(${g()},$,'ePset_ProjectedCRS',$,(#${label('Name', "IFCLABEL('EPSG:2056')")}))`);
  add(`IFCRELDEFINESBYPROPERTIES(${g()},$,$,$,(#${site}),#${crsSet})`);
  const conversion = [
    label('TargetCRS', "IFCLABEL('EPSG:2056')"),
    label('Eastings', 'IFCLENGTHMEASURE(2600000.)'),
    label('Northings', 'IFCLENGTHMEASURE(1200000.)'),
    label('OrthogonalHeight', 'IFCLENGTHMEASURE(500.)'),
    label('XAxisAbscissa', 'IFCREAL(1.)'),
    label('XAxisOrdinate', 'IFCREAL(0.)'),
    label('Scale', 'IFCREAL(1.)'),
  ];
  const mcSet = add(`IFCPROPERTYSET(${g()},$,'ePset_MapConversion',$,(${conversion.map((i) => `#${i}`).join(',')}))`);
  add(`IFCRELDEFINESBYPROPERTIES(${g()},$,$,$,(#${site}),#${mcSet})`);
  const bldPl = place(sitePl, 0, 0, 0);
  const building = add(`IFCBUILDING(${g()},$,'B',$,$,#${bldPl},$,$,.ELEMENT.,$,$,$)`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,#${project},(#${site}))`);
  add(`IFCRELAGGREGATES(${g()},$,$,$,#${site},(#${building}))`);
  const storey = (name: string, z: number) => {
    const pl = place(bldPl, 0, 0, z);
    return { pl, id: add(`IFCBUILDINGSTOREY(${g()},$,'${name}',$,$,#${pl},$,$,.ELEMENT.,${n(z)})`) };
  };
  const ug = storey('UG', -3);
  const eg = storey('EG', 0);
  const og = storey('OG', 4);
  add(`IFCRELAGGREGATES(${g()},$,$,$,#${building},(#${ug.id},#${eg.id},#${og.id}))`);
  const contained: Record<number, number[]> = { [ug.id]: [], [eg.id]: [], [og.id]: [] };

  const prof = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${add(`IFCAXIS2PLACEMENT2D(#${add('IFCCARTESIANPOINT((10.,5.))')},$)`)},20.,10.)`);
  const solid = add(`IFCEXTRUDEDAREASOLID(#${prof},#${axis(0, 0, 0)},#${add('IFCDIRECTION((0.,0.,-1.))')},0.3)`);
  const rep = add(`IFCSHAPEREPRESENTATION(#${body},'Body','SweptSolid',(#${solid}))`);
  contained[eg.id].push(add(`IFCSLAB(${g()},$,'Bodenplatte',$,$,#${place(eg.pl, 0, 0, 0)},#${add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`)},$,.FLOOR.)`));

  // Equipment carries its own extruded body (0.5 m x 0.5 m x 1 m from its base up), as a real export does.
  const box = () => {
    const p = add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${add(`IFCAXIS2PLACEMENT2D(#${add('IFCCARTESIANPOINT((0.,0.))')},$)`)},0.5,0.5)`);
    const s = add(`IFCEXTRUDEDAREASOLID(#${p},#${axis(0, 0, 0)},#${add('IFCDIRECTION((0.,0.,1.))')},1.)`);
    return add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${add(`IFCSHAPEREPRESENTATION(#${body},'Body','SweptSolid',(#${s}))`)}))`);
  };
  const typed = (storeyRef: { pl: number; id: number }, occurrence: string, name: string, type: string, predefined: string) => {
    const o = add(`${occurrence}(${g()},$,'${name}',$,$,#${place(storeyRef.pl, 5, 5, 0)},#${box()},$)`);
    const t = add(`${type}(${g()},$,'${name} Typ',$,$,$,$,$,$,.${predefined}.)`);
    add(`IFCRELDEFINESBYTYPE(${g()},$,$,$,(#${o}),#${t})`);
    contained[storeyRef.id].push(o);
  };
  typed(ug, 'IFCENERGYCONVERSIONDEVICE', 'Heizkessel', 'IFCBOILERTYPE', 'WATER');
  typed(ug, 'IFCFLOWMOVINGDEVICE', 'Umwälzpumpe', 'IFCPUMPTYPE', 'CIRCULATOR');
  typed(ug, 'IFCFLOWSTORAGEDEVICE', 'Batteriespeicher', 'IFCELECTRICFLOWSTORAGEDEVICETYPE', 'BATTERY');
  typed(ug, 'IFCENERGYCONVERSIONDEVICE', 'Wärmepumpe', 'IFCUNITARYEQUIPMENTTYPE', 'SPLITSYSTEM');
  typed(eg, 'IFCFLOWCONTROLLER', 'Hauptschalter', 'IFCSWITCHINGDEVICETYPE', 'SWITCHDISCONNECTOR');
  typed(ug, 'IFCFLOWTERMINAL', 'Lavabo', 'IFCSANITARYTERMINALTYPE', 'WASHHANDBASIN');
  typed(og, 'IFCFLOWMOVINGDEVICE', 'Pumpe OG', 'IFCPUMPTYPE', 'CIRCULATOR');
  contained[eg.id].push(add(`IFCELECTRICDISTRIBUTIONPOINT(${g()},$,'Hauptverteilung',$,$,#${place(eg.pl, 2, 5, 0)},#${box()},$,.DISTRIBUTIONBOARD.,$)`));

  for (const [storeyId, ids] of Object.entries(contained)) {
    add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${g()},$,$,$,(${ids.map((i) => `#${i}`).join(',')}),#${storeyId})`);
  }
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [CoordinationView_V2.0]'),'2;1');",
    "FILE_NAME('equipment-2x3.ifc','2026-11-15T00:00:00',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC2X3'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}
