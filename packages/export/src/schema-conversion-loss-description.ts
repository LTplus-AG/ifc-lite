/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { ConversionLossEntry } from './schema-conversion-loss-report.js';

const MAX_IDS_NAMED = 8;

export function describeEntry(entry: ConversionLossEntry, omissionReason?: string): string {
  const ids = entry.expressIds.slice(0, MAX_IDS_NAMED).map((id) => `#${id}`).join(', ');
  const more = entry.expressIds.length > MAX_IDS_NAMED ? `, +${entry.expressIds.length - MAX_IDS_NAMED} more` : '';
  if (omissionReason) return `${entry.count} × ${entry.sourceType} (${ids}${more}) will be omitted because ${omissionReason}.`;
  const attrs = entry.droppedAttributes.length > 0 ? ` — loses ${entry.droppedAttributes.join(', ')}` : '';
  switch (entry.kind) {
    case 'blocked':
      return (
        `${entry.count} × ${entry.sourceType} (${ids}${more}) has no representation in this schema and is ` +
        `not an IfcRoot subtype: conversion cannot write these records at all${attrs}.`
      );
    case 'proxied':
      return (
        `${entry.count} × ${entry.sourceType} (${ids}${more}) has no representation in this schema: these ` +
        `become generic IFCPROXY placeholders, losing their own type${attrs}.`
      );
    case 'lossy':
    default:
      return `${entry.count} × ${entry.sourceType} → ${entry.targetType} (${ids}${more})${attrs}.`;
  }
}
