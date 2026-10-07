/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { create } from 'zustand';
import type { Clash } from '@ifc-lite/clash';

/** A validated saved finding requested from Review, displayed by the native baseline dialog. */
export const useOriginalClashBaseline = create<{ finding: { clash: Clash; takenAt: number; modelNames: Readonly<Record<string, string>> } | null }>(() => ({ finding: null }));
