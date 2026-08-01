#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * B5.2 adjudication pass: for every defect the detectors FIRED on a foreign
 * model, decide by hand-checkable evidence whether it is a real defect in a
 * delivered file or a false positive.
 *
 * This is the pass that turns "the detector said true" into a number the
 * report can stand behind. On a synthetic model the answer is free (the
 * program planted the defect, so it knows). On a delivered file nothing is
 * free, so each fired type gets its own probe:
 *
 *  - `missing-quantities` (oracle):  the rule is
 *    `quantifiableElements - elementsWithQuantities > unmeshedColumns` over
 *    quantities re-read from the pset literally named `GymQuantities`. This
 *    probe measures what fraction of the SAME elements carry authored
 *    IfcElementQuantity under any name. High coverage means the verdict is a
 *    naming artifact, not a data defect.
 *
 *  - `missing-quantities` (heuristic): the rule is "some IfcElementQuantity is
 *    not bound by an IfcRelDefinesByProperties". Type-level quantity sets
 *    (bound through IfcRelDefinesByType / IfcTypeObject.HasPropertySets) are a
 *    legitimate authoring pattern that looks unbound to that regex, so this
 *    probe splits the unbound set into type-attached and genuinely orphan.
 *
 *  - `duplicate-globalid` (heuristic): the rule counts any repeated 22-char
 *    base64 first attribute. The kernel only checks GlobalId on IfcRoot
 *    subtypes. This probe reports which ENTITY TYPES carry the repeats and
 *    whether any of them is rooted - if none is, the kernel is right and the
 *    heuristic is matching something that is not a GlobalId at all.
 *
 *  - `clash-pair` (heuristic): the rule is `IFCFOOTING > 0`. The probe is the
 *    footing count against the clash engine's actual footing-self-clash count.
 *
 *  - `degenerate-geometry` (oracle): the rule is "an IfcColumn produced no
 *    mesh". The probe asks whether those columns declare a Representation at
 *    all (IfcProduct attribute index 6). No representation = the element
 *    genuinely has no geometry to mesh, which is a property of the file;
 *    a declared representation that produced nothing is a kernel finding.
 *
 * PRIVACY: only counts, IFC type names and express-id COUNTS leave this pass.
 * No GlobalId values, no names, no coordinates.
 *
 * Usage:
 *   node --max-old-space-size=10240 run-adjudication-pass.mjs \
 *     --model <abs path> --alias model-a --out <dir>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseStore, clashCheckInProcess, initChecks } from '../../../tools/world-gym/lib/checks.mjs';
import { modelId, round } from './lib/model-id.mjs';

const { EntityNode } = await import('../../../packages/query/dist/index.js');
const { EntityExtractor } = await import('../../../packages/parser/dist/index.js');

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const modelPath = flag('--model');
const alias = flag('--alias');
const outDir = flag('--out');
if (!modelPath || !alias || !outDir) {
  process.stderr.write('Usage: run-adjudication-pass.mjs --model <path> --alias <id> --out <dir>\n');
  process.exit(2);
}

const bytes = await readFile(modelPath);
const id = modelId(bytes);
await initChecks();
const store = await parseStore(bytes, `${alias}.ifc`);
const content = bytes.toString('utf-8');

// ---------------------------------------------------------------------------
// Probe 1 + 2: quantity binding
// ---------------------------------------------------------------------------
const DEF_RE = /^#(\d+)=([A-Z0-9_]+)\(/;
const typeById = new Map();
const qsetIds = new Set();
const boundByRelDefinesByProperties = new Set();
const typeObjectPsetRefs = new Set(); // qsets reachable from a type object's HasPropertySets
let relDefinesByPropertiesLines = 0;
let relDefinesByPropertiesParsedByHeuristicRegex = 0;

