/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { WorkspacePanelId } from './panels/registry.js';

// UI interaction events (#5618): which surface triggered an action, which
// panels open, when the view is reset. Autocapture stays off (no consent UI),
// so these are the only interaction signal. Every one is id-only — no names,
// paths or free text — and the contract is enforced twice: at compile time by
// `UiEventProperties` (via `trackUiEvent` in ./analytics.ts), and at send time
// by `scrubUiEvent` below, which `beforeSend` runs on every event. Kept
// dependency-free, like ./analytics-scrub.ts, so it is unit-testable without
// posthog-js.

/** The chrome an action was started from. */
export type UiSurface = 'ribbon' | 'classic' | 'palette' | 'context' | 'shortcut' | 'mobile';

/** Esc no longer resets the view (#5595), so it is not a trigger. */
export type ViewResetTrigger = 'home' | 'a' | 'show_all';

/** `switch` = another tool (or Select) was picked; `esc` = the Escape key. */
export type ToolExitVia = 'esc' | 'switch';

/** `unsupported_format` = a format we recognise and explain; otherwise `unrecognized_format`. */
export type FileOpenRejectReason = 'unsupported_format' | 'unrecognized_format';

export type OnboardingSurfaceId = 'tour_invite' | 'ribbon_notice';
export type OnboardingAction = 'dismiss' | 'start_tour' | 'keep_classic';

export interface UiEventProperties {
  command_executed: { command_id: string; surface: UiSurface };
  /** `surface` is absent when the entry point did not say where it came from. */
  panel_opened: { panel_id: WorkspacePanelId; surface?: UiSurface };
  panel_replaced: { from: WorkspacePanelId; to: WorkspacePanelId };
  tool_activated: { tool: string };
  tool_exited: { tool: string; via: ToolExitVia };
  view_reset: { trigger: ViewResetTrigger };
  /** `code` is a fixed id (a `LoadErrorKind` or a per-path failure id), never a message. */
  error_shown: { code: string; surface: 'load_error' };
  file_open_rejected: { reason: FileOpenRejectReason };
  onboarding_surface: { surface: OnboardingSurfaceId; action: OnboardingAction };
}

export type UiEventName = keyof UiEventProperties;

/** Runtime twin of {@link UiEventProperties}: the only keys `scrubUiEvent` lets through. */
const UI_EVENT_KEYS: { readonly [E in UiEventName]: ReadonlyArray<keyof UiEventProperties[E]> } = {
  command_executed: ['command_id', 'surface'],
  panel_opened: ['panel_id', 'surface'],
  panel_replaced: ['from', 'to'],
  tool_activated: ['tool'],
  tool_exited: ['tool', 'via'],
  view_reset: ['trigger'],
  error_shown: ['code', 'surface'],
  file_open_rejected: ['reason'],
  onboarding_surface: ['surface', 'action'],
};

// Properties the SDK or our own `register()` adds to every event. They are not
// the call site's, so the per-event allowlist must not strip them; they still
// pass through scrubEvent's privacy net like everything else.
const SDK_PASSTHROUGH_KEYS = new Set(['token', 'distinct_id', 'app_version', 'app_build_sha']);

// An id: registry ids, enum members, error kinds. No dot, slash or space, so a
// file name ("Tower.ifc") or a sentence can never qualify.
const ID_VALUE = /^[A-Za-z0-9_:-]{1,64}$/;

// Command-palette rows whose id embeds user or third-party data after a fixed
// prefix: a recent file's name, a script template's name, an extension's id.
const DYNAMIC_COMMAND_PREFIXES = ['file:recent:', 'auto:', 'ext:'];

/** The id to report for a palette command: dynamic rows collapse to their prefix. */
export function commandIdForAnalytics(id: string): string {
  const prefix = DYNAMIC_COMMAND_PREFIXES.find((p) => id.startsWith(p));
  return prefix ? prefix.slice(0, -1) : id;
}

const isUiEventName = (name: string | undefined): name is UiEventName =>
  name !== undefined && Object.prototype.hasOwnProperty.call(UI_EVENT_KEYS, name);

/**
 * `before_send` step: on a UI interaction event, drop every property that is
 * not declared for that event (SDK / super-properties aside), and every
 * declared one whose value is not an id. Other events pass untouched.
 */
export const scrubUiEvent = <
  T extends { event?: string; properties?: Record<string, unknown> } | null,
>(event: T): T => {
  if (!event?.properties || !isUiEventName(event.event)) return event;
  const allowed: ReadonlyArray<string> = UI_EVENT_KEYS[event.event];
  const props = event.properties;
  for (const key of Object.keys(props)) {
    if (key.startsWith('$') || SDK_PASSTHROUGH_KEYS.has(key)) continue;
    const value = props[key];
    if (!allowed.includes(key) || typeof value !== 'string' || !ID_VALUE.test(value)) delete props[key];
  }
  return event;
};
