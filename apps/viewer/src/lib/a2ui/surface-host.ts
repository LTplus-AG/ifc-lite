/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The seam for showing an A2UI surface outside the chat: script output, an
 * agent-bridge push, any panel. Safe to import eagerly; the renderer (~185 KB
 * gzip with the agent parser) loads on first render.
 *
 *   <A2uiMessagesView messages={payload} onFollowUp={(text, context) => ...} />
 *
 * Messages are validated with `validateIfcMessages` before anything renders.
 * Render it inside the app's `BimProvider`; the surfaces act on the loaded models.
 */

import { createElement, Suspense, type ReactElement } from 'react';
import type { AgentToRendererMessage } from '@ifc-lite/a2ui/agent';
import { lazyChunk } from '@/lib/lazy-chunk';
import type { FollowUpHandler } from './actions.js';

export type { AgentToRendererMessage, FollowUpHandler };

import type { A2uiMessagesViewProps } from '@/components/a2ui/MessagesView';

export type { A2uiMessagesViewProps };

const LazyMessagesView = lazyChunk(() => import('@/components/a2ui/MessagesView'));

export function A2uiMessagesView(props: A2uiMessagesViewProps): ReactElement {
  return createElement(Suspense, { fallback: null }, createElement(LazyMessagesView, props));
}
