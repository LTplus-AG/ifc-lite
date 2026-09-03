/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS documents validated against buildingSMART's own `ids.xsd` 1.0.
 *
 * ## Why this exists
 *
 * Everything else in this package judges IDS by rules we wrote ourselves.
 * `audit/xsd/index.ts` says so in its own header: rather than ship an XSD
 * interpreter it "hard-codes the rules from `ids.xsd` 1.0". That is a
 * reimplementation, and a reimplementation checked only against its own
 * fixtures agrees with itself, not with the format. The corpus suite has the
 * same shape one level up: 334 files asserted against *expected results*,
 * never against the schema.
 *
 * `ids.xsd` has in fact been sitting in `__fixtures__/bsfiles/` since it was
 * vendored, referenced by nothing — `grep -rn bsfiles` over the whole tree
 * (excluding `node_modules/` and `.git/`) returned no hits before this file.
 * This test is the first thing that compiles it and runs documents through it.
 *
 * ## What is being validated, and what is NOT
 *
 * VALIDATED: XML well-formedness, and full XSD 1.0 structural + datatype
 * conformance of an IDS document against `ids.xsd` 1.0 — element order and
 * cardinality, required/forbidden attributes, enumerations (`ifcVersion`,
 * `cardinality`, `partOf/@relation`), and simple-type facets (the `[A-Z]+`
 * pattern on `dataType`, the e-mail pattern on `<author>`, `xs:date` on
 * `<date>`, `xs:anyURI` on `@uri`).
 *
 * NOT VALIDATED, and out of scope here:
 *   - Whether the IFC entities, property sets, attributes or predefined types
 *     named in the document exist in the referenced IFC schema. `ids.xsd`
 *     cannot express that; `audit/ifc-schema/` is the judge of it.
 *   - Semantic coherence (empty enumerations, inverted bounds, regexes that
 *     do not compile). `audit/coherence/` owns that.
 *   - Whether any IFC model satisfies the specification. That is `validateIDS`.
 *   - IDS 0.9.x documents. Only the 1.0 schema is applied. Files declaring an
 *     older schema version are expected to fail against it and are excluded
 *     from the 1.0 calibration set below by name, not by softening a check.
 *   - Assertions in `xs:assert`/Schematron form: `ids.xsd` contains none.
 *
 * ## Offline by construction
 *
 * `ids.xsd` imports three W3C schemas by absolute URL. libxml2-in-wasm has no
 * network, so those imports are redirected to the copies vendored in
 * `__fixtures__/w3c/` (see that directory's `UPSTREAM_LICENSE`). The rewrite
 * happens in memory; no modified copy of a W3C or buildingSMART file is
 * committed. If the redirect ever stops working the imports do not silently
 * degrade — libxml2 fails to resolve `xs:restriction` and refuses to compile
 * the schema at all, which `compiles the real ids.xsd offline` pins.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateXML } from 'xmllint-wasm';
import { auditIDSDocument } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, '../__fixtures__');
const CORPUS = join(here, '../../__corpus__/buildingsmart-ids');

/**
 * Point the three absolute `xs:import` URLs at the vendored local copies.
 * The XMLSchema-instance import is dropped outright: libxml2 handles the
 * `xsi:` attributes natively and W3C serves no schema document at that URL.
 */
function redirectImportsToVendoredCopies(src: string): string {
  return src
    .replace(
      /schemaLocation="http:\/\/www\.w3\.org\/2001\/xml\.xsd"/g,
      'schemaLocation="xml.xsd"'
    )
    .replace(
      /schemaLocation="http:\/\/www\.w3\.org\/2001\/XMLSchema\.xsd"/g,
      'schemaLocation="XMLSchema.xsd"'
    )
    .replace(
      /<xs:import namespace="http:\/\/www\.w3\.org\/2001\/XMLSchema-instance"[\s\S]*?\/>/g,
      ''
    );
}

const IDS_XSD = redirectImportsToVendoredCopies(
  readFileSync(join(FIXTURES, 'bsfiles/ids.xsd'), 'utf-8')
);
const W3C_PRELOAD = [
  {
    fileName: 'XMLSchema.xsd',
    contents: redirectImportsToVendoredCopies(
      readFileSync(join(FIXTURES, 'w3c/XMLSchema.xsd'), 'utf-8')
    ),
  },
  {
    fileName: 'xml.xsd',
    contents: readFileSync(join(FIXTURES, 'w3c/xml.xsd'), 'utf-8'),
  },
];

