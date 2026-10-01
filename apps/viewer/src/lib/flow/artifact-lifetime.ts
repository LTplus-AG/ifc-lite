/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { StoreApi } from 'zustand';
import type { ViewerState } from '@/store';

/** A PDF belongs to one immutable document revision, even after its run ends. */
export function registerWorkflowArtifactInvalidation(store: StoreApi<ViewerState>): void {
  store.subscribe((state, previous) => {
    if (!state.flowArtifacts.length) return;
    if (state.flowDoc !== previous.flowDoc) {
      store.setState({ flowArtifacts: [] }); return;
    }
    if (state.documents === previous.documents && state.flowArtifacts === previous.flowArtifacts) return;
    const artifacts = state.flowArtifacts.filter((artifact) => {
      const document = state.documents.find((d) => d.id === artifact.documentId);
      return document !== undefined && JSON.stringify(document) === artifact.documentSignature;
    });
    if (artifacts.length !== state.flowArtifacts.length) store.setState({ flowArtifacts: artifacts });
  });
}
