/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';
import type { LibraryKind } from './native-catalogue';

/** One native management/history target. No artifact payload or duplicate persistence. */
export const useLibraryFocus = create<{ target: { kind: LibraryKind; id: string } | null }>(() => ({ target: null }));
