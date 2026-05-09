#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS validation parity harness — runs the buildingSMART/IDS official
 * implementer test corpus through our parser + validator and compares
 * the spec status to the filename prefix.
 *
 * Each fixture pair is named with one of three prefixes:
 *   pass-*    → expect IDSSpecificationResult.status === 'pass'
 *   fail-*    → expect IDSSpecificationResult.status === 'fail'
 *   invalid-* → expect IDSSpecificationResult.status === 'not_applicable'
 *               (i.e. no applicability matched, or the IDS itself
 *               wouldn't validate against the input)
 *
 * Reports a parity rate per category + overall, and lists divergences.
 *
 * Run the script directly with `node` so we avoid `tsx`'s workspace-
 * source resolution (which conflicts with our compiled-dist imports).
 *
 * Usage:
 *   node scripts/test-ids-corpus.mjs                  # full corpus
 *   node scripts/test-ids-corpus.mjs --category=entity
 *   node scripts/test-ids-corpus.mjs --verbose        # log every fixture
 *   node scripts/test-ids-corpus.mjs --limit=20       # first 20 per category
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseIDS, validateIDS } from '../packages/ids/dist/index.js';
import {
  IfcParser,
  extractAllEntityAttributes,
  extractPropertiesOnDemand,
  extractQuantitiesOnDemand,
  extractTypeEntityOwnProperties,
  extractMaterialsOnDemand,
  extractClassificationsOnDemand,
} from '../packages/parser/dist/index.js';
import { RelationshipType } from '../packages/data/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.resolve(
  __dirname,
  '..',
  'packages',
  'ids',
  'src',
  '__corpus__',
  'buildingsmart-ids'
);

// ---------------------------------------------------------------------------
// Data accessor — vendored from apps/viewer/src/hooks/ids/idsDataAccessor.ts
// so this script doesn't depend on the viewer's TypeScript source. Keep
// in sync with that file when the validator interface evolves.
// ---------------------------------------------------------------------------

/**
 * Map RelationshipType (numeric enum) for partOf lookups. The earlier
 * accessor passed string keys like 'Aggregates' which the relationship
 * graph silently doesn't match — every partOf check was a false
 * positive against an empty-result set.
 */
const PARTOF_REL_MAP = {
  IfcRelAggregates: RelationshipType.Aggregates,
  IfcRelContainedInSpatialStructure: RelationshipType.ContainsElements,
  IfcRelNests: RelationshipType.Aggregates, // upstream maps Nests → Aggregates table
  IfcRelVoidsElement: RelationshipType.VoidsElement,
  IfcRelFillsElement: RelationshipType.FillsElement,
};

/**
 * Flatten the parser's hierarchical MaterialInfo into the flat
 * `{name, category}[]` array the IDS validator expects. Surfaces:
 *  - a single Material's name
 *  - a MaterialList's individual material strings
 *  - a MaterialLayerSet's set name AND each layer's materialName
 *  - a MaterialConstituentSet's set name AND each constituent's materialName/name/category
 *  - a MaterialProfileSet's set name AND each profile's materialName/name/category
 */
function flattenMaterials(matInfo) {
  if (!matInfo) return [];
  const out = [];
  const push = (name, category) => {
    if (!name) return;
    out.push({ name, category });
  };
  switch (matInfo.type) {
    case 'Material':
      push(matInfo.name, matInfo.category);
      // The IDS material facet treats `<value>` as matching against
      // either the material's Name OR its Category (upstream
      // IfcOpenShell behaviour). Push category as an alias entry so
      // value checks match either field.
      if (matInfo.category) push(matInfo.category, matInfo.category);
      break;
    case 'MaterialList':
      for (const m of matInfo.materials || []) push(m);
      break;
    case 'MaterialLayerSet':
      push(matInfo.name);
      for (const layer of matInfo.layers || []) {
        push(layer.materialName, layer.category);
        push(layer.name, layer.category);
        // The underlying IfcMaterial.Category is also a candidate match.
        if (layer.materialCategory) push(layer.materialCategory, layer.materialCategory);
      }
      break;
    case 'MaterialConstituentSet':
      push(matInfo.name);
      for (const c of matInfo.constituents || []) {
        push(c.materialName, c.category);
        push(c.name, c.category);
        if (c.materialCategory) push(c.materialCategory, c.materialCategory);
      }
      break;
    case 'MaterialProfileSet':
      push(matInfo.name);
      for (const p of matInfo.profiles || []) {
        push(p.materialName, p.category);
        push(p.name, p.category);
        if (p.materialCategory) push(p.materialCategory, p.materialCategory);
      }
      break;
  }
  return out;
}

