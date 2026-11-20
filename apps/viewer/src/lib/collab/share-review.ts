/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';
import type { ShareScope } from './share-scope';
export interface ShareReviewCandidate { id: string; scope: ShareScope; role: 'viewer' | 'commenter' | 'editor'; modelIds: string[]; activeModelId: string | null; loadedModelIds: string[]; mutationVersion: number; geometryVersion: number; roomId: string | null }
/** Configuration for the native consent dialog; never contains room tokens or model bytes. */
export const useCollabShareReview = create<{ candidate: ShareReviewCandidate | null; dialogOpen: boolean }>(() => ({ candidate: null, dialogOpen: false }));