/** Errors reported by `ids.xsd` for one document; empty means conforming. */
async function schemaErrors(xml: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'doc.ids', contents: xml }],
    schema: [{ fileName: 'ids.xsd', contents: IDS_XSD }],
    preload: W3C_PRELOAD,
  });
  return result.valid
    ? []
    : result.errors.map((e) =>
        typeof e === 'string' ? e : (e.message ?? String(e))
      );
}

/**
 * Validate a whole set in ONE libxml2 invocation. Compiling `ids.xsd` (plus
 * the two W3C schemas it pulls in) dominates the cost, so validating 334
 * files one call at a time spends nearly all its time recompiling the same
 * schema. Batching keeps this suite in the low seconds rather than needing a
 * raised timeout to paper over it. Returns the number of files rejected, and
 * libxml2's raw output, which names each offending file.
 */
async function rejectedInBatch(
  files: string[]
): Promise<{ count: number; rawOutput: string }> {
  const result = await validateXML({
    xml: files.map((f) => ({
      fileName: relative(FIXTURES, f).replace(/[\\/]/g, '_'),
      contents: readFileSync(f, 'utf-8'),
    })),
    schema: [{ fileName: 'ids.xsd', contents: IDS_XSD }],
    preload: W3C_PRELOAD,
  });
  const raw = String(result.rawOutput ?? '');
  const failing = new Set(
    result.errors
      .map((e) => (typeof e === 'string' ? undefined : e.loc?.fileName))
      .filter((f): f is string => typeof f === 'string' && f.length > 0)
  );
  // Accounting guard. The first cut of this helper read `e.fileName`, which
  // xmllint-wasm does not populate (the name lives on `e.loc`), so it counted
  // zero rejections and the corpus assertion passed as 0 === 0 — a green tick
  // over a check that had stopped looking. libxml2 prints one
  // "<file> validates" line per conforming file, so rejected + conforming must
  // equal the input count; if it ever does not, the parse has drifted again
  // and this throws instead of under-reporting.
  const conforming = (raw.match(/ validates$/gm) ?? []).length;
  if (failing.size + conforming !== files.length) {
    throw new Error(
      `xmllint output accounting drifted: ${failing.size} rejected + ` +
        `${conforming} conforming != ${files.length} files.\n${raw}`
    );
  }
  return { count: failing.size, rawOutput: raw };
}

function idsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.toLowerCase().endsWith('.ids')) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// A deliberately un-symmetric document: two specifications that differ in
// ifcVersion, in facet type and in cardinality; every optional `<info>` child
// populated (they are exactly the fields a fixture normally leaves empty, and
// three of the divergences below live in them); a `<property>` carrying an
// `xs:restriction` rather than a `simpleValue`; and `minOccurs="0"` on one
// applicability and `minOccurs="1"` on the other so the cardinality attributes
// are not identical across positions.
// ---------------------------------------------------------------------------
const CONFORMING_DOCUMENT = `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">
  <info>
    <title>Conformance probe</title>
    <copyright>ifc-lite</copyright>
    <version>1.2.3</version>
    <description>Every optional info child populated.</description>
    <author>probe@example.com</author>
    <date>2026-01-31</date>
    <purpose>Schema conformance</purpose>
    <milestone>Design</milestone>
  </info>
  <specifications>
    <specification name="Walls" ifcVersion="IFC4" identifier="S1" description="first" instructions="do it">
      <applicability minOccurs="1" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCIDENTIFIER" cardinality="required">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>Reference</simpleValue></baseName>
          <value><xs:restriction base="xs:string"><xs:pattern value="W-[0-9]+"/></xs:restriction></value>
        </property>
        <partOf relation="IFCRELAGGREGATES" cardinality="required">
          <entity><name><simpleValue>IFCBUILDINGSTOREY</simpleValue></name></entity>
        </partOf>
      </requirements>
    </specification>
    <specification name="Doors" ifcVersion="IFC2X3" identifier="S2">
      <applicability minOccurs="0" maxOccurs="1">
        <entity>
          <name><simpleValue>IFCDOOR</simpleValue></name>
          <predefinedType><simpleValue>DOOR</simpleValue></predefinedType>
        </entity>
      </applicability>
      <requirements>
        <classification cardinality="prohibited">
          <value><simpleValue>21.30</simpleValue></value>
          <system><simpleValue>Uniclass</simpleValue></system>
        </classification>
      </requirements>
    </specification>
  </specifications>
</ids>`;

