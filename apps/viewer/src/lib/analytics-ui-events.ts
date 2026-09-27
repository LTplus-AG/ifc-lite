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

/** The chrome an action was started from. `rail` = the sidebar activity bar. */
export type UiSurface = 'ribbon' | 'classic' | 'rail' | 'palette' | 'shortcut';

/** `programmatic` = the app opened the panel itself (a tour, a load, a
 *  drawing); it is not a user action, so nothing is reported. */
export type PanelOpenSource = UiSurface | 'programmatic';

/** Esc no longer resets the view (#5595), so it is not a trigger. */
export type ViewResetTrigger = 'home' | 'a' | 'show_all';

/** `esc` = the Escape key; `switch` = anything else that picked another tool
 *  or Select (including a tool's own toggle, e.g. K for Split). */
export type ToolExitVia = 'esc' | 'switch';

/** As {@link PanelOpenSource}: a `programmatic` tool change is not reported. */
export type ToolChangeVia = ToolExitVia | 'programmatic';

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
// pass through scrubEvent's privacy net like everything else. Every other
// property, `$`-prefixed ones included, must be declared for the event, so a
// `$set` / `$set_once` person update can never ride along.
const SDK_PASSTHROUGH_KEYS = new Set(['token', 'distinct_id', 'app_version', 'app_build_sha']);
const PERSON_UPDATE_KEYS = new Set(['$set', '$set_once', '$unset']);
export const isSdkProperty = (key: string): boolean =>
  SDK_PASSTHROUGH_KEYS.has(key) || (key.startsWith('$') && !PERSON_UPDATE_KEYS.has(key));

// Closed vocabularies: a value outside them is dropped.
const ENUM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  surface: new Set<string>(['ribbon', 'classic', 'rail', 'palette', 'shortcut', 'load_error', 'tour_invite', 'ribbon_notice']),
  via: new Set<string>(['esc', 'switch']),
  trigger: new Set<string>(['home', 'a', 'show_all']),
  reason: new Set<string>(['unsupported_format', 'unrecognized_format']),
  action: new Set<string>(['dismiss', 'start_tour', 'keep_classic']),
};

// Everything else is a code-defined id: registry ids (`loadReport`), tool ids
// (`spaceSketch`), command ids (`vis:show`, `export:csv-entities`), error
// kinds. Lowercase words, a camelCase hump only as a capital followed by two
// or more lowercase letters, joined by `_`, `:` or `-`. No dot, slash, space,
// `$` or run of capitals, so neither a file name nor an IFC GlobalId fits.
const WORD = '[a-z][a-z0-9]*(?:[A-Z][a-z]{2,})*';
const ID_VALUE = new RegExp(`^(?=.{1,48}$)${WORD}(?:[_:-]${WORD})*$`);

const isAllowedValue = (key: string, value: unknown): boolean =>
  typeof value === 'string' && (ENUM_VALUES[key]?.has(value) ?? ID_VALUE.test(value));

// Command-palette rows whose id embeds user or third-party data after a fixed
// prefix: a recent file's name, a script template's name, an extension's id.
const DYNAMIC_COMMAND_PREFIXES = ['file:recent:', 'auto:', 'ext:'];

/**
 * The id to report for a palette command. Dynamic rows collapse to their
 * prefix; any other id that is not a plain code id (so could carry data)
 * collapses to its first segment, or to `other`.
 */
export function commandIdForAnalytics(id: string): string {
  const prefix = DYNAMIC_COMMAND_PREFIXES.find((p) => id.startsWith(p));
  if (prefix) return prefix.slice(0, -1);
  if (ID_VALUE.test(id)) return id;
  const head = id.split(':', 1)[0];
  return ID_VALUE.test(head) ? head : 'other';
}

const isUiEventName = (name: string | undefined): name is UiEventName =>
  name !== undefined && Object.prototype.hasOwnProperty.call(UI_EVENT_KEYS, name);

/**
 * `before_send` step: on a UI interaction event, drop every property that is
 * not declared for that event (SDK / super-properties aside), and every
 * declared one whose value is outside its vocabulary. Other events pass untouched.
 */
export const scrubUiEvent = <
  T extends { event?: string; properties?: Record<string, unknown> } | null,
>(event: T): T => {
  if (!event?.properties || !isUiEventName(event.event)) return event;
  const allowed: ReadonlyArray<string> = UI_EVENT_KEYS[event.event];
  const props = event.properties;
  for (const key of Object.keys(props)) {
    if (isSdkProperty(key)) continue;
    if (!allowed.includes(key) || !isAllowedValue(key, props[key])) delete props[key];
  }
  return event;
};