function createDataAccessor(dataStore) {
  return {
    getEntityType(expressId) {
      const t = dataStore.entities?.getTypeName?.(expressId);
      if (t) return t;
      const byId = dataStore.entityIndex?.byId;
      if (byId) {
        const entry = byId.get(expressId);
        if (entry && typeof entry === 'object' && 'type' in entry) {
          return String(entry.type);
        }
      }
      return undefined;
    },
    getEntityName(expressId) {
      const n = dataStore.entities?.getName?.(expressId);
      if (n) return n;
      return findAttribute(dataStore, expressId, 'Name');
    },
    getGlobalId(expressId) {
      const g = dataStore.entities?.getGlobalId?.(expressId);
      if (g) return g;
      return findAttribute(dataStore, expressId, 'GlobalId');
    },
    getDescription(expressId) {
      const d = dataStore.entities?.getDescription?.(expressId);
      if (d) return d;
      return findAttribute(dataStore, expressId, 'Description');
    },
    getObjectType(expressId) {
      // IDS predefined-type semantics (matches upstream IfcOpenShell):
      //  - If PredefinedType is `USERDEFINED`, the real type lives in
      //    ElementType (for IfcTypeObject subtypes like IfcWallType) or
      //    ObjectType / ProcessType / etc. (for IfcObject subtypes).
      //  - If PredefinedType is `NOTDEFINED` or absent, fall back to
      //    ObjectType.
      //  - Otherwise the PredefinedType enum value IS the answer.
      const allAttrs = extractAllEntityAttributes(dataStore, expressId);
      const pdt = allAttrs.find((a) => a.name === 'PredefinedType');
      const pdtValue = pdt?.value;
      if (pdtValue && pdtValue !== 'NOTDEFINED' && pdtValue !== 'USERDEFINED') {
        return pdtValue;
      }
      // USERDEFINED / NOTDEFINED — look for the user-defined slot.
      // Different parent classes use different attribute names:
      //   IfcTypeObject → ElementType
      //   IfcObject     → ObjectType
      //   IfcTypeProcess→ ProcessType
      //   IfcTypeResource → ResourceType
      const userSlot =
        allAttrs.find((a) => a.name === 'ElementType') ||
        allAttrs.find((a) => a.name === 'ObjectType') ||
        allAttrs.find((a) => a.name === 'ProcessType') ||
        allAttrs.find((a) => a.name === 'ResourceType');
      if (userSlot?.value) return userSlot.value;
      // No user-defined override → return the raw PredefinedType (may
      // be NOTDEFINED) so empty-predefined-type checks work.
      const ot = dataStore.entities?.getObjectType?.(expressId);
      if (ot) return ot;
      return pdtValue || undefined;
    },
    getEntitiesByType(typeName) {
      const byType = dataStore.entityIndex?.byType;
      if (byType) {
        const ids = byType.get(typeName.toUpperCase());
        if (ids) return Array.from(ids);
      }
      return [];
    },
    getAllEntityIds() {
      const byId = dataStore.entityIndex?.byId;
      return byId ? Array.from(byId.keys()) : [];
    },
    getPropertyValue(expressId, propertySetName, propertyName) {
      const all = collectAllPropertySets(dataStore, expressId);
      for (const pset of all) {
        if (pset.name.toLowerCase() !== propertySetName.toLowerCase()) continue;
        for (const prop of pset.properties || []) {
          if (prop.name.toLowerCase() !== propertyName.toLowerCase()) continue;
          return {
            value: prop.value,
            dataType: prop.dataType,
            propertySetName: pset.name,
            propertyName: prop.name,
          };
        }
      }
      return undefined;
    },
    getPropertySets(expressId) {
      return collectAllPropertySets(dataStore, expressId);
    },
    getClassifications(expressId) {
      const list = extractClassificationsOnDemand(dataStore, expressId) || [];
      return list.map((c) => ({
        system: c.system || '',
        // The validator's `value` field carries the classification *code*
        // (e.g. "EF_25_10"). Upstream parser puts that into `identification`.
        value: c.identification || c.name || '',
        name: c.name,
      }));
    },
    getMaterials(expressId) {
      return flattenMaterials(extractMaterialsOnDemand(dataStore, expressId));
    },
    getParent(expressId, relationType) {
      const relationships = dataStore.relationships;
      if (!relationships?.getRelated) return undefined;
      const relType = PARTOF_REL_MAP[relationType];
      if (relType === undefined) return undefined;
      const parents = relationships.getRelated(expressId, relType, 'inverse');
      if (!parents || parents.length === 0) return undefined;
      const parentId = parents[0];
      return {
        expressId: parentId,
        entityType: this.getEntityType(parentId) || 'Unknown',
        predefinedType: this.getObjectType(parentId),
      };
    },
    getAttribute(expressId, attributeName) {
      const lower = attributeName.toLowerCase();
      switch (lower) {
        case 'name':
          return this.getEntityName(expressId);
        case 'description':
          return this.getDescription(expressId);
        case 'globalid':
          return this.getGlobalId(expressId);
        case 'objecttype':
        case 'predefinedtype':
          return this.getObjectType(expressId);
        default: {
          // For arbitrary attributes (EditionDate, Tag, etc.), fall back
          // to the parser's full-attribute extractor.
          const fromExtract = findAttribute(dataStore, expressId, attributeName);
          if (fromExtract !== undefined) return fromExtract;
          const e = dataStore.entities;
          return e?.getAttribute ? e.getAttribute(expressId, attributeName) : undefined;
        }
      }
    },
  };
}

