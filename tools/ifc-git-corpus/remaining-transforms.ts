/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { uuidFromSeed, uuidToIfcGuid } from '@ifc-lite/encoding';
import { indexLines, findByType, splitArgs, rewriteRecord, globalIdOf, type StepLine } from './step-text.js';
import type { Transform } from './derive-revisions.mts';

const guid = (seed: string) => uuidToIfcGuid(uuidFromSeed(`ifc-git-corpus:${seed}`));
const ADDED_NAME = "'Corpus partition wall'";

function append(text: string, records: readonly string[]): string {
  const at = text.lastIndexOf('ENDSEC;');
  if (at < 0) throw new Error('Corpus source has no final DATA section terminator');
  return `${text.slice(0, at)}${records.join('\n')}\n${text.slice(at)}`;
}

/** An explicit millimetre-space solid, independent of the base export's BReps. */
function wallRecords(first: number, id: string, x: number, width: number, context: number, owner: string): string[] {
  const r = (offset: number) => first + offset;
  return [
    `#${r(0)}=IFCCARTESIANPOINT((${x}.,20000.,0.));`,
    `#${r(1)}=IFCAXIS2PLACEMENT3D(#${r(0)},$,$);`,
    `#${r(2)}=IFCLOCALPLACEMENT($,#${r(1)});`,
    `#${r(3)}=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,${width}.,200.);`,
    `#${r(4)}=IFCDIRECTION((0.,0.,1.));`,
    `#${r(5)}=IFCEXTRUDEDAREASOLID(#${r(3)},$,#${r(4)},3000.);`,
    `#${r(6)}=IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${r(5)}));`,
    `#${r(7)}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${r(6)}));`,
    `#${r(8)}=IFCWALL('${id}',${owner},${ADDED_NAME},$,$,#${r(2)},#${r(7)},'corpus-partition',.PARTITIONING.);`,
  ];
}

function containment(index: Map<number, StepLine>): StepLine {
  const rel = findByType(index, 'IFCRELCONTAINEDINSPATIALSTRUCTURE')[0];
  if (!rel) throw new Error('Corpus base has no spatial containment');
  return rel;
}

export const addElement: Transform = text => {
  const lines = text.split('\n'), index = indexLines(lines);
  const context = findByType(index, 'IFCGEOMETRICREPRESENTATIONSUBCONTEXT')[0];
  const source = findByType(index, 'IFCWALL')[0];
  if (!context || !source) throw new Error('Corpus base requires a wall and representation subcontext');
  const first = Math.max(...index.keys()) + 1;
  const id = guid('added-partition');
  const rel = containment(index), args = splitArgs(rel.args);
  args[4] = args[4].replace(/\)$/, `,#${first + 8})`);
  rewriteRecord(lines, rel, args);
  return { text: append(lines.join('\n'), wallRecords(first, id, 20000, 4000, context.id, splitArgs(source.args)[1])),
    touched: [id], expectComponents: [], note: 'one new 4 m by 0.2 m by 3 m partition, contained in the existing building; original products unchanged' };
};

export const addClassification: Transform = text => {
  const index = indexLines(text.split('\n'));
  const wall = findByType(index, 'IFCWALL')[0];
  if (!wall) throw new Error('Corpus has no wall to classify');
  const first = Math.max(...index.keys()) + 1;
  const records = [
    `#${first}=IFCCLASSIFICATION('Corpus','1',$,'Corpus classes',$,$,$);`,
    `#${first + 1}=IFCCLASSIFICATIONREFERENCE($,'W-01','Partition',#${first},$,$);`,
    `#${first + 2}=IFCRELASSOCIATESCLASSIFICATION('${guid('classification-association')}',${splitArgs(wall.args)[1]},$,$,(#${wall.id}),#${first + 1});`,
  ];
  return { text: append(text, records), touched: [globalIdOf(wall)!], expectComponents: ['classification'],
    note: 'a real IfcClassificationReference association is added; no replacement property is used' };
};

export const splitAddedElement: Transform = text => {
  const lines = text.split('\n'), index = indexLines(lines);
  const source = findByType(index, 'IFCWALL').find(wall => splitArgs(wall.args)[2] === ADDED_NAME);
  if (!source) throw new Error('Corpus added partition missing before split');
  const product = splitArgs(source.args);
  const shape = index.get(Number(product[6].slice(1)))!;
  const rep = index.get(Number(splitArgs(shape.args)[2].match(/#(\d+)/)![1]))!;
  const context = Number(splitArgs(rep.args)[0].slice(1));
  const first = Math.max(...index.keys()) + 1;
  const ids = [guid('split-partition-left'), guid('split-partition-right')];
  const added = [
    ...wallRecords(first, ids[0], 19000, 2000, context, product[1]),
    ...wallRecords(first + 9, ids[1], 21000, 2000, context, product[1]),
  ];
  // The two adjacent half-solids replace one source product. The old, now
  // unreferenced representation resources are harmless; no other product uses them.
  const rel = findByType(index, 'IFCRELCONTAINEDINSPATIALSTRUCTURE').find(rel =>
    new RegExp(`#${source.id}(?![0-9])`).test(splitArgs(rel.args)[4]));
  if (!rel) throw new Error('Partition has no containment before split');
  const args = splitArgs(rel.args);
  args[4] = args[4].replace(new RegExp(`#${source.id}(?![0-9])`), `#${first + 8},#${first + 17}`);
  rewriteRecord(lines, rel, args);
  lines.splice(source.index, 1);
  return { text: append(lines.join('\n'), added), touched: [globalIdOf(source)!, ...ids], expectComponents: [],
    note: 'one 4 m partition replaced by two adjacent 2 m partitions, with identical data content; 1-to-2 matching must abstain' };
};
