/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9523: the reasons hooks/ingest/nonModelContent gives for refusing an error response saved or served as a
 * model, and the message they travel in. A dependency-free leaf, so the invalid-input classifier can match
 * them without importing the ingest graph.
 */
export const NON_MODEL_REASONS = {
  html: 'an HTML page, not a model',
  json: 'a JSON response, not a model',
  ifcxHeader: 'a JSON document without a valid IFCX header.ifcxVersion, not an IFCX model',
  xmlError: 'an XML error response, not a model',
  notStep: 'content that is neither STEP nor an IFC ZIP',
  utf16Step: 'STEP saved as UTF-16, which the parser cannot read; save it as UTF-8',
} as const;
export type NonModelReason = (typeof NON_MODEL_REASONS)[keyof typeof NON_MODEL_REASONS];

/** The message every refusal carries, matched by the invalid-input classifier. */
export function nonModelContentMessage(reason: NonModelReason): string {
  return `The file is ${reason}.`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
/** Matches exactly the messages {@link nonModelContentMessage} builds. */
export const NON_MODEL_MESSAGE = new RegExp(`^The file is (?:${Object.values(NON_MODEL_REASONS).map(escapeRegExp).join('|')})\\.$`);
