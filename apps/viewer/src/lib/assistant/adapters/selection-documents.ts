/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { DocumentInfo } from '@ifc-lite/parser';
const bounded = (value: string | undefined) => value === undefined ? null : value.length > 240 ? `${value.slice(0, 240)}…` : value;
/** Native normalized document fields retain their actual EXPRESS spelling in evidence (#7187). */
export function documentEvidence(document: DocumentInfo, schemaVersion: string | undefined) {
  const idName = schemaVersion === 'IFC2X3'
    ? document.type === 'IfcDocumentReference' ? 'ItemReference' : 'DocumentId' : 'Identification';
  return { expressId: document.expressId ?? null, type: document.type === 'Unknown' ? null : document.type ?? null,
    verification: document.unresolved ? 'unverified' : 'resolved', sourceOrigin: document.sourceOrigin ?? false,
    referencedDocumentId: document.referencedDocumentId ?? null, [idName]: bounded(document.identification),
    Name: bounded(document.name), Description: bounded(document.description), Location: bounded(document.location),
    Purpose: bounded(document.purpose), IntendedUse: bounded(document.intendedUse), Revision: bounded(document.revision),
    Confidentiality: bounded(document.confidentiality) };
}
