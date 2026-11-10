/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Deterministic 31 entities per BREP wall; no fixture downloads or geometry mocks. */
export function generatedLayerModel(walls: number, withLayer: boolean): string {
  const rows = ["ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('generated.ifc','',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;"];
  for (let wall = 0; wall < walls; wall++) {
    const b = wall * 31 + 1;
    rows.push(`#${b}=IFCWALL('${wall.toString(36).padStart(22, '0')}',$,'Wall ${wall}',$,$,$,#${b + 1},$);`,
      `#${b + 1}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${b + 2}));`,
      `#${b + 2}=IFCSHAPEREPRESENTATION($,'Body','Brep',(#${b + 3}));`,
      `#${b + 3}=IFCFACETEDBREP(#${b + 4});`,
      `#${b + 4}=IFCCLOSEDSHELL((${Array.from({ length: 6 }, (_, i) => `#${b + 5 + i}`).join(',')}));`);
    const corners = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (let i = 0; i < 6; i++) rows.push(
      `#${b + 5 + i}=IFCFACE((#${b + 11 + i}));`,
      `#${b + 11 + i}=IFCFACEOUTERBOUND(#${b + 17 + i},.T.);`,
      `#${b + 17 + i}=IFCPOLYLOOP((${corners[i].map(c => `#${b + 23 + c}`).join(',')}));`);
    for (let i = 0; i < 8; i++) rows.push(`#${b + 23 + i}=IFCCARTESIANPOINT((${wall * 2 + (i & 1)}.,${(i >> 1) & 1}.,${(i >> 2) & 1}.));`);
  }
  if (withLayer) rows.push(`#${walls * 31 + 1}=IFCPRESENTATIONLAYERASSIGNMENT('BREP layer',$,(#24),'L-1');`);
  rows.push('ENDSEC;\nEND-ISO-10303-21;');
  return rows.join('\n');
}
