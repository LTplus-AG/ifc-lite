/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Render as the 3D view does: inside its live scope (#10535), so viewport
 * hooks see an edit in its own task. The scope is looked up by name: where the
 * store has none (main before #10535), the store is live and a fragment serves.
 */
import { Fragment, createElement, type ReactNode } from 'react';
import * as store from '@/store';
import { render } from './render.js';

type Scope = (props: { children: ReactNode }) => ReactNode;
const ViewportScope: Scope = (store as { LiveViewerScope?: Scope }).LiveViewerScope ?? Fragment;

export function renderInViewport(ui: ReactNode): HTMLElement {
  return render(createElement(ViewportScope, null, ui));
}
