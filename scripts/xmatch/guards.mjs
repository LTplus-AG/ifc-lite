/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The fixture's own integrity checks — everything that must hold about the two
 * files BEFORE a single match is scored.
 *
 * A fixture that shows nothing matched is a fixture bug until proven
 * otherwise. These turn each way that could happen into a named, fatal
 * failure, so a broken generator can never be read as a broken matcher.
 */

import { parseStepFile, splitArgs, unquote } from './step-file.mjs';
import { getInheritanceChainAcrossSchemas } from '../../packages/parser/dist/index.js';
import { isValidIfcGuid } from '../../packages/encoding/dist/index.js';

/**
 * Names of every property set, quantity set, property and quantity in a file.
 * The re-GUID trap detector: these must be IDENTICAL across the two files.
 *
 * The `IFCPROPERTY`/`IFCQUANTITY` PREFIX is not a safe rule on its own, and the
 * exception is exactly the kind this guard exists to catch: `IfcPropertyTemplate`
 * and `IfcPropertySetTemplate` share the prefix but derive from `IfcRoot`, so
 * their attribute 0 is a **GlobalId**, not a Name. Reading one as a property
 * name would record a deliberately regenerated GlobalId as drift and fail the
 * run for the one thing the mutator is supposed to do. The current corpus
 * contains no templates, so this would have stayed invisible until a corpus
 * change — which is precisely why it is decided from the schema registry (the
 * same anchored rule the re-GUID itself uses) rather than from the spelling.
 */
function propertyNames(text) {
  const file = parseStepFile(text);
  const names = [];
  for (const statement of file.statements) {
    if (!statement.type.startsWith('IFCPROPERTY') && !statement.type.startsWith('IFCQUANTITY')) {
      if (statement.type !== 'IFCELEMENTQUANTITY') continue;
    }
    const parts = splitArgs(statement.args);
    // WHICH SLOT holds the Name is decided by the inheritance chain, never by
    // the spelling. An `IfcRoot` subtype puts GlobalId in slot 0 and Name in
    // slot 2 (`IfcPropertySet`, `IfcElementQuantity`, and also
    // `IfcPropertyTemplate` / `IfcPropertySetTemplate`, which share the
    // `IFCPROPERTY` prefix); everything else — `IfcPropertySingleValue`,
    // `IfcQuantityLength` — is an unrooted resource entity with Name in slot 0.
    const rooted = getInheritanceChainAcrossSchemas(statement.type).includes('IfcRoot');
    names.push(`${rooted ? 'set' : 'item'}:${unquote(parts[rooted ? 2 : 0] ?? '$')}`);
  }
  return names.sort();
}

/**
 * GlobalIds (anchored: attribute 0 of an `IfcRoot`) and, separately, the
 * 22-character quoted tokens a NAIVE rewriter would have mistaken for them.
 *
 * Both are returned because the second set is the trap's own tripwire, and it
 * points the other way: those tokens — `Qto_WallBaseQuantities`,
 * `SpaceTemperatureSummer` — MUST survive into the head unchanged. The first
 * run of this fixture reported "3 GlobalIds survived the re-GUID" from a guard
 * that used the naive rule itself; the three were property names, and the
 * mutator had done exactly the right thing. A guard written to the shape of a
 * value repeats the bug it is meant to catch.
 */
function identifierSets(text) {
  const file = parseStepFile(text);
  const globals = new Set();
  const lookalikes = new Set();
  for (const statement of file.statements) {
    const first = String(splitArgs(statement.args)[0] ?? '').trim();
    if (!/^'[0-9A-Za-z_$]{22}'$/.test(first)) continue;
    const token = first.slice(1, -1);
    if (getInheritanceChainAcrossSchemas(statement.type).includes('IfcRoot')) globals.add(token);
    else lookalikes.add(token);
  }
  return { globals, lookalikes };
}

/**
 * The fixture's own integrity checks, run BEFORE anything is scored.
 *
 * A fixture that shows nothing matched is a fixture bug until proven
 * otherwise, so each of these turns a silent 0% into a named failure.
 */
