/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Model transforms that write a new IFC file: merge, schema convert, raw STEP
 * subset extraction and anonymized subset export. Each is a thin wrapper over
 * the `@ifc-lite/export` function the CLI command of the same name calls.
 * One default differs on purpose: `model_merge` keeps the first model's schema
 * where `ifc-lite merge` writes IFC4. Geometry transforms (simplify, LOD)
 * live in `transform-mesh.ts`.
 */

import { constants as bufferConstants } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import {
  analyzeConversionLoss,
  buildSubset,
  exportToStep,
  MergedExporter,
  parseStep,
  selectSubsetSeeds,
  SubsetSelectionError,
  serializeSubset,
} from '@ifc-lite/export';
import type { Tool } from './types.js';
import { fmtInt, listAllowedModelIds, okResult, resolveModel } from './util.js';
import { withIfcBytes } from './export-source.js';
import { ToolErrorCode, ToolExecutionError } from '../errors.js';
import { resolveSafePath } from '../safe-path.js';
import { loadIfcModelFromBytes } from '../loader.js';
import { modelAnonymize } from './transform-anonymize.js';
import { meshTransformTools } from './transform-mesh.js';
import {
  FILE_WRITE_ANNOTATIONS,
  fileOutputSchema,
  invalid,
  lossEntryRow,
  nonBlank,
  schemaOf,
  requireNoPendingEdits,
  withIfcPrefix,
  stringList,
  throwIfCancelled,
} from './transform-schema.js';

const ROOT_MODES = ['single', 'by-name'];
const STOREY_MODES = ['by-name', 'by-elevation', 'by-name-then-elevation'];

const modelMerge: Tool = {
  name: 'model_merge',
  title: 'Merge models',
  description:
    'Merge, federate or combine two or more loaded models into one IFC file. Sites, buildings and storeys are unified by name and elevation unless overridden; models in a different length unit become separate projects unless `unit_reconciliation` says otherwise.',
  scope: 'export',
  annotations: FILE_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      model_ids: { type: 'array', items: { type: 'string' }, minItems: 2, description: 'Models to merge, in order; the first sets the unit and project. Default: every loaded model.' },
      file_path: { type: 'string', description: 'Output .ifc path, inside the allowed paths.' },
      schema: { type: 'string', enum: ['IFC2X3', 'IFC4', 'IFC4X3'], description: 'Output schema. Default: the first model\'s. Models in another schema are converted, the loss reported in warnings.' },
      unit_reconciliation: { type: 'string', enum: ['auto', 'normalize', 'assume-shared'], description: 'auto: federate other-unit models as separate projects; normalize: rescale into the first model\'s unit; assume-shared: one project, no rescale.' },
      merge_sites: { type: 'string', enum: ROOT_MODES, description: 'How IfcSite is matched across models.' },
      merge_buildings: { type: 'string', enum: ROOT_MODES, description: 'How IfcBuilding is matched across models.' },
      merge_storeys: { type: 'string', enum: STOREY_MODES, description: 'How IfcBuildingStorey is matched across models.' },
      drop_empty_containers: { type: 'boolean', description: 'Leave out spatial containers that hold nothing after the merge.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  outputSchema: fileOutputSchema({
    modelCount: { type: 'integer' },
    totalEntityCount: { type: 'integer' },
    federatedModelCount: { type: 'integer' },
    normalizedModelCount: { type: 'integer' },
    droppedContainerCount: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
  }),
  async handler(input, ctx) {
    const ids = (input.model_ids as string[] | undefined) ?? listAllowedModelIds(ctx);
    if (new Set(ids).size !== ids.length) throw invalid('model_ids lists a model more than once.');
    if (ids.length < 2) throw invalid(`model_merge needs at least 2 models; ${ids.length} given or loaded.`);
    const models = ids.map((id) => resolveModel(ctx, id));
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    // After the await: an edit queued while it ran must still refuse the call.
    for (const m of models) requireNoPendingEdits(m, 'model_merge');
    // Default: the first model's schema, so a merge never converts unasked.
    const schema = (input.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3' | undefined)
      ?? (schemaOf(models[0]) as 'IFC2X3' | 'IFC4' | 'IFC4X3');
    // A model in another schema is converted on the way in: same pre-check as model_convert (#4206).
    const conversionWarnings: string[] = [];
    for (const m of models) {
      const from = schemaOf(m);
      if (from === schema) continue;
      const loss = analyzeConversionLoss(m.store, from, schema);
      if (loss.hasBlocking) {
        throw new ToolExecutionError({
          code: ToolErrorCode.UNSUPPORTED_OPERATION,
          message: `Cannot merge '${m.id}' into ${schema}: some of its entity types have no ${schema} representation and can be neither dropped nor replaced.`,
          details: { modelId: m.id, lossReport: loss.entries.map(lossEntryRow) },
        });
      }
      for (const line of loss.describe()) conversionWarnings.push(`${m.id} (${from} to ${schema}): ${line}`);
    }
    const exporter = new MergedExporter(models.map((m) => ({ id: m.id, name: m.name, dataStore: m.store })));
    const result = exporter.export({
      schema,
      unitReconciliation: input.unit_reconciliation as 'auto' | 'normalize' | 'assume-shared' | undefined,
      mergeSites: input.merge_sites as 'single' | 'by-name' | undefined,
      mergeBuildings: input.merge_buildings as 'single' | 'by-name' | undefined,
      mergeStoreys: input.merge_storeys as 'by-name' | 'by-elevation' | 'by-name-then-elevation' | undefined,
      dropEmptyContainers: input.drop_empty_containers === true,
    });
    throwIfCancelled(ctx);
    await writeFile(filePath, result.content);
    const s = { ...result.stats, warnings: [...conversionWarnings, ...result.stats.warnings] };
    return okResult(
      `Merged ${s.modelCount} models into ${filePath} (${fmtInt(s.totalEntityCount)} entities).` +
        (s.warnings.length > 0 ? ` Warnings: ${s.warnings.join('; ')}` : ''),
      {
        filePath,
        bytes: s.fileSize,
        modelCount: s.modelCount,
        totalEntityCount: s.totalEntityCount,
        federatedModelCount: s.federatedModelCount,
        normalizedModelCount: s.normalizedModelCount,
        droppedContainerCount: s.droppedContainerCount,
        warnings: s.warnings,
      },
    );
  },
};