/**
 * Each entry breaks `CONFORMING_DOCUMENT` in exactly one way that `ids.xsd`
 * forbids, and names the schema construct that forbids it. A validator that
 * has never been shown to go red is worth nothing, so every one of these must
 * be reported — and the mutation must actually change the document, which
 * `expect(broken).not.toBe(CONFORMING_DOCUMENT)` pins (a stale `.replace()`
 * that silently matches nothing would otherwise turn this whole table green).
 */
const SCHEMA_VIOLATIONS: ReadonlyArray<{
  readonly what: string;
  readonly rule: string;
  readonly break: (s: string) => string;
}> = [
  {
    what: 'missing required <title>',
    rule: 'info sequence, <title> has no minOccurs="0"',
    break: (s) => s.replace('<title>Conformance probe</title>', ''),
  },
  {
    what: 'ifcVersion outside the enumeration',
    rule: 'specification/@ifcVersion enumerates IFC2X3, IFC4, IFC4X3_ADD2',
    break: (s) => s.replace('ifcVersion="IFC4"', 'ifcVersion="IFC4X4"'),
  },
  {
    what: '<date> is not an xs:date',
    rule: 'info/date is typed xs:date',
    break: (s) => s.replace('<date>2026-01-31</date>', '<date>31/01/2026</date>'),
  },
  {
    what: 'dataType is not upper-case',
    rule: 'property/@dataType is ids:upperCaseName, pattern [A-Z]+',
    break: (s) => s.replace('dataType="IFCIDENTIFIER"', 'dataType="IfcIdentifier"'),
  },
  {
    what: '<author> is not an e-mail address',
    rule: 'info/author pattern [^@]+@[^\\.]+\\..+',
    break: (s) => s.replace('probe@example.com', 'not-an-email'),
  },
  {
    what: 'cardinality outside the enumeration',
    rule: 'ids:conditionalCardinality is {required, prohibited, optional}',
    break: (s) => s.replace('cardinality="required"', 'cardinality="mandatory"'),
  },
  {
    what: 'cardinality="optional" on <partOf>',
    rule: 'partOf takes ids:simpleCardinality = {required, prohibited} only',
    break: (s) =>
      s.replace(
        'relation="IFCRELAGGREGATES" cardinality="required"',
        'relation="IFCRELAGGREGATES" cardinality="optional"'
      ),
  },
  {
    what: 'unknown attribute on <entity>',
    rule: 'ids:entityType declares no such attribute and no anyAttribute',
    break: (s) =>
      s.replace(
        '<entity><name><simpleValue>IFCWALL',
        '<entity bogus="x"><name><simpleValue>IFCWALL'
      ),
  },
  {
    what: '@uri on <partOf>',
    rule: '@uri exists on property/material/classification, not on partOf',
    break: (s) =>
      s.replace('<partOf relation=', '<partOf uri="http://example.com/x" relation='),
  },
  {
    what: 'partOf/@relation outside the enumeration',
    rule: 'ids:relations enumerates the IfcRel* names',
    break: (s) =>
      s.replace('relation="IFCRELAGGREGATES"', 'relation="IFCRELBOGUS"'),
  },
  {
    what: 'missing required <propertySet>',
    rule: 'ids:propertyType sequence requires propertySet',
    break: (s) =>
      s.replace(
        '<propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>',
        ''
      ),
  },
  {
    what: 'missing required <baseName>',
    rule: 'ids:propertyType sequence requires baseName',
    break: (s) =>
      s.replace('<baseName><simpleValue>Reference</simpleValue></baseName>', ''),
  },
  {
    what: 'missing required classification <system>',
    rule: 'ids:classificationType requires system (minOccurs="1")',
    break: (s) =>
      s.replace('<system><simpleValue>Uniclass</simpleValue></system>', ''),
  },
  {
    what: 'requirements before applicability',
    rule: 'ids:specificationType is a sequence, applicability first',
    break: (s) =>
      s.replace(
        /<applicability minOccurs="0"[\s\S]*?<\/applicability>\s*(<requirements>[\s\S]*?<\/requirements>)/,
        '$1'
      ),
  },
  {
    what: 'empty <specifications>',
    rule: 'ids:specificationsType requires one specification (minOccurs="1")',
    break: (s) =>
      s.replace(
        /<specifications>[\s\S]*<\/specifications>/,
        '<specifications></specifications>'
      ),
  },
  {
    what: 'unknown element inside a facet',
    rule: 'ids:propertyType is a closed sequence',
    break: (s) => s.replace('<baseName>', '<bogusChild/><baseName>'),
  },
  {
    what: 'cardinality on a requirements <entity>',
    rule: 'the requirements entity extension adds @instructions only',
    break: (s) =>
      s.replace(
        '<classification cardinality="prohibited">',
        '<entity cardinality="required"><name><simpleValue>IFCDOOR</simpleValue></name></entity><classification cardinality="prohibited">'
      ),
  },
  {
    what: 'not well-formed XML',
    rule: 'precedes schema validation entirely',
    break: (s) => s.replace('</ids>', ''),
  },
];

