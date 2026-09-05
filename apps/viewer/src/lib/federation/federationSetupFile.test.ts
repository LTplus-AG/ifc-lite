/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { FederatedModel } from '../../store/types.js';
import {
  buildFederationSetupFile,
  serializeFederationSetupFile,
  parseFederationSetupFile,
  matchFederationSetupSlots,
  summarizeFederationSetupMatches,
  FEDERATION_SETUP_FORMAT_VERSION,
} from './federationSetupFile.js';

/** Build a real `FederatedModel` (not a hand-shaped fixture) with a real `File` source. */
function makeModel(overrides: Partial<FederatedModel> & { name: string; bytes: string }): FederatedModel {
  const { bytes, ...rest } = overrides;
  const file = new File([bytes], overrides.name, { type: 'application/octet-stream' });
  const model: FederatedModel = {
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name,
    ifcDataStore: null,
    geometryResult: null,
    visible: overrides.visible ?? true,
    collapsed: overrides.collapsed ?? false,
    schemaVersion: overrides.schemaVersion ?? 'IFC4',
    loadedAt: overrides.loadedAt ?? Date.now(),
    fileSize: file.size,
    sourceFile: file,
    idOffset: 0,
    maxExpressId: 0,
    federationAlignmentStatus: overrides.federationAlignmentStatus,
  };
  return { ...model, ...rest };
}

describe('buildFederationSetupFile / parseFederationSetupFile round trip', () => {
  it('round-trips slot data exactly, marking the anchor', async () => {
    const arch = makeModel({ name: 'ARCH.ifc', bytes: 'architecture-bytes' });
    const struct = makeModel({ name: 'STRUCT.ifc', bytes: 'structure-bytes', visible: false, collapsed: true });

    const setup = await buildFederationSetupFile([arch, struct], arch.id);
    const json = serializeFederationSetupFile(setup);
    const parsed = parseFederationSetupFile(json);

    assert.strictEqual(parsed.ok, true);
    if (!parsed.ok) return;
    assert.strictEqual(parsed.setup.formatVersion, FEDERATION_SETUP_FORMAT_VERSION);
    assert.strictEqual(parsed.setup.slots.length, 2);
    assert.strictEqual(parsed.setup.slots[0].name, 'ARCH.ifc');
    assert.strictEqual(parsed.setup.slots[0].anchor, true);
    assert.strictEqual(parsed.setup.slots[0].visible, true);
    assert.strictEqual(parsed.setup.slots[1].name, 'STRUCT.ifc');
    assert.strictEqual(parsed.setup.slots[1].anchor, false);
    assert.strictEqual(parsed.setup.slots[1].visible, false);
    assert.strictEqual(parsed.setup.slots[1].collapsed, true);
    assert.strictEqual(typeof parsed.setup.slots[0].fingerprintHex, 'string');
  });

  it('is deterministic: saving the same state twice produces byte-identical JSON', async () => {
    const model = makeModel({ name: 'MEP.ifc', bytes: 'mep-bytes' });
    const a = serializeFederationSetupFile(await buildFederationSetupFile([model], model.id));
    const b = serializeFederationSetupFile(await buildFederationSetupFile([model], model.id));
    assert.strictEqual(a, b);
  });

  it('records null fingerprint when a model has no retained source file', async () => {
    const model = makeModel({ name: 'CACHED.ifc', bytes: 'x' });
    delete (model as { sourceFile?: File }).sourceFile;
    const setup = await buildFederationSetupFile([model], null);
    assert.strictEqual(setup.slots[0].fingerprintHex, null);
    assert.strictEqual(setup.slots[0].anchor, false);
  });
});