const lines = content.split('\n');
for (const line of lines) {
  const m = DEF_RE.exec(line);
  if (!m) continue;
  typeById.set(m[1], m[2]);
  if (m[2] === 'IFCELEMENTQUANTITY') qsetIds.add(m[1]);
}
for (const line of lines) {
  const m = DEF_RE.exec(line);
  if (!m) continue;
  const body = line.slice(line.indexOf('=') + 1);
  if (m[2] === 'IFCRELDEFINESBYPROPERTIES') {
    relDefinesByPropertiesLines += 1;
    // the heuristic baseline's own regex, reproduced to measure ITS coverage
    if (/,\(([^()]*)\),#(\d+)\);$/.exec(line)) relDefinesByPropertiesParsedByHeuristicRegex += 1;
    // structural truth: the LAST #ref on the line is the RelatingPropertyDefinition
    const refs = body.match(/#\d+/g) ?? [];
    const last = refs[refs.length - 1]?.slice(1);
    if (last && qsetIds.has(last)) boundByRelDefinesByProperties.add(last);
  } else if (/^IFC[A-Z0-9]*TYPE$/.test(m[2]) || m[2] === 'IFCDOORSTYLE' || m[2] === 'IFCWINDOWSTYLE') {
    for (const ref of body.match(/#\d+/g) ?? []) {
      const r = ref.slice(1);
      if (qsetIds.has(r)) typeObjectPsetRefs.add(r);
    }
  }
}
const orphanQsets = [...qsetIds].filter((q) => !boundByRelDefinesByProperties.has(q) && !typeObjectPsetRefs.has(q));

// ---------------------------------------------------------------------------
// Probe 3: the heuristic's 22-char "GlobalId" scan, by entity type
// ---------------------------------------------------------------------------
const guidFirstAttr = new Map(); // 22-char value -> [entity ids]
for (const line of lines) {
  const m = DEF_RE.exec(line);
  if (!m) continue;
  const body = line.slice(line.indexOf('=') + 1);
  const first = /^[A-Z0-9_]+\('([^']+)'/.exec(body)?.[1];
  if (first !== undefined && /^[0-9A-Za-z_$]{22}$/.test(first)) {
    const arr = guidFirstAttr.get(first) ?? [];
    arr.push(m[1]);
    guidFirstAttr.set(first, arr);
  }
}
const duplicateGroups = [...guidFirstAttr.values()].filter((ids) => ids.length > 1);
const duplicateTypeCounts = {};
for (const ids of duplicateGroups) {
  for (const eid of ids) {
    const t = typeById.get(eid) ?? 'UNKNOWN';
    duplicateTypeCounts[t] = (duplicateTypeCounts[t] ?? 0) + 1;
  }
}

// ---------------------------------------------------------------------------
// Probe 4: footings vs the clash engine
// ---------------------------------------------------------------------------
const footingCount = (store.entityIndex.byType.get('IFCFOOTING') ?? []).length;

// ---------------------------------------------------------------------------
// Probe 5: unmeshed IfcColumns - do they declare a Representation?
// ---------------------------------------------------------------------------
const columnIds = store.entityIndex.byType.get('IFCCOLUMN') ?? [];
const clash = await clashCheckInProcess(store, `${alias}.ifc`, columnIds);
// clashCheckInProcess reports failure in-band as { ok: false, error }. Reading
// probesMeshed off a failed run yields an EMPTY probe map, which reads as
// "every column meshed" and would quietly adjudicate the degenerate-geometry
// verdict as unfounded on the strength of a crash. Fail the pass instead.
if (!clash.ok) {
  process.stderr.write(`clash probe failed, cannot adjudicate: ${clash.error ?? 'unknown error'}\n`);
  process.exit(1);
}
if (!clash.probesMeshed || Object.keys(clash.probesMeshed).length !== columnIds.length) {
  process.stderr.write(`clash probe returned ${Object.keys(clash.probesMeshed ?? {}).length} results for ${columnIds.length} columns\n`);
  process.exit(1);
}
const unmeshedIds = Object.entries(clash.probesMeshed)
  .filter(([, meshed]) => !meshed)
  .map(([eid]) => Number(eid));

// The representation probe reads raw STEP through the retained source bytes.
// A store that dropped them would make every unmeshed column look like it
// declares no Representation at all - the exact opposite of this pass's
// finding - so it is checked rather than assumed.
if (!store.source || store.source.byteLength === 0) {
  process.stderr.write('store did not retain source bytes; cannot run the representation probe\n');
  process.exit(1);
}
const extractor = new EntityExtractor(store.source);
const entityOf = (eid) => {
  const ref = store.entityIndex.byId.get(eid);
  return ref ? extractor.extractEntity(ref) : null;
};
let unmeshedWithRepresentation = 0;
let unmeshedWithoutRepresentation = 0;
// What KIND of representation did an unmeshed column declare? A column whose
// only shape is an annotation or a bounding box has no body to mesh (so the
// verdict is an artifact of the probe); a swept solid that produced nothing is
// a kernel finding. The histogram is what separates those two readings.
const repTypeCounts = {};
const repItemTypeCounts = {};
for (const eid of unmeshedIds) {
  const ent = entityOf(eid);
  // IfcProduct attribute 6 = Representation (0 GlobalId .. 5 ObjectPlacement)
  const rep = ent?.attributes?.[6];
  if (typeof rep !== 'number') { unmeshedWithoutRepresentation += 1; continue; }
  unmeshedWithRepresentation += 1;
  // IfcProductDefinitionShape attribute 2 = Representations
  const shape = entityOf(rep);
  const repList = shape?.attributes?.[2];
  for (const sr of Array.isArray(repList) ? repList : []) {
    if (typeof sr !== 'number') continue;
    // IfcShapeRepresentation: 0 ContextOfItems, 1 RepresentationIdentifier,
    // 2 RepresentationType, 3 Items
    const srEnt = entityOf(sr);
    const ident = typeof srEnt?.attributes?.[1] === 'string' ? srEnt.attributes[1] : '(unset)';
    const rtype = typeof srEnt?.attributes?.[2] === 'string' ? srEnt.attributes[2] : '(unset)';
    const key = `${ident}/${rtype}`;
    repTypeCounts[key] = (repTypeCounts[key] ?? 0) + 1;
    const items = srEnt?.attributes?.[3];
    for (const it of Array.isArray(items) ? items : []) {
      if (typeof it !== 'number') continue;
      const t = store.entities.getTypeName(it) || 'UNKNOWN';
      repItemTypeCounts[t] = (repItemTypeCounts[t] ?? 0) + 1;
    }
  }
}

// Same question for every quantifiable element, as the denominator.
const meshedColumnCount = columnIds.length - unmeshedIds.length;

const out = {
  bet: 'B5.2',
  pass: 'adjudication',
  alias,
  modelSha256Prefix: id,
  bytes: bytes.byteLength,
  quantityBinding: {
    elementQuantitySets: qsetIds.size,
    boundByRelDefinesByProperties: boundByRelDefinesByProperties.size,
    reachableFromTypeObject: typeObjectPsetRefs.size,
    orphanQuantitySets: orphanQsets.length,
    orphanPct: qsetIds.size > 0 ? round((orphanQsets.length / qsetIds.size) * 100, 4) : null,
    relDefinesByPropertiesLines,
    relDefinesByPropertiesParsedByHeuristicRegex,
    heuristicRegexCoveragePct: relDefinesByPropertiesLines > 0
      ? round((relDefinesByPropertiesParsedByHeuristicRegex / relDefinesByPropertiesLines) * 100, 4) : null,
  },
  globalIdScan: {
    distinct22CharFirstAttributes: guidFirstAttr.size,
    duplicateGroups: duplicateGroups.length,
    entitiesInDuplicateGroups: duplicateGroups.reduce((a, ids) => a + ids.length, 0),
    duplicateGroupsByEntityType: Object.fromEntries(
      Object.entries(duplicateTypeCounts).sort((a, b) => b[1] - a[1]).slice(0, 12),
    ),
    kernelUniqueGlobalIdErrors: 0, // filled below from the kernel's own verdict
  },
  footings: {
    ifcFootingCount: footingCount,
    footingSelfClashesFound: clash.byRule?.['gym-footing-self'] ?? 0,
    totalClashes: clash.total ?? 0,
  },
  unmeshedColumns: {
    totalColumns: columnIds.length,
    meshedColumns: meshedColumnCount,
    unmeshedColumns: unmeshedIds.length,
    unmeshedPct: columnIds.length > 0 ? round((unmeshedIds.length / columnIds.length) * 100, 4) : null,
    unmeshedDeclaringRepresentation: unmeshedWithRepresentation,
    unmeshedDeclaringNoRepresentation: unmeshedWithoutRepresentation,
    unmeshedRepresentationIdentifierAndType: repTypeCounts,
    unmeshedRepresentationItemTypes: repItemTypeCounts,
  },
};

// The kernel's own duplicate-GlobalId verdict, from the same check the
// benchmark's oracle consults.
const { schemaCheckInProcess } = await import('../../../tools/world-gym/lib/checks.mjs');
const schema = schemaCheckInProcess(store);
out.globalIdScan.kernelUniqueGlobalIdErrors = schema.issues.filter((i) => i.rule === 'unique-globalid').length;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, `adjudication-${alias}.json`), `${JSON.stringify(out, null, 2)}\n`, 'utf-8');
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
