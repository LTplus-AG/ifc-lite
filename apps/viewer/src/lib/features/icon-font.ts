/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The hosted icon font behind the model tree's IFC class glyphs. It used to
 * be linked from `index.html`, which made every page load ask the font host;
 * now `mountViewer` links it once the host's configuration is known, and not
 * at all when the host switched third-party requests off. The tree then
 * shows one generic icon per class (`HierarchyNode`).
 */

import { isFeatureEnabled } from './index';

const FONT_CSS = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=swap';

/** Whether this page links the font; without it the IFC class glyphs cannot render. */
export function isIconFontOffered(): boolean {
  return isFeatureEnabled('privacy.third-party');
}

export function linkIconFont(doc: Document = document): void {
  if (!isIconFontOffered()) return;
  if (doc.head.querySelector(`link[href="${FONT_CSS}"]`)) return;
  const preconnect = doc.createElement('link');
  preconnect.rel = 'preconnect';
  preconnect.href = 'https://fonts.gstatic.com';
  preconnect.crossOrigin = '';
  const stylesheet = doc.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = FONT_CSS;
  doc.head.append(preconnect, stylesheet);
}