/**
 * Look up an arbitrary attribute by name via `extractAllEntityAttributes`.
 * Case-insensitive name match. Returns undefined when the attribute
 * isn't on the entity (or has no string value).
 */
function findAttribute(dataStore, expressId, attributeName) {
  const lower = attributeName.toLowerCase();
  const all = extractAllEntityAttributes(dataStore, expressId);
  for (const a of all) {
    if (a.name.toLowerCase() === lower) return a.value;
  }
  return undefined;
}

/**
 * IDS treats `IfcElementQuantity` (Qto_*) and `IfcPropertySet` (Pset_*)
 * uniformly — both surface as "property sets" with named values. The
 * parser stores them in separate columnar tables (`properties` vs
 * `quantities`), so we merge them here.
 *
 * For IfcTypeObject occurrences, also fall back to type-level
 * `HasPropertySets` when the relationship-based lookup is empty.
 */
function collectAllPropertySets(dataStore, expressId) {
  const out = [];
  // Properties — prefer the columnar table when populated, else fall
  // back to on-demand extraction (the ColumnarParser only fills the
  // table when explicitly asked, but the on-demand extractor walks
  // IfcRelDefinesByProperties → IfcPropertySet directly).
  let props = dataStore.properties?.getForEntity?.(expressId);
  if (!props || props.length === 0) {
    props = extractPropertiesOnDemand(dataStore, expressId);
  }
  if (props && props.length > 0) {
    for (const pset of props) {
      out.push({
        name: pset.name,
        properties: (pset.properties || []).map((p) => ({
          name: p.name,
          value: Array.isArray(p.value) ? JSON.stringify(p.value) : p.value,
          dataType: idsDataTypeForProperty(p.type),
        })),
      });
    }
  }
  // IfcElementQuantity (Qto_*) sets — IDS treats these as property
  // sets too. Same dual-source pattern.
  let quantities = dataStore.quantities?.getForEntity?.(expressId);
  if (!quantities || quantities.length === 0) {
    quantities = extractQuantitiesOnDemand(dataStore, expressId);
  }
  if (quantities && quantities.length > 0) {
    for (const qset of quantities) {
      out.push({
        name: qset.name,
        properties: (qset.quantities || []).map((q) => ({
          name: q.name,
          value: q.value,
          dataType: idsDataTypeForQuantity(q.type),
        })),
      });
    }
  }
  if (out.length === 0) {
    // Type-object fallback (IfcWallType.HasPropertySets etc.)
    const typePsets = extractTypeEntityOwnProperties(dataStore, expressId);
    if (typePsets.length > 0) {
      for (const pset of typePsets) {
        out.push({
          name: pset.name,
          properties: (pset.properties || []).map((p) => ({
            name: p.name,
            value: Array.isArray(p.value) ? JSON.stringify(p.value) : p.value,
            dataType: idsDataTypeForProperty(p.type),
          })),
        });
      }
    }
  }
  return out;
}