const modelConvert: Tool = {
  name: 'model_convert',
  title: 'Convert schema version',
  description:
    'Convert, upgrade or downgrade a model to another IFC schema version (IFC2X3, IFC4, IFC4X3) and write it, pending edits included. Returns the loss report: which entity types are kept, mapped, replaced or dropped. Refuses when a type has no representation in the target and cannot be dropped.',
  scope: 'export',
  annotations: FILE_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Model to convert; optional when one model is loaded.' },
      schema: { type: 'string', enum: ['IFC2X3', 'IFC4', 'IFC4X3'], description: 'Target schema.' },
      file_path: { type: 'string', description: 'Output .ifc path, inside the allowed paths.' },
    },
    required: ['schema', 'file_path'],
    additionalProperties: false,
  },
  outputSchema: fileOutputSchema({
    sourceSchema: { type: 'string' },
    targetSchema: { type: 'string' },
    lossReport: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          targetType: { type: ['string', 'null'] },
          kind: { type: 'string' },
          count: { type: 'integer' },
          droppedAttributes: { type: 'array', items: { type: 'string' }, description: 'Attributes the target schema has no slot for.' },
          recordGroups: { type: 'array', description: 'When records of this type convert to different targets: one row per target.', items: { type: 'object' } },
        },
      },
    },
  }),
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const target = input.schema as 'IFC2X3' | 'IFC4' | 'IFC4X3';
    const source = schemaOf(m);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    // Pending edits are baked and re-parsed first, so the loss pre-check sees
    // what the export writes, created entities included.
    const baked = m.backend.hasPendingChanges()
      ? await withIfcBytes(m, (bytes) => loadIfcModelFromBytes(bytes, m.name))
      : undefined;
    try {
      const store = baked?.store ?? m.store;
      // Same pre-check as `ifc-lite convert` (#4206): a type the target cannot
      // represent is reported by name instead of throwing mid-export.
      const loss = analyzeConversionLoss(store, source, target);
      if (loss.hasBlocking) {
        throw new ToolExecutionError({
          code: ToolErrorCode.UNSUPPORTED_OPERATION,
          message: `Cannot convert to ${target}: some entity types have no ${target} representation and are not IfcRoot subtypes, so they can be neither dropped nor replaced.`,
          details: { lossReport: loss.entries.map(lossEntryRow) },
        });
      }
      const content = exportToStep(store, { schema: target });
      throwIfCancelled(ctx);
      await writeFile(filePath, content);
      const bytes = Buffer.byteLength(content);
      return okResult(
        `Converted ${source} to ${target}: wrote ${fmtInt(bytes)} bytes to ${filePath}.` +
          (loss.entries.length > 0 ? `\n${loss.describe().join('\n')}` : ''),
        {
          filePath,
          bytes,
          sourceSchema: source,
          targetSchema: target,
          lossReport: loss.entries.map(lossEntryRow),
        },
      );
    } finally {
      baked?.backend.dispose();
    }
  },
};

