/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Private preparation child, never a CI gate or a measurement entry point.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OPTIONS, LIMITS, resultProof, digest } from './diff-e2e-protocol.mjs';

const NAME_TYPES = ['IfcWall', 'IfcWallStandardCase', 'IfcSlab', 'IfcDoor', 'IfcWindow'];
const [mode, root, input, output, recipePath] = process.argv.slice(2);
const load = path => import(pathToFileURL(resolve(root, path)).href);
const json = path => readFile(path, 'utf8').then(JSON.parse);
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

if (mode === 'oracle') {
  const base = await json(input), head = await json(output);
  assert.equal(base.length, head.length);
  const recipe = await json(recipePath);
  const targets = new Set(recipe.targets.map(t => t.expressId));
  const byId = new Map(head.map(row => [row.ref, row]));
  const modifiedIds = [];
  for (const row of base) {
    const next = byId.get(row.ref);
    assert.ok(next, `lost #${row.ref}`);
    assert.equal(next.key, row.key, `identity changed #${row.ref}`);
    if (targets.has(row.ref)) {
      assert.notEqual(next.dataHash, row.dataHash, `Name edit missing #${row.ref}`);
      modifiedIds.push(row.ref);
    } else assert.deepEqual(next, row, `unexpected fingerprint change #${row.ref}`);
  }
  modifiedIds.sort((a, b) => a - b);
  assert.deepEqual(modifiedIds, [...targets].sort((a, b) => a - b));
  const { loadDiffOracle } = await load('scripts/lib/diff-oracle.mjs');
  const { diffModels } = await loadDiffOracle();
  const expectations = OPTIONS.map(options => {
    const result = diffModels(base, head, options);
    assert.deepEqual(result.counts, { added: 0, modified: targets.size, deleted: 0,
      unchanged: base.length - targets.size });
    const distribution = {};
    for (const match of result.contentMatches ?? []) {
      const key = `${match.kind}/${match.tier ?? 'absent'}`;
      distribution[key] = (distribution[key] ?? 0) + 1;
    }
    assert.equal(result.contentMatches?.length ?? 0, 0, 'same identities need no content matches');
    assert.equal(result.splitMerges?.length ?? 0, 0);
    assert.equal(result.successors?.length ?? 0, 0);
    return { options, proof: resultProof(result, base, head), counts: result.counts,
      contentMatchCount: result.contentMatches?.length ?? 0, contentMatchDistribution: distribution,
      splitMerges: result.splitMerges?.length ?? 0, successors: result.successors?.length ?? 0 };
  });
  await save(`${output}.expected.json`, { modifiedIds,
    modifiedFraction: modifiedIds.length / base.length,
    unchangedCount: base.length - modifiedIds.length, expectations });
} else {
  assert.ok(['select', 'inspect'].includes(mode));
  const parser = await load('packages/parser/dist/index.js');
  const loader = await load('packages/cli/dist/loader.js');
  const adapter = await load('packages/cli/dist/commands/diff-engine.js');
  const scope = await load('packages/cli/dist/commands/diff-scope.js');
  const { initDiff } = await load('packages/diff/dist/index.js');
  await initDiff(); // Public shared runtime required by synchronous fingerprint builders.
  // Exactly the context/query path used by CLI mutate --type; one store only.
  const { store, bim } = await loader.createHeadlessContext(input);
  assert.deepEqual(loader.scanCompletenessWarnings(store), [], 'full scan required');
  assert.ok(store.sourceHeader, 'source attribution unavailable');
  let objectDefinitionCount = 0;
  for (const [type, ids] of store.entityIndex.byType) {
    const chain = parser.getInheritanceChainAcrossSchemas(type);
    assert.ok(chain.length > 0, `unclassified ${type}: cannot certify exact subtype count`);
    if (chain.includes('IfcObjectDefinition')) objectDefinitionCount += ids.length;
  }
  const entities = [...scope.comparableEntities(store)].sort((a, b) => a.expressId - b.expressId);
  const rows = adapter.buildFileFingerprints(store);
  assert.ok(rows.length > 1 && rows.length <= LIMITS.rows);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'duplicate comparable keys');
  assert.equal(rows.length, entities.length);
  const counts = { storeEntityCount: store.entityCount, indexedEntityCount: store.entityIndex.byId.size,
    IfcObjectDefinition: objectDefinitionCount, comparable: entities.length,
    comparableEqualsIfcObjectDefinition: entities.length === objectDefinitionCount,
    scopeExplanation: 'Schema inheritance counts every indexed IfcObjectDefinition; comparableEntities requires a nonempty GlobalId and may retain unknown vendor types. Equality is checked from actual counts, never assumed.' };
  assert.equal(counts.storeEntityCount, counts.indexedEntityCount, 'store/index mismatch');
  const extractor = new parser.EntityExtractor(store.source);
  if (mode === 'select') {
    const queries = NAME_TYPES.map(ifcType => ({ ifcType,
      entities: bim.query().byType(ifcType).toArray().sort((a, b) => a.ref.expressId - b.ref.expressId) }));
    // Stable sort preserves NAME_TYPES precedence on equal populations.
    queries.sort((a, b) => b.entities.length - a.entities.length);
    const chosen = queries[0];
    assert.ok(chosen.entities.length > 0, 'no meaningful nonempty canonical query targets');
    const newName = 'IFC-Lite #8042 controlled Name revision';
    const comparableIds = new Set(entities.map(e => e.expressId));
    const targets = chosen.entities.map(entity => {
      assert.ok(parser.getInheritanceChainAcrossSchemas(entity.type).includes(chosen.ifcType),
        `unexpected canonical query subtype ${entity.type}`);
      assert.ok(comparableIds.has(entity.ref.expressId), 'target outside comparable scope');
      const parsed = extractor.extractEntity(store.entityIndex.byId.get(entity.ref.expressId));
      assert.ok(parsed);
      assert.notEqual(entity.name, newName, 'target already has requested Name');
      return { expressId: entity.ref.expressId, ifcType: entity.type, oldKey: entity.globalId,
        newKey: entity.globalId, oldName: entity.name, attributesBefore: parsed.attributes };
    });
    assert.equal(new Set(targets.map(t => t.expressId)).size, targets.length);
    const unchanged = rows.length - targets.length;
    assert.ok(unchanged >= Math.max(100, targets.length),
      'preserve at least half the comparable objects and at least 100 unchanged; do not choose a smaller class');
    await save(recipePath, { version: 'ifc-large-controlled-revision/2',
      performanceVerdict: 'not-assessed', fullIssue8042Accepted: false,
      sourceSha256: process.env.IFC_SOURCE_SHA256, selectionTypes: NAME_TYPES,
      selection: 'most populous canonical bim.query().byType class; ties follow selectionTypes order; includes canonical subtype expansion',
      queryPopulations: queries.map(q => ({ ifcType: q.ifcType, count: q.entities.length })),
      queryType: chosen.ifcType, targets, newName,
      plannedModifiedFraction: targets.length / rows.length, unchangedCount: unchanged,
      counts, sourceHeader: store.sourceHeader });
  } else {
    const recipe = await json(recipePath);
    const actualIds = bim.query().byType(recipe.queryType).toArray()
      .map(e => e.ref.expressId).sort((a, b) => a - b);
    assert.deepEqual(actualIds, recipe.targets.map(t => t.expressId), 'canonical query targets changed');
    for (const target of recipe.targets) {
      const parsed = extractor.extractEntity(store.entityIndex.byId.get(target.expressId));
      assert.ok(parsed);
      const nameSlot = parser.getAttributeNamesAcrossSchemas(target.ifcType).indexOf('Name');
      assert.ok(nameSlot >= 0, 'schema Name slot unavailable');
      const expected = [...target.attributesBefore];
      expected[nameSlot] = recipe.newName;
      assert.deepEqual(parsed.attributes, expected, `unintended target attribute changes #${target.expressId}`);
    }
  }
  const records = [...store.entityIndex.byId.values()].sort((a, b) => a.byteOffset - b.byteOffset);
  const recordHash = createHash('sha256'), gapHash = createHash('sha256');
  let cursor = 0, recordBytes = 0;
  if (mode === 'inspect') {
    const header = store.sourceHeader;
    assert.equal(header.schemaIdentifiers.length, 1);
    assert.ok(typeof header.timeStamp === 'string' && header.timeStamp.length > 0,
      'emitted wall-time timestamp unavailable');
    // Reproduce the emitted prefix using the canonical header serializer.
    // Exact equality accounts for every prefix byte, without inventing a reader.
    const prefix = Buffer.from(parser.generateHeader({ ...header,
      schema: header.schemaIdentifiers[0], filename: header.name }));
    assert.ok(prefix.equals(Buffer.from(store.source.slice(0, prefix.length))),
      'generated header cannot account for complete emitted prefix');
    cursor = prefix.length;
  }
  for (const ref of records) {
    const { byteOffset: start, byteLength: length, expressId, type } = ref;
    assert.ok(start >= cursor && length > 0 && start + length <= store.source.byteLength,
      `invalid/overlapping indexed record #${expressId}`);
    const raw = store.source.slice(start, start + length);
    assert.equal(raw.byteLength, length);
    recordHash.update(JSON.stringify([expressId, type, length]) + '\n');
    recordHash.update(raw); recordBytes += length;
    gapHash.update(`${start - cursor}\n`); gapHash.update(store.source.slice(cursor, start));
    cursor = start + length;
  }
  gapHash.update(`${store.source.byteLength - cursor}\n`);
  gapHash.update(store.source.slice(cursor, store.source.byteLength));
  await save(output, rows);
  await save(`${output}.summary.json`, { counts, sourceHeader: store.sourceHeader, fullScan: true,
    canonicalFingerprintsSha256: digest(rows),
    indexedRecordBytes: recordBytes, indexedRecordsSha256: recordHash.digest('hex'),
    nonrecordBytesSha256: gapHash.digest('hex'),
    byteCoverage: mode === 'inspect' ? 'exact canonical regenerated header prefix + every indexed raw record + all intervening/trailing bytes' : 'source records and gaps including authored header' });
}
