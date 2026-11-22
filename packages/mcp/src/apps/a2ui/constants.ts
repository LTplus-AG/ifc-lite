/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

export const A2UI_APP_URI = 'ui://ifc-lite/a2ui-surface';
export const A2UI_APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const SURFACE_ACTION_TOOL = 'a2ui_viewer_action';
export const SURFACE_ACTIONS = ['select', 'isolate', 'colorize', 'flyTo', 'resetView'] as const;
export type SurfaceAction = typeof SURFACE_ACTIONS[number];
