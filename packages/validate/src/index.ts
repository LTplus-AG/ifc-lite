/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/validate: IFC validation generated from the buildingSMART EXPRESS
 * schemas by `@ifc-lite/codegen`. Runs without Node built-ins (browsers,
 * Workers). Schema loading uses a dynamic import for each release.
 */

import { headerBoundaryReached, headerRecords } from './runtime/step-reader.js';
import { Model, type StepRecordSource } from './runtime/model.js';
import type { SchemaRuntime } from './runtime/schema-runtime.js';
import type { ValidationReport } from './engine/findings.js';
import { validateModel, type ValidateOptions } from './engine/validate.js';

export { validateModel, type ValidateOptions } from './engine/validate.js';
export type { FindingCategory, NotEvaluated, SchemaCheck, ValidationFinding, ValidationReport } from './engine/findings.js';
export { Model, type RecordProvider, type StepRecordSource } from './runtime/model.js';
export { SchemaRuntime } from './runtime/schema-runtime.js';

export type SchemaRelease = 'IFC2X3' | 'IFC4' | 'IFC4X3';

/** The generated release that validates a FILE_SCHEMA identifier (`IFC4X3_ADD2` -> IFC4X3). */
export function releaseFor(identifier: string): SchemaRelease | undefined {
  const id = identifier.toUpperCase();
  if (id.startsWith('IFC4X3')) return 'IFC4X3';
  if (id === 'IFC4' || id.startsWith('IFC4_')) return 'IFC4';
  if (id.startsWith('IFC2X3')) return 'IFC2X3';
  return undefined;
}

export async function loadSchema(release: SchemaRelease): Promise<SchemaRuntime> {
  switch (release) {
    case 'IFC2X3': return (await import('./generated/ifc2x3/index.js')).SCHEMA;
    case 'IFC4': return (await import('./generated/ifc4/index.js')).SCHEMA;
    case 'IFC4X3': return (await import('./generated/ifc4x3/index.js')).SCHEMA;
  }
}

export function fileSchemaIdentifier(stepText: string): string | undefined {
  const names = headerRecords(stepText).get('FILE_SCHEMA')?.[0];
  return Array.isArray(names) && typeof names[0] === 'string' ? names[0] : undefined;
}

async function schemaOrThrow(identifier: string | undefined, schema?: SchemaRuntime): Promise<SchemaRuntime> {
  if (schema) return schema;
  const release = identifier ? releaseFor(identifier) : undefined;
  if (!release) throw new Error(`No generated validator for FILE_SCHEMA ${identifier ?? '(missing)'}`);
  return loadSchema(release);
}

export interface ValidateInput extends ValidateOptions {
  /** Validate against this schema instead of the one FILE_SCHEMA names. */
  schema?: SchemaRuntime;
}

/** Validate an IFC-SPF (STEP) text. */
export async function validateStepText(text: string, options: ValidateInput = {}): Promise<ValidationReport> {
  const schema = await schemaOrThrow(fileSchemaIdentifier(text), options.schema);
  return validateModel(Model.fromStepText(text, schema), { headerText: text, ...options });
}

export interface DataStoreLike extends StepRecordSource {
  schemaVersion?: string;
  sourceHeader?: { schemaIdentifiers?: string[] };
  source: StepRecordSource['source'] & { byteLength?: number };
}

const HEADER_PREFIX_BYTES = 1 << 16;

function readHeader(source: DataStoreLike['source']): string {
  let end = Math.min(source.byteLength ?? HEADER_PREFIX_BYTES, HEADER_PREFIX_BYTES);
  let previousLength = -1;
  for (;;) {
    const text = source.decodeUtf8(0, end);
    if (end === source.byteLength || text.length === previousLength || headerBoundaryReached(text)) return text;
    previousLength = text.length;
    end = Math.min(end * 2, source.byteLength ?? Infinity);
  }
}

/** Validate a model parsed by `@ifc-lite/parser` (its `IfcDataStore`). */
export async function validateDataStore(store: DataStoreLike, options: ValidateInput = {}): Promise<ValidationReport> {
  const identifier = store.sourceHeader?.schemaIdentifiers?.[0] ?? store.schemaVersion;
  const schema = await schemaOrThrow(identifier, options.schema);
  const headerText = options.headerText ?? readHeader(store.source);
  return validateModel(Model.fromDataStore(store, schema), { ...options, headerText });
}
