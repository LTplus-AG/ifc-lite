/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import { AppearancePreviewSession } from './preview';
/** Compare changes presentation only; candidate plans, images and fingerprints
 * remain owned by their original native preview candidate. */
export function compareNativeAppearancePreview(
  renderer: Renderer,
  groups: Parameters<AppearancePreviewSession['stage']>[0],
  session: AppearancePreviewSession | null,
  original: boolean,
): AppearancePreviewSession | null {
  if (original) {
    session?.cancel();
    return null;
  }
  if (session) return session;
  const next = new AppearancePreviewSession(renderer);
  try {
    next.stage(groups);
    return next;
  } catch (error) {
    next.cancel();
    throw error;
  }
}
