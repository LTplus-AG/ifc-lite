/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Output contract for linked-records conversations; every proposal is reviewed before anything runs or is saved. */
export const SEMANTIC_OUTPUT_GUIDANCE = [
  'Linked records: you cannot run queries, contact endpoints or change data. For a typed proposal return only one JSON object.',
  'Query: {"version":1,"kind":"semantic.query","title":"…","purpose":"…","query":"PREFIX … SELECT ?id ?GlobalId WHERE { … } LIMIT 100",'
  + '"expected":{"form":"select","columns":["id","GlobalId"]},"mapping":{"GlobalId":"GlobalId","modelRevision":"modelRevision","id":"id"}}.'
  + ' SELECT or CONSTRUCT only, named columns, an outer LIMIT of at most 5000, no SERVICE, no FROM, no UPDATE. "mapping" is optional.',
  'Mapping: {"version":1,"kind":"semantic.mapping","title":"…","modelRevision":"<revision from evidence>","mappings":[{"ifc":{"class":"IfcDoor",'
  + '"pset":"Pset_DoorCommon","property":"FireRating"},"ontology":{"property":"fireRating"},"confidence":0.8,"rationale":"…",'
  + '"sources":[{"source":"S1","start":120,"end":168,"quote":"…"}]}],"unsupported":[{"text":"…","reason":"…"}]}.'
  + ' Map class to class or property to property; ontology terms are profile keys/IRIs or absolute IRIs. Use only an associated revision.',
  'Projection: {"version":1,"kind":"semantic.projection","title":"…","projections":[{"resource":"<installation record id>","field":"fireRating","policy":"error"}]}'
  + ' using only fields listed in projectionMappings; policy is error, skip or overwrite.',
  'Requirements: {"version":1,"kind":"semantic.requirements","title":"…","requirements":[{"id":"R1","statement":"…","appliesTo":{"ifcClass":"IfcDoor"},'
  + '"property":"FireRating","operator":"equals","value":"EI30","unit":"…","span":{"source":"S1","start":0,"end":42,"quote":"…"}}],'
  + '"unsupported":[{"text":"…","reason":"ambiguous …","span":{…}}]}. Operators: equals, notEquals, atLeast, atMost, exists, oneOf, matches.',
  'Spans: copy quote exactly from one captured passage; start = passage.start + index within passage.text; end = start + quote length.'
  + ' Never paraphrase a quote. Keep ambiguous, conditional or unsupported statements in "unsupported" with a reason instead of guessing.',
].join('\n');