describe('IDS documents against buildingSMART ids.xsd 1.0', () => {
  it('compiles the real ids.xsd offline and accepts a conforming document', async () => {
    // If the vendored W3C redirect broke, libxml2 cannot resolve
    // `xs:restriction` and this throws rather than quietly passing.
    expect(await schemaErrors(CONFORMING_DOCUMENT)).toEqual([]);
  });

  // The mutation proof. Not "the validator returned green", but "the validator
  // was shown to return red for eighteen distinct schema constructs".
  it.each(SCHEMA_VIOLATIONS.map((v) => [v.what, v] as const))(
    'rejects: %s',
    async (_what, violation) => {
      const broken = violation.break(CONFORMING_DOCUMENT);
      expect(broken).not.toBe(CONFORMING_DOCUMENT);
      const errors = await schemaErrors(broken);
      expect(errors.length).toBeGreaterThan(0);
    }
  );

  // ------------------------------------------------------------------
  // Calibration on real third-party files: a validator that passes
  // everything and one that fails everything are equally worthless.
  // ------------------------------------------------------------------

  it('accepts all 334 buildingSMART corpus documents', async () => {
    const files = idsFilesUnder(CORPUS);
    expect(files.length).toBe(334);
    const { count, rawOutput } = await rejectedInBatch(files);
    expect(count, rawOutput).toBe(0);
  });

  it('rejects the IDS-Audit-tool fixtures that are malformed at XSD level', async () => {
    // 33 files upstream calls invalid; 13 of them are rejected here — 10 for
    // schema violations and 3 (empty.ids, notAnXml.ids, smallcross_gif.ids)
    // because they are not well-formed XML at all. The other 20 are
    // schema-conforming but semantically wrong (an entity that does not exist
    // in IFC, an inverted bound) — the XSD is the wrong judge of those and
    // correctly passes them. Pinning both halves is what makes this
    // calibration rather than a tautology: a validator that rejected all 33
    // would fail here just as loudly as one that rejected none.
    const files = idsFilesUnder(join(FIXTURES, 'invalid'));
    expect(files.length).toBe(33);
    const { count } = await rejectedInBatch(files);
    expect(count).toBe(13);
  });

  it('accepts the IDS-Audit-tool fixtures that declare schema 1.0', async () => {
    // canonical-0.9.7.ids is a 0.9.7 document: it uses `ifcVersion="IFC4X3"`,
    // which 1.0 dropped from the enumeration in favour of IFC4X3_ADD2. It is
    // excluded because the 1.0 schema is the wrong schema for it, not because
    // it is inconvenient.
    const files = idsFilesUnder(join(FIXTURES, 'valid')).filter(
      (f) => !f.includes('canonical-0.9.7')
    );
    expect(files.length).toBe(7);
    const { count, rawOutput } = await rejectedInBatch(files);
    expect(count, rawOutput).toBe(0);
  });

  it('rejects a 0.9.7 document under the 1.0 schema', async () => {
    // The complement of the exclusion above: proves the exclusion is load
    // bearing and that ifcVersion="IFC4X3" really is rejected by 1.0.
    const errors = await schemaErrors(
      readFileSync(
        join(FIXTURES, 'valid/CanonicalVersions/canonical-0.9.7.ids'),
        'utf-8'
      )
    );
    expect(errors.join('\n')).toContain("The value 'IFC4X3' is not an element");
  });
});

/**
 * Where `auditIDSDocument` and the real schema disagree.
 *
 * These are NOT endorsed behaviours. Each entry is a document that `ids.xsd`
 * rejects and that `auditIDSDocument` currently reports as clean, i.e. a hole
 * in the hand-written XSD reimplementation. They are pinned here so the gap is
 * a visible, countable list instead of an unknown, and so that closing any one
 * of them turns this test red and forces the entry to be deleted. The list may
 * only ever shrink.
 *
 * Currently empty: the five gaps this test used to pin (`<specifications>`
 * with no children, classification `<system>` missing, `dataType` case,
 * `<date>` not `xs:date`, `<author>` not an e-mail address) were all real
 * bugs — the audit accepted what the schema rejects — and are now fixed in
 * `audit/xsd/index.ts`.
 *
 * `partOf cardinality="optional"` used to be here too: `audit/coherence/index.ts`
 * treated every requirement facet as taking the three-value
 * `conditionalCardinality`, but `partOf` is typed `simpleCardinality`
 * (`{required, prohibited}`) in ids.xsd, so `optional` is not one of its
 * values. `auditRequirementCardinality` now flags it (`case 'partOf'`),
 * closing the gap — the case stays in the table below only as a
 * genuinely-rejected-by-schema fixture, not as a known miss.
 */