/**
 * Map the parser's `PropertyValueType` enum (or string-tagged variant)
 * to the IDS-side `IFC*` data-type token consumers compare against.
 * IDS expects names like `IFCLABEL` / `IFCREAL` / `IFCBOOLEAN`; the
 * parser surfaces shape-only enum values plus the underlying IFC
 * measure name on the property record.
 */
function idsDataTypeForProperty(type) {
  if (typeof type === 'string') {
    if (type.startsWith('IFC') || type.startsWith('Ifc')) return type.toUpperCase();
    return 'IFCLABEL';
  }
  // PropertyValueType enum (from @ifc-lite/data):
  //   0 String, 1 Real, 2 Integer, 3 Boolean, 4 Logical,
  //   5 Label, 6 Identifier, 7 Text, 8 Enum, 9 Reference, 10 List.
  switch (type) {
    case 0:
      return 'IFCLABEL';
    case 1:
      return 'IFCREAL';
    case 2:
      return 'IFCINTEGER';
    case 3:
      return 'IFCBOOLEAN';
    case 4:
      return 'IFCLOGICAL';
    case 5:
      return 'IFCLABEL';
    case 6:
      return 'IFCIDENTIFIER';
    case 7:
      return 'IFCTEXT';
    case 8:
      return 'IFCLABEL';
    case 9:
      return 'IFCIDENTIFIER';
    case 10:
      return 'IFCLABEL';
    default:
      return 'IFCLABEL';
  }
}

/**
 * Map the parser's `QuantityType` enum to its corresponding IDS
 * dataType. Length → IFCLENGTHMEASURE, etc.
 */
function idsDataTypeForQuantity(type) {
  switch (type) {
    case 0: // Length
      return 'IFCLENGTHMEASURE';
    case 1: // Area
      return 'IFCAREAMEASURE';
    case 2: // Volume
      return 'IFCVOLUMEMEASURE';
    case 3: // Count
      return 'IFCCOUNTMEASURE';
    case 4: // Weight
      return 'IFCMASSMEASURE';
    case 5: // Time
      return 'IFCTIMEMEASURE';
    default:
      return 'IFCLABEL';
  }
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const categoryArg = args.find((a) => a.startsWith('--category='))?.split('=')[1];
const limitArg = Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '0');

// ---------------------------------------------------------------------------
// Discovery + runner
// ---------------------------------------------------------------------------

function expectedFromPrefix(filename) {
  if (filename.startsWith('pass-')) return 'pass';
  if (filename.startsWith('fail-')) return 'fail';
  // `invalid-` per buildingSMART means the IDS+IFC pair, when run
  // through ifctester, results in spec.status=fail — the IDS makes
  // sense but the IFC cannot satisfy it (e.g. uppercase requirement
  // matched against a PascalCase value, subclass that isn't the
  // requested class, etc.).
  if (filename.startsWith('invalid-')) return 'fail';
  return null;
}

function discover() {
  const out = [];
  if (!fs.existsSync(CORPUS_ROOT)) {
    throw new Error(`Corpus directory not found: ${CORPUS_ROOT}`);
  }
  for (const category of fs.readdirSync(CORPUS_ROOT)) {
    if (categoryArg && category !== categoryArg) continue;
    const dir = path.join(CORPUS_ROOT, category);
    if (!fs.statSync(dir).isDirectory()) continue;
    const idsFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.ids')).sort();
    let count = 0;
    for (const ids of idsFiles) {
      const base = ids.slice(0, -'.ids'.length);
      const expected = expectedFromPrefix(base);
      if (!expected) continue;
      const ifcPath = path.join(dir, `${base}.ifc`);
      if (!fs.existsSync(ifcPath)) continue;
      out.push({
        category,
        name: base,
        expected,
        idsPath: path.join(dir, ids),
        ifcPath,
      });
      count++;
      if (limitArg > 0 && count >= limitArg) break;
    }
  }
  return out;
}

