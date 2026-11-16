/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #9523: the reasons hooks/ingest/nonModelContent gives for refusing an error response saved or served as a
 * model, and the message they travel in. A dependency-free leaf, so the invalid-input classifier can match
 * them without importing the ingest graph.
 */
export const NON_MODEL_REASONS = {
  html: 'an HTML page',
  json: 'a JSON response',
  ifcxHeader: 'a JSON document without an IFCX header.ifcxVersion',
  xmlError: 'an XML error response',
  notStep: 'content that is neither STEP nor an IFC ZIP',
} as const;
export type NonModelReason = (typeof NON_MODEL_REASONS)[keyof typeof NON_MODEL_REASONS];

/** The message every refusal carries, matched by the invalid-input classifier. */
export function nonModelContentMessage(reason: NonModelReason): string {
  return `The file is ${reason}, not a model.`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
/** Matches exactly the messages {@link nonModelContentMessage} builds. */
export const NON_MODEL_MESSAGE = new RegExp(`^The file is (?:${Object.values(NON_MODEL_REASONS).map(escapeRegExp).join('|')}), not a model\\.$`);
