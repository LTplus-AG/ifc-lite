/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IDS validation worker.
 *
 * IDS validation is pure CPU work over the whole entity population — on
 * the main thread it pins the UI (no progress paints, frame rate
 * collapses) exactly like an unworkered parse would. Every other heavy
 * stage in this viewer (STEP parse, geometry) already runs in a worker;
 * this brings validation in line.
 *
 * The worker re-parses the IFC source bytes (~150ms for a 550k-entity
 * model — negligible next to validation) into its own IfcDataStore so
 * the main-thread store is never touched, then runs the shared
 * `@ifc-lite/ids` validator with the canonical bridge accessor. The IDS
 * XML is parsed on the main thread (workers have no DOMParser) and the
 * plain IDSDocument is handed across; progress is streamed back as it
 * happens.
 */

import { IfcParser } from '@ifc-lite/parser';
import {
  validateIDS,
  createTranslationService,
  type IDSDocument,
  type IDSValidationReport,
  type ValidationProgress,
} from '@ifc-lite/ids';
import { createDataAccessor } from '@ifc-lite/ids/bridge';

export interface IdsWorkerRequest {
  type: 'validate';
  id: number;
  /** Raw IFC/STEP bytes — a SharedArrayBuffer is shared zero-copy. */
  source: ArrayBuffer | SharedArrayBuffer;
  /** IDS document already parsed on the main thread (no DOMParser here). */
  document: IDSDocument;
  schemaVersion: string;
  modelId: string;
  locale: 'en' | 'de' | 'fr';
  includePassingEntities: boolean;
}

export type IdsWorkerResponse =
  | { type: 'progress'; id: number; progress: ValidationProgress }
  | { type: 'complete'; id: number; report: IDSValidationReport }
  | { type: 'error'; id: number; message: string };

const post = (msg: IdsWorkerResponse) => {
  (self as unknown as Worker).postMessage(msg);
};

self.onmessage = async (event: MessageEvent<IdsWorkerRequest>) => {
  const req = event.data;
  if (!req || req.type !== 'validate') return;

  try {
    const parser = new IfcParser();
    // The worker owns this buffer; a SAB is shared by reference, a plain
    // ArrayBuffer was copied by the caller, so parsing it here is safe.
    const store = await parser.parseColumnar(req.source);
    store.schemaVersion =
      (req.schemaVersion as typeof store.schemaVersion) || store.schemaVersion;

    const accessor = createDataAccessor(store);
    const translator = createTranslationService(req.locale);

    const report = await validateIDS(
      req.document,
      accessor,
      {
        modelId: req.modelId,
        schemaVersion: store.schemaVersion,
        entityCount: store.entityCount ?? accessor.getAllEntityIds().length,
      },
      {
        translator,
        includePassingEntities: req.includePassingEntities,
        // Yield periodically so progress postMessages flush to the main
        // thread incrementally instead of arriving in one burst at the
        // end. The worker has no UI, but cross-thread message delivery
        // still benefits from real event-loop turns.
        yieldEveryMs: 30,
        onProgress: (progress) => post({ type: 'progress', id: req.id, progress }),
      }
    );

    post({ type: 'complete', id: req.id, report });
  } catch (err) {
    post({
      type: 'error',
      id: req.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
