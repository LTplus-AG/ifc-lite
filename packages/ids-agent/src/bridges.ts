/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * What the agent reads from outside the document, as interfaces the host
 * implements. The agent package holds no model, no network client and no UI.
 *
 * - `ModelBridge`: the loaded IFC models, answered by the model-loop worker
 *   (P-05, `04-model-loop.md` §7). Only counts, capped distinct values and
 *   class statistics cross it: never geometry, never file names.
 * - `BsddClient`: buildSmart Data Dictionary lookups (P-06, `05-bsdd.md` §3).
 * - `AskUserHandler`: a structured clarification answered by the UI, or by
 *   the first choice when the run is non-interactive.
 */

import type { IDSFacet, IFCVersion } from '@ifc-lite/ids';
import type { StudioOp } from '@ifc-lite/ids-authoring';

export interface ClassCount {
  /** PascalCase IFC class name. */
  name: string;
  count: number;
}

export interface ModelSummary {
  /** Opaque handle; never a file name. */
  id: string;
  schema: string;
  elementCount: number;
  /** Most frequent classes first, capped by the bridge. */
  classes: ClassCount[];
  /** Length unit as declared, e.g. `MILLIMETRE`. */
  lengthUnit?: string;
}

export interface FunnelStage {
  /** Index of the applicability facet the stage ends with (-1: all elements of matching schema). */
  facetIndex: number;
  count: number;
}

export interface FunnelCounts {
  stages: FunnelStage[];
  /** Elements that match the whole applicability. */
  applicable: number;
  /** Set when a requirement preview ran. */
  passing?: number;
  failing?: number;
}

export interface DistinctValues {
  values: { value: string; count: number }[];
  /** True when the bridge capped the list or truncated strings. */
  truncated: boolean;
}

/** Facets and counts proposed by inference (`InferenceResult`, `04-model-loop.md` §3). */
export interface InferenceCandidate {
  section: 'applicability' | 'requirements';
  facet: IDSFacet;
  /** Positive examples that have it, of the total. */
  positives: { matched: number; total: number };
  negatives?: { matched: number; total: number };
}

export interface InferenceResult {
  candidates: InferenceCandidate[];
  sampled: boolean;
}

export interface ModelBridge {
  stats(signal: AbortSignal): Promise<ModelSummary[]>;
  /** Funnel counts for an applicability (and optionally requirement preview). */
  count(query: { applicability: IDSFacet[]; requirements?: IDSFacet[]; ifcVersions?: IFCVersion[] }, signal: AbortSignal): Promise<FunnelCounts>;
  distinctValues(query: { entity?: string; propertySet: string; property: string; limit: number }, signal: AbortSignal): Promise<DistinctValues>;
  infer(query: { selection?: string; entity?: string; threshold: number }, signal: AbortSignal): Promise<InferenceResult>;
  /** Classes no specification of `applicabilities` governs, by count. */
  coverage(query: { applicabilities: IDSFacet[][] }, signal: AbortSignal): Promise<ClassCount[]>;
}

export interface BsddClassSummary {
  uri: string;
  code: string;
  name: string;
  dictionaryUri: string;
  dictionaryName?: string;
  /** IFC classes the dictionary relates the class to, e.g. `IfcWall`. */
  relatedIfcEntities?: string[];
}

export interface BsddClassCard extends BsddClassSummary {
  definition?: string;
  parentUri?: string;
  status?: string;
}

export interface BsddPropertyCard {
  uri?: string;
  code: string;
  name: string;
  /** IFC property set the dictionary assigns, when it assigns one. */
  propertySet?: string;
  dataType?: string;
  units?: string[];
  allowedValues?: { code: string; value: string }[];
  definition?: string;
}

export type BsddResolution =
  | { kind: 'class'; card: BsddClassCard }
  | { kind: 'property'; card: BsddPropertyCard }
  | { kind: 'dictionary'; uri: string; name: string; version?: string }
  | { kind: 'unknown'; uri: string };

export interface BsddClient {
  search(query: { text: string; dictionaryUri?: string; relatedIfcEntity?: string; limit: number }, signal: AbortSignal): Promise<BsddClassSummary[]>;
  getClass(uri: string, signal: AbortSignal): Promise<BsddClassCard | null>;
  classProperties(uri: string, signal: AbortSignal): Promise<BsddPropertyCard[]>;
  resolveUri(uri: string, signal: AbortSignal): Promise<BsddResolution>;
}

/** One answer the agent offers, ready to apply: the user picks, nothing is typed in. */
export interface AskUserChoice {
  label: string;
  rationale?: string;
  /** Op batch applied to the sandbox when this choice is picked (may be empty). */
  ops: StudioOp[];
}

export interface AskUserQuestion {
  /** The tool call id; stable key for the UI. */
  id: string;
  question: string;
  choices: AskUserChoice[];
}

/** The index of the chosen answer, or null when the user dismissed the question. */
export type AskUserHandler = (question: AskUserQuestion, signal: AbortSignal) => Promise<number | null>;

/** Headless (`--non-interactive`) policy: always the first choice. */
export const firstChoice: AskUserHandler = async () => 0;