const modelExtract: Tool = {
  name: 'model_extract',
  title: 'Extract entities to a standalone IFC',
  description:
    'Extract, isolate or cut out selected products into a small valid standalone IFC that keeps their full reference closure, openings and fillers, spatial ancestors and project context. Records are copied byte-for-byte, so a suspect element reproduces outside its source file. Selectors are unioned.',
  scope: 'export',
  annotations: FILE_WRITE_ANNOTATIONS,
  inputSchema: {
    type: 'object',
    properties: {
      model_id: { type: 'string', description: 'Source model; optional when one model is loaded.' },
      file_path: { type: 'string', description: 'Output .ifc path, inside the allowed paths.' },
      global_ids: { ...stringList, description: 'Products by GlobalId.' },
      express_ids: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Products by express id in the source file.' },
      types: { ...stringList, description: 'Every entity of these IFC types, subtypes included (IfcWall selects IfcWallStandardCase).' },
      storeys: { ...stringList, description: 'Every product placed under these storeys: GlobalId, #id, or exact Name.' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  outputSchema: fileOutputSchema({ seedCount: { type: 'integer' }, instanceCount: { type: 'integer' } }),
  async handler(input, ctx) {
    const m = resolveModel(ctx, input.model_id as string | undefined);
    const filePath = await resolveSafePath(input.file_path, ctx, 'write');
    const products = [
      ...nonBlank(input.global_ids as string[] | undefined),
      ...((input.express_ids as number[] | undefined) ?? []).map((id) => `#${id}`),
    ];
    const types = nonBlank(input.types as string[] | undefined).map(withIfcPrefix);
    const storeys = nonBlank(input.storeys as string[] | undefined);
    if (products.length + types.length + storeys.length === 0) {
      throw invalid('Select something: global_ids, express_ids, types or storeys.');
    }
    return withIfcBytes(m, async (bytes) => {
      if (bytes.byteLength >= bufferConstants.MAX_STRING_LENGTH) {
        throw new ToolExecutionError({
          code: ToolErrorCode.UNSUPPORTED_OPERATION,
          message: `The model is too large to extract from (${fmtInt(bytes.byteLength)} bytes, over the V8 string limit).`,
        });
      }
      // latin1 is a lossless byte<->char bijection, so raw high bytes in the
      // source round-trip unchanged (same as the CLI).
      const parsed = parseStep(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1'));
      let seeds: Set<number>;
      try {
        seeds = selectSubsetSeeds(parsed, { products, types, storeys });
      } catch (err) {
        if (!(err instanceof SubsetSelectionError)) throw err;
        if (err.kind === 'invalid') throw invalid(err.message);
        throw new ToolExecutionError({ code: ToolErrorCode.ENTITY_NOT_FOUND, message: err.message });
      }
      if (seeds.size === 0) {
        const tried: string[] = [];
        if (types.length > 0) tried.push(`no product of type ${types.join(', ')} (or a subtype)`);
        if (storeys.length > 0) tried.push(`no product under storey ${storeys.join(', ')}`);
        throw invalid(`Nothing matched: ${tried.join(', and ')}.`);
      }
      const subset = buildSubset(seeds, parsed);
      const out = Buffer.from(serializeSubset(subset, parsed), 'latin1');
      throwIfCancelled(ctx);
      await writeFile(filePath, out);
      return okResult(
        `Extracted ${seeds.size} selected entities into ${subset.keep.size} instances: ${filePath}.`,
        { filePath, bytes: out.length, seedCount: seeds.size, instanceCount: subset.keep.size },
      );
    });
  },
};

/** Every file-writing model transform: merge, convert, extract, anonymize, simplify, LOD. */
export const transformTools: Tool[] = [modelMerge, modelConvert, modelExtract, modelAnonymize, ...meshTransformTools];