describe('parseFederationSetupFile validation (fails loudly on malformed input)', () => {
  it('rejects non-JSON', () => {
    const result = parseFederationSetupFile('not json{');
    assert.strictEqual(result.ok, false);
  });

  it('rejects a wrong format version instead of silently coercing', () => {
    const result = parseFederationSetupFile(JSON.stringify({ formatVersion: 99, slots: [] }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /Unsupported federation setup version/);
  });

  it('rejects zero slots', () => {
    const result = parseFederationSetupFile(JSON.stringify({ formatVersion: 1, slots: [] }));
    assert.strictEqual(result.ok, false);
  });

  it('rejects more than one anchor slot', () => {
    const badSlot = {
      name: 'A.ifc', fileSize: 1, fingerprintHex: null, visible: true, collapsed: false, anchor: true,
    };
    const result = parseFederationSetupFile(JSON.stringify({ formatVersion: 1, slots: [badSlot, badSlot] }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /Exactly one slot may be the anchor/);
  });

  it('rejects a slot missing a required field rather than defaulting it', () => {
    const badSlot = { name: 'A.ifc', fileSize: 1, fingerprintHex: null, visible: true, collapsed: false };
    const result = parseFederationSetupFile(JSON.stringify({ formatVersion: 1, slots: [badSlot] }));
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /anchor must be a boolean/);
  });
});

describe('matchFederationSetupSlots', () => {
  it('matches a present model fully by content fingerprint even if renamed', async () => {
    const original = makeModel({ name: 'ARCH.ifc', bytes: 'same-content' });
    const setup = await buildFederationSetupFile([original], original.id);
    const renamedFile = new File(['same-content'], 'ARCH-renamed.ifc', { type: 'application/octet-stream' });

    const matches = await matchFederationSetupSlots(setup, [renamedFile]);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].confidence, 'content');
    assert.strictEqual(matches[0].file, renamedFile);
  });

  it('reports missing when no candidate file is provided', async () => {
    const original = makeModel({ name: 'ARCH.ifc', bytes: 'content' });
    const setup = await buildFederationSetupFile([original], null);

    const matches = await matchFederationSetupSlots(setup, []);
    assert.strictEqual(matches[0].confidence, 'none');
    assert.strictEqual(matches[0].file, null);
  });

  it('does not let two same-named slots collide on one local file (content disambiguates)', async () => {
    // The keyed-write trap: two distinct models were federated under the
    // SAME filename (e.g. two revisions both called "MODEL.ifc"). Reopening
    // with both distinct local files present must match each slot to its
    // own content, never both to the first file found by name.
    const modelA = makeModel({ name: 'MODEL.ifc', bytes: 'revision-A-content' });
    const modelB = makeModel({ name: 'MODEL.ifc', bytes: 'revision-B-content' });
    const setup = await buildFederationSetupFile([modelA, modelB], null);

    const fileA = new File(['revision-A-content'], 'MODEL.ifc', { type: 'application/octet-stream' });
    const fileB = new File(['revision-B-content'], 'MODEL.ifc', { type: 'application/octet-stream' });

    // Provide files in the OPPOSITE order from the slots to prove matching
    // isn't just consuming candidates positionally.
    const matches = await matchFederationSetupSlots(setup, [fileB, fileA]);
    assert.strictEqual(matches[0].confidence, 'content');
    assert.strictEqual(matches[0].file, fileA); // slot 0 (revision A) -> fileA
    assert.strictEqual(matches[1].confidence, 'content');
    assert.strictEqual(matches[1].file, fileB); // slot 1 (revision B) -> fileB
  });

  it('does not double-assign one local file to two slots when only one copy is present', async () => {
    const modelA = makeModel({ name: 'MODEL.ifc', bytes: 'revision-A-content' });
    const modelB = makeModel({ name: 'MODEL.ifc', bytes: 'revision-B-content' });
    const setup = await buildFederationSetupFile([modelA, modelB], null);

    const fileA = new File(['revision-A-content'], 'MODEL.ifc', { type: 'application/octet-stream' });

    const matches = await matchFederationSetupSlots(setup, [fileA]);
    const matchedFiles = matches.map((m) => m.file);
    assert.strictEqual(matchedFiles.filter((f) => f === fileA).length, 1);
    assert.strictEqual(matches.filter((m) => m.confidence === 'none').length, 1);
  });

  it('falls back to name-only and flags it when size/content differ (same name, different file)', async () => {
    const original = makeModel({ name: 'ARCH.ifc', bytes: 'old-content-longer-than-new' });
    const setup = await buildFederationSetupFile([original], null);
    const different = new File(['new'], 'ARCH.ifc', { type: 'application/octet-stream' });

    const matches = await matchFederationSetupSlots(setup, [different]);
    assert.strictEqual(matches[0].confidence, 'name-only');
    assert.strictEqual(matches[0].file, different);
  });
});

describe('summarizeFederationSetupMatches', () => {
  it('classifies a full restore as fully resolved with nothing missing or mismatched', async () => {
    const modelA = makeModel({ name: 'A.ifc', bytes: 'a' });
    const modelB = makeModel({ name: 'B.ifc', bytes: 'b' });
    const setup = await buildFederationSetupFile([modelA, modelB], modelA.id);
    const fileA = new File(['a'], 'A.ifc');
    const fileB = new File(['b'], 'B.ifc');
    const matches = await matchFederationSetupSlots(setup, [fileA, fileB]);

    const summary = summarizeFederationSetupMatches(matches);
    assert.strictEqual(summary.total, 2);
    assert.strictEqual(summary.resolved.length, 2);
    assert.strictEqual(summary.missing.length, 0);
    assert.strictEqual(summary.mismatched.length, 0);
  });

  it('never counts a missing slot as resolved (partial restore must be visible)', async () => {
    const modelA = makeModel({ name: 'A.ifc', bytes: 'a' });
    const modelB = makeModel({ name: 'B.ifc', bytes: 'b' });
    const setup = await buildFederationSetupFile([modelA, modelB], null);
    const fileA = new File(['a'], 'A.ifc');
    const matches = await matchFederationSetupSlots(setup, [fileA]); // B.ifc not provided

    const summary = summarizeFederationSetupMatches(matches);
    assert.strictEqual(summary.resolved.length, 1);
    assert.strictEqual(summary.missing.length, 1);
    assert.strictEqual(summary.missing[0].slot.name, 'B.ifc');
  });

  it('surfaces a name-only match as mismatched, not resolved (must not silently accept a different file)', async () => {
    const modelA = makeModel({ name: 'A.ifc', bytes: 'original-content' });
    const setup = await buildFederationSetupFile([modelA], null);
    const different = new File(['different'], 'A.ifc');
    const matches = await matchFederationSetupSlots(setup, [different]);

    const summary = summarizeFederationSetupMatches(matches);
    assert.strictEqual(summary.resolved.length, 0);
    assert.strictEqual(summary.mismatched.length, 1);
  });
});