async function runFixture(pair) {
  let actualStatus;
  try {
    const xml = fs.readFileSync(pair.idsPath, 'utf8');
    const ifcBuf = fs.readFileSync(pair.ifcPath);
    const ifcArrayBuf = ifcBuf.buffer.slice(
      ifcBuf.byteOffset,
      ifcBuf.byteOffset + ifcBuf.byteLength
    );

    const ids = parseIDS(xml);
    const parser = new IfcParser();
    const dataStore = await parser.parseColumnar(ifcArrayBuf, {});

    const accessor = createDataAccessor(dataStore);
    const report = await validateIDS(
      ids,
      accessor,
      {
        modelId: pair.name,
        schemaVersion: 'IFC4',
        entityCount: dataStore.entityIndex?.byId?.size ?? 0,
      },
      {}
    );

    if (report.specificationResults.length === 0) {
      actualStatus = 'not_applicable';
    } else {
      // Each fixture targets exactly one spec; pick the first.
      actualStatus = report.specificationResults[0].status;
    }
  } catch (err) {
    return {
      pair,
      outcome: 'error',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
  return {
    pair,
    outcome: actualStatus === pair.expected ? 'match' : 'mismatch',
    actualStatus,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printSummary(results) {
  const byCategory = new Map();
  for (const r of results) {
    let row = byCategory.get(r.pair.category);
    if (!row) {
      row = { match: 0, mismatch: 0, error: 0, total: 0 };
      byCategory.set(r.pair.category, row);
    }
    row.total++;
    if (r.outcome === 'match') row.match++;
    else if (r.outcome === 'mismatch') row.mismatch++;
    else row.error++;
  }
  console.log('\nbuildingSMART/IDS corpus parity report');
  console.log('======================================');
  console.log(
    'category'.padEnd(16),
    'match'.padStart(7),
    'mismatch'.padStart(10),
    'error'.padStart(7),
    'total'.padStart(7),
    'parity'.padStart(8)
  );
  let allMatch = 0;
  let allTotal = 0;
  for (const [cat, row] of [...byCategory.entries()].sort()) {
    const parity = ((row.match / row.total) * 100).toFixed(1) + '%';
    console.log(
      cat.padEnd(16),
      String(row.match).padStart(7),
      String(row.mismatch).padStart(10),
      String(row.error).padStart(7),
      String(row.total).padStart(7),
      parity.padStart(8)
    );
    allMatch += row.match;
    allTotal += row.total;
  }
  console.log('-'.repeat(60));
  const overall = ((allMatch / allTotal) * 100).toFixed(1) + '%';
  console.log(
    'overall'.padEnd(16),
    String(allMatch).padStart(7),
    ''.padStart(10),
    ''.padStart(7),
    String(allTotal).padStart(7),
    overall.padStart(8)
  );
}

function printDivergences(results) {
  const diverged = results.filter(
    (r) => r.outcome === 'mismatch' || r.outcome === 'error'
  );
  if (diverged.length === 0) {
    console.log('\nNo divergences. Full upstream parity. ✓');
    return;
  }
  console.log(`\nDivergences (${diverged.length}):`);
  for (const r of diverged) {
    if (r.outcome === 'mismatch') {
      console.log(
        `  ${r.pair.category}/${r.pair.name}: expected=${r.pair.expected} actual=${r.actualStatus}`
      );
    } else {
      console.log(
        `  ${r.pair.category}/${r.pair.name}: ERROR ${r.errorMessage}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const fixtures = discover();
  console.log(
    `Discovered ${fixtures.length} fixture pair(s)${
      categoryArg ? ` in category "${categoryArg}"` : ''
    }${limitArg > 0 ? ` (limited to ${limitArg} per category)` : ''}.`
  );
  const results = [];
  let i = 0;
  for (const pair of fixtures) {
    i++;
    if (verbose) {
      process.stdout.write(`[${i}/${fixtures.length}] ${pair.category}/${pair.name}…`);
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await runFixture(pair);
    results.push(r);
    if (verbose) {
      const tag = r.outcome === 'match' ? '✓' : r.outcome === 'mismatch' ? '✗' : '!';
      console.log(` ${tag} ${r.actualStatus ?? r.errorMessage ?? ''}`);
    } else if (i % 25 === 0) {
      process.stdout.write(`  ${i}/${fixtures.length}\r`);
    }
  }
  if (!verbose) console.log();
  printSummary(results);
  printDivergences(results);
  const diverged = results.filter((r) => r.outcome !== 'match').length;
  process.exit(diverged === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