export function runGuards(sourceText, headText, base, head, key) {
  const baseNames = propertyNames(sourceText);
  const headNames = propertyNames(headText);
  const namesIdentical =
    baseNames.length === headNames.length && baseNames.every((name, i) => name === headNames[i]);

  const baseIds = identifierSets(sourceText);
  const headIds = identifierSets(headText);
  let sharedGuids = 0;
  for (const id of headIds.globals) if (baseIds.globals.has(id)) sharedGuids++;
  let preservedLookalikes = 0;
  for (const token of baseIds.lookalikes) if (headIds.lookalikes.has(token)) preservedLookalikes++;

  // Every generated GlobalId must be one a real exporter could have written.
  // A 22-character IFC GlobalId encodes a 128-bit UUID, so its first character
  // carries two bits and must be `0`-`3`; the generator's first version drew it
  // from the full alphabet and produced 15/16 identifiers that no decoder would
  // round-trip. The fixture's premise is that the head revision is a PLAUSIBLE
  // re-export, so this is a claim about the fixture, checked rather than
  // assumed — and checked with the repository's own validator, so it cannot
  // drift from the repository's own generator.
  let invalidGuids = 0;
  for (const token of headIds.globals) if (!isValidIfcGuid(token)) invalidGuids++;

  const baseRefs = new Set(base.fingerprints.map((fingerprint) => fingerprint.ref));
  const headRefs = new Set(head.fingerprints.map((fingerprint) => fingerprint.ref));
  const keyedHeads = new Set(key.elements.flatMap((element) => element.head));
  let presentHeads = 0;
  for (const ref of keyedHeads) if (headRefs.has(ref)) presentHeads++;

  // Keys must not survive: if any GlobalId were shared the key-based pass would
  // match those entities directly and the content pass would never see them.
  const baseKeys = new Set(base.fingerprints.map((fingerprint) => fingerprint.key));
  let sharedKeys = 0;
  for (const fingerprint of head.fingerprints) if (baseKeys.has(fingerprint.key)) sharedKeys++;

  return {
    propertyNamesIdentical: namesIdentical,
    propertyNameCount: baseNames.length,
    propertyNameDrift: namesIdentical
      ? []
      : symmetricDifference(baseNames, headNames).slice(0, 10),
    sharedGlobalIds: sharedGuids,
    headGlobalIds: headIds.globals.size,
    invalidGlobalIds: invalidGuids,
    lookalikeTokens: baseIds.lookalikes.size,
    lookalikeTokensPreserved: preservedLookalikes,
    sharedFingerprintKeys: sharedKeys,
    keyedBasePopulation: key.elements.length,
    fingerprintedBasePopulation: baseRefs.size,
    keyedHeadsPresent: presentHeads,
    // Uniqueness, checked rather than assumed. `parseStepFile` now refuses a
    // duplicate express id, which closes the SOURCE of a collision; these
    // close the four places downstream that would silently absorb one if it
    // arrived another way. All four hold on the current corpus — they are here
    // so that stops being luck. Each is a scoring correctness property: a base
    // id claimed twice makes `expected` keep only the last row, a head id
    // claimed by two bases lets one wrong pair score as right, and a repeated
    // fingerprint ref makes the adapter's population disagree with the key's.
    duplicateKeyBaseIds: duplicates(key.elements.map((element) => element.base)).length,
    duplicateKeyHeadIds: duplicates([
      ...key.elements.flatMap((element) => element.head),
      ...key.insertedHeadIds,
    ]).length,
    duplicateBaseRefs: duplicates(base.fingerprints.map((f) => f.ref)).length,
    duplicateHeadRefs: duplicates(head.fingerprints.map((f) => f.ref)).length,
    keyedHeadsExpected: keyedHeads.size,
    baseHasGeometryHashes: base.fingerprints.some((f) => f.geometryHash !== undefined),
    headHasGeometryHashes: head.fingerprints.some((f) => f.geometryHash !== undefined),
  };
}

/** Values appearing more than once. */
function duplicates(values) {
  const seen = new Set();
  const repeated = new Set();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function symmetricDifference(a, b) {
  const countOf = (list) => {
    const map = new Map();
    for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
    return map;
  };
  const left = countOf(a);
  const right = countOf(b);
  const out = [];
  for (const [name, count] of left) if (right.get(name) !== count) out.push(`base:${name}`);
  for (const [name, count] of right) if (left.get(name) !== count) out.push(`head:${name}`);
  return out;
}

/** Guard failures are fixture failures, and they are fatal for that pair. */
export function guardFailures(guards) {
  const failures = [];
  if (!guards.propertyNamesIdentical) {
    failures.push(`property/quantity names changed: ${guards.propertyNameDrift.join(', ')}`);
  }
  if (guards.sharedGlobalIds > 0) failures.push(`${guards.sharedGlobalIds} GlobalIds survived the re-GUID`);
  if (guards.invalidGlobalIds > 0) {
    failures.push(
      `${guards.invalidGlobalIds} of ${guards.headGlobalIds} generated GlobalIds are not valid ` +
        'IFC GlobalIds (a 22-character GlobalId must start with 0-3)',
    );
  }
  if (guards.lookalikeTokensPreserved !== guards.lookalikeTokens) {
    failures.push(
      `${guards.lookalikeTokens - guards.lookalikeTokensPreserved} of ${guards.lookalikeTokens} ` +
        '22-character non-GlobalId tokens (property/quantity names) were rewritten',
    );
  }
  if (guards.sharedFingerprintKeys > 0) {
    failures.push(`${guards.sharedFingerprintKeys} fingerprint keys shared between revisions`);
  }
  if (guards.keyedBasePopulation !== guards.fingerprintedBasePopulation) {
    failures.push(
      `key covers ${guards.keyedBasePopulation} of ${guards.fingerprintedBasePopulation} fingerprinted base entities`,
    );
  }
  if (guards.keyedHeadsPresent !== guards.keyedHeadsExpected) {
    failures.push(
      `${guards.keyedHeadsExpected - guards.keyedHeadsPresent} keyed head entities were not fingerprinted`,
    );
  }
  for (const [what, count] of [
    ['base express ids in the answer key', guards.duplicateKeyBaseIds],
    ['head express ids claimed by the answer key', guards.duplicateKeyHeadIds],
    ['express ids among the base fingerprints', guards.duplicateBaseRefs],
    ['express ids among the head fingerprints', guards.duplicateHeadRefs],
  ]) {
    if (count > 0) failures.push(`${count} duplicate ${what}: the key does not describe this pair`);
  }
  if (!guards.baseHasGeometryHashes || !guards.headHasGeometryHashes) {
    failures.push('a revision carries no geometry hashes: the geometry tiers would abstain');
  }
  return failures;
}

