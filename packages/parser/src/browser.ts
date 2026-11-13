/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Browser-only exports for @ifc-lite/parser
 *
 * These exports use Vite-specific features (worker imports) and are only
 * available in browser environments with bundlers that support them.
 *
 * Usage:
 *   import { WorkerParser } from '@ifc-lite/parser/browser';
 */

export { WorkerParser, type WorkerParserOptions } from './worker-parser.js';
export { prepareSpareParserWorker as prepareSpareParser, hasSpareParserWorker, isSpareParserWorkerWarming, releaseSpareParserWorker } from './spare-parser-worker.js';
