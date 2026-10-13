/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Canonical saved failure evidence wire contract shared by document import and native Review (#7372). */
import { isFullSourceSHA256 } from './portable-source-contract.js';
export const SAVED_VALIDATION_LIMITS = {
  rows: 2_000, sourceRows: 50_000, rowBytes: 8_192, totalBytes: 1_048_576,
  text: 1_024, checks: 1_024, definitionBytes: 131_072,
} as const;
const SAVED_ELEMENT_LIMIT = SAVED_VALIDATION_LIMITS.rows;
const ROW_BYTE_LIMIT = SAVED_VALIDATION_LIMITS.rowBytes;
const TOTAL_BYTE_LIMIT = SAVED_VALIDATION_LIMITS.totalBytes;
const TEXT_LIMIT = SAVED_VALIDATION_LIMITS.text;
const CHECK_LIMIT = SAVED_VALIDATION_LIMITS.checks;
const DEFINITION_BYTE_LIMIT = SAVED_VALIDATION_LIMITS.definitionBytes;
const DIGEST = /^xxh64:[0-9a-f]{16}$/;
const EVIDENCE_FIELDS = new Set(['version', 'rows', 'observed', 'omitted', 'gaps', 'definition']);
const ROW_FIELDS = new Set(['id', 'specificationId', 'GlobalId', 'modelName', 'modelFingerprint', 'modelContentHash', 'ifcType', 'Name', 'title', 'nativeStatus', 'detail', 'signature']);

export interface SavedValidationElement {
  /** Identity within this immutable capture, independent of ephemeral express/model ids. */
  id: string;
  specificationId: string;
  GlobalId: string | null;
  modelName: string | null;
  modelFingerprint?: string;
  /** Optional producer-captured full source identity; absence remains historical/unbound. */
  modelContentHash?: string;
  ifcType: string;
  Name?: string;
  title: string;
  nativeStatus: 'failed' | 'warning';
  detail: string[];
  /** #7371: digest of the failed requirements and actual values, independent of message language. */
  signature?: string;
}
/** #7371: exactly what the native run checked, as the run reconciler compares it. */
export interface SavedValidationDefinition {
  /** Digest of the whole IDS document or rule-set content. */
  source: string;
  /** Digest of each check (specification, plus rule content for rules), by native specification id. */
  checks: Array<{ id: string; digest: string }>;
}
export interface SavedValidationElements {
  version: 1;
  rows: SavedValidationElement[];
  /** Failed/warning entity rows encountered before the scan cap, not a population total. */
  observed: number;
  /** Encountered failure rows that snapshot limits could not retain. */
  omitted: number;
  /** Native source coverage and snapshot-limit disclosures, never inferred resolution. */
  gaps: string[];
  /** Absent in snapshots saved before #7371 or when the run's content was not recorded: such rows cannot be re-examined. */
  definition?: SavedValidationDefinition;
}

const digest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value);
function validDefinition(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || Object.keys(value).some(key => key !== 'source' && key !== 'checks') || !digest(value.source)
    || !Array.isArray(value.checks) || value.checks.length > CHECK_LIMIT
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > DEFINITION_BYTE_LIMIT) return false;
  const checks: unknown[] = value.checks;
  return checks.every(check => record(check) && Object.keys(check).length === 2 && text(check.id) && digest(check.digest))
    && new Set(checks.map(check => (check as { id: string }).id)).size === checks.length;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number = TEXT_LIMIT): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function isSavedValidationElement(value: unknown): value is SavedValidationElement {
  if (!record(value) || Object.keys(value).some(key => !ROW_FIELDS.has(key)) || !text(value.id, 128) || !text(value.specificationId) || (value.GlobalId !== null && !text(value.GlobalId, 200))
    || (value.modelName !== null && !text(value.modelName)) || (value.modelFingerprint !== undefined && !text(value.modelFingerprint, 256))
    || (value.modelContentHash !== undefined && !isFullSourceSHA256(value.modelContentHash))
    || !text(value.ifcType, 200) || (value.Name !== undefined && (typeof value.Name !== 'string' || value.Name.length > TEXT_LIMIT))
    || typeof value.title !== 'string' || value.title.length > TEXT_LIMIT
    || (value.nativeStatus !== 'failed' && value.nativeStatus !== 'warning') || !Array.isArray(value.detail)
    || value.detail.length > 8 || !value.detail.every(line => text(line)) || (value.signature !== undefined && !digest(value.signature))) return false;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= ROW_BYTE_LIMIT;
}

export function validateSavedValidationElements(value: unknown, at: string, errors: Array<{ path: string; message: string }>): void {
  if (!record(value) || Object.keys(value).some(key => !EVIDENCE_FIELDS.has(key)) || value.version !== 1 || !Array.isArray(value.rows) || value.rows.length > SAVED_ELEMENT_LIMIT
    || !count(value.observed) || !count(value.omitted) || value.observed !== value.rows.length + value.omitted
    || !Array.isArray(value.gaps) || value.gaps.length > 16 || !value.gaps.every(gap => text(gap))
    || !value.rows.every(isSavedValidationElement) || !validDefinition(value.definition) || new Set(value.rows.map(row => row.id)).size !== value.rows.length
    || new TextEncoder().encode(JSON.stringify(value)).byteLength > TOTAL_BYTE_LIMIT) {
    errors.push({ path: at, message: 'expected bounded version-1 saved validation element evidence' });
  }
}