const KNOWN_AUDIT_GAPS = [] as const;

describe('divergence between auditIDSDocument and ids.xsd', () => {
  const APPLICABILITY = `<applicability minOccurs="0" maxOccurs="unbounded"><entity><name><simpleValue>IFCWALL</simpleValue></name></entity></applicability>`;
  const wrap = (specs: string): string =>
    `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>Divergence</title></info><specifications>${specs}</specifications></ids>`;
  const spec = (requirements: string): string =>
    `<specification name="S" ifcVersion="IFC4">${APPLICABILITY}<requirements>${requirements}</requirements></specification>`;
  const TRIVIAL_REQUIREMENT = `<attribute><name><simpleValue>Name</simpleValue></name></attribute>`;

  const CASES: ReadonlyArray<readonly [string, string]> = [
    ['empty <specifications>', wrap('')],
    [
      'classification requirement without <system>',
      wrap(
        spec(
          `<classification cardinality="required"><value><simpleValue>21.30</simpleValue></value></classification>`
        )
      ),
    ],
    [
      'partOf with cardinality="optional"',
      wrap(
        spec(
          `<partOf relation="IFCRELNESTS" cardinality="optional"><entity><name><simpleValue>IFCBUILDING</simpleValue></name></entity></partOf>`
        )
      ),
    ],
    [
      'dataType in mixed case',
      wrap(
        spec(
          `<property dataType="IfcLabel" cardinality="required"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet><baseName><simpleValue>Status</simpleValue></baseName></property>`
        )
      ),
    ],
    [
      'info/date that is not an xs:date',
      `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>T</title><date>31/01/2026</date></info><specifications>${spec(TRIVIAL_REQUIREMENT)}</specifications></ids>`,
    ],
    [
      'info/author that is not an e-mail address',
      `<?xml version="1.0" encoding="utf-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"><info><title>T</title><author>nobody</author></info><specifications>${spec(TRIVIAL_REQUIREMENT)}</specifications></ids>`,
    ],
  ];

  it('the control document is accepted by both', async () => {
    // Without this, "the audit reported nothing" below would be consistent
    // with the audit being broken outright rather than merely incomplete.
    const control = wrap(spec(TRIVIAL_REQUIREMENT));
    expect(await schemaErrors(control)).toEqual([]);
    expect((await auditIDSDocument(control)).issues).toEqual([]);
  });

  // One `it` per case rather than one loop over all of them. Two reasons, and
  // the second is why this changed: a failure now names the document instead of
  // reporting only that the sweep ran out of time, and each case gets its own
  // budget. As a single `it` this did N xmllint-wasm parse-and-validate passes
  // against vitest's default 5000 ms, which is fine unloaded and timed out
  // twice on CI (#3110), blocking PRs that touch nothing in this package.
  it.each(CASES)('%s is genuinely rejected by the schema', async (what, xml) => {
    expect((await schemaErrors(xml)).length, `${what} should violate ids.xsd`).toBeGreaterThan(0);
  });

  it('the set the audit still misses is exactly the known list', async () => {
    const missed: string[] = [];
    for (const [what, xml] of CASES) {
      const report = await auditIDSDocument(xml);
      if (report.issues.length === 0) missed.push(what);
    }
    // Shrinking this list is the point. If a fix lands, this goes red and the
    // corresponding entry must be deleted from KNOWN_AUDIT_GAPS.
    expect(missed.sort()).toEqual([...KNOWN_AUDIT_GAPS]);
    // Left whole, and left on the default budget. It never touches xmllint --
    // `auditIDSDocument` is the pure-TS reimplementation -- so all six cases
    // together measure ~3 ms. #3110 described this as a second xmllint loop;
    // that was wrong, and only the loop above ever flaked.
    //
    // It COULD be split (per-case `issues.length === 0` matched against
    // KNOWN_AUDIT_GAPS, plus a check that every gap entry is a real case name),
    // but there is nothing to buy: the exact-set assertion is the point, and
    // a 3 ms test does not need its own budget.
  });
});
