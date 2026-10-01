/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** A downloadable PDF tied to the exact native document that produced it. */
export interface WorkflowArtifact {
  id: string; name: string; blob: Blob; pages: number; warnings: string[];
  documentId: string; documentSignature: string;
}
