/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The viewer's form-factor classifier (#9718): one pure function from the
 * window's shape to the layout the shell uses. It replaced a single
 * `innerWidth` test that gave a 21:9 flip phone, its 360x400 cover screen, a
 * phone in landscape and a book-sized foldable the same phone chrome.
 *
 * No device names, only shape: width, height, whether the primary pointer is
 * coarse (a finger), and the Viewport Segments API's segments (a fold or
 * hinge). The thresholds, in the order they are tested:
 *
 * | mode            | rule                                               | e.g.                                      |
 * |-----------------|----------------------------------------------------|-------------------------------------------|
 * | desktop         | width >= 1024, or a fine pointer and width >= 768  | laptops, iPad landscape                   |
 * | folded          | two viewport segments                              | Flip in Flex Mode, a half-open Fold       |
 * | cover           | coarse, longer side < 520                          | Flip FlexWindow ~360x400                  |
 * | phone-landscape | coarse, wider than tall, height < 500              | any phone on its side                     |
 * | tablet-touch    | coarse, shorter side >= 600, width < 1024          | iPhone Duo inner ~626x890, Fold ~830x750  |
 * | phone-portrait  | everything else                                    | Flip 412x960, iPhone 402x874, narrow window |
 *
 * `desktop` keeps exactly the old rule's complement (`width < 768`, or touch
 * and `width < 1024`, was mobile), so `isMobile === (mode !== 'desktop')`
 * and no existing `isMobile` reader changes behaviour. A non-touch window
 * under 768px stays the phone layout, as before.
 */

/** A viewport segment, in CSS pixels (a `DOMRectReadOnly` satisfies it). */
export interface SegmentRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type FormFactorMode = 'desktop' | 'phone-portrait' | 'phone-landscape' | 'cover' | 'tablet-touch' | 'folded';

/** Where the primary commands live: the desktop ribbon, a bar under the viewport, or a rail beside it. */
export type CommandPlacement = 'top-ribbon' | 'bottom-bar' | 'side-rail';

/** The mobile placements, the ones `MobileToolbar` renders. */
export type MobileCommandPlacement = Exclude<CommandPlacement, 'top-ribbon'>;

export interface FormFactor {
  readonly mode: FormFactorMode;
  readonly commandPlacement: CommandPlacement;
  /**
   * The command bar moves its second group (Home, Fit) into More: a cover
   * screen narrower than 360px cannot spare the row's width once its own
   * rounded-corner insets are padded out.
   */
  readonly compactCommands: boolean;
  /**
   * The fold, when the window spans two segments. `tabletop` is a horizontal
   * hinge (segments stacked top and bottom), `book` a vertical one.
   */
  readonly fold?: {
    readonly orientation: 'tabletop' | 'book';
    readonly segments: readonly [SegmentRect, SegmentRect];
  };
}

export interface FormFactorInput {
  readonly width: number;
  readonly height: number;
  /** The primary pointer is coarse (`(pointer: coarse)`), i.e. a finger. */
  readonly coarsePointer: boolean;
  /** `window.viewport.segments`; null or one segment when the window spans no fold. */
  readonly segments?: readonly SegmentRect[] | null;
}

/** Below this width every window is the phone layout; at and above it a fine pointer gets the desktop. */
const NARROW_WIDTH = 768;
/** At and above this width every window is the desktop layout. */
const DESKTOP_WIDTH = 1024;
/** A coarse-pointer screen whose longer side is under this is a cover screen. */
const COVER_LONG_SIDE = 520;
/** A coarse-pointer landscape window under this height is a phone on its side. */
const LANDSCAPE_MAX_HEIGHT = 500;
/** A coarse-pointer screen whose shorter side reaches this is a near-tablet. */
const TABLET_SHORT_SIDE = 600;
/** Under this width a cover screen moves the bar's second group into More. */
const COVER_COMPACT_WIDTH = 360;

export const DESKTOP_FORM_FACTOR: FormFactor = { mode: 'desktop', commandPlacement: 'top-ribbon', compactCommands: false };

const PLACEMENT: Record<FormFactorMode, CommandPlacement> = {
  desktop: 'top-ribbon',
  'phone-portrait': 'bottom-bar',
  'phone-landscape': 'side-rail',
  cover: 'bottom-bar',
  'tablet-touch': 'bottom-bar',
  folded: 'bottom-bar',
};

function foldOf(segments: FormFactorInput['segments']): FormFactor['fold'] {
  if (!segments || segments.length !== 2) return undefined;
  const [a, b] = segments;
  // Stacked segments differ in y; side-by-side ones in x.
  const orientation = Math.abs(a.y - b.y) > Math.abs(a.x - b.x) ? 'tabletop' : 'book';
  return { orientation, segments: [a, b] };
}

export function classifyFormFactor({ width, height, coarsePointer, segments }: FormFactorInput): FormFactor {
  const make = (mode: FormFactorMode, fold?: FormFactor['fold']): FormFactor => ({
    mode,
    commandPlacement: PLACEMENT[mode],
    compactCommands: mode === 'cover' && width < COVER_COMPACT_WIDTH,
    ...(fold ? { fold } : {}),
  });

  if (width >= DESKTOP_WIDTH || (!coarsePointer && width >= NARROW_WIDTH)) return DESKTOP_FORM_FACTOR;
  const fold = foldOf(segments);
  if (fold) return make('folded', fold);
  if (coarsePointer) {
    if (Math.max(width, height) < COVER_LONG_SIDE) return make('cover');
    if (width > height && height < LANDSCAPE_MAX_HEIGHT) return make('phone-landscape');
    if (Math.min(width, height) >= TABLET_SHORT_SIDE) return make('tablet-touch');
  }
  return make('phone-portrait');
}

/** The mobile command placement of a form factor; the desktop has none, and a store seeded with `isMobile` alone gets the bar. */
export function mobileCommandPlacement(formFactor: FormFactor): MobileCommandPlacement {
  return formFactor.commandPlacement === 'side-rail' ? 'side-rail' : 'bottom-bar';
}

/**
 * Where an open panel lives on a mobile form factor (#9718), the one decision
 * every mobile panel host (Hierarchy, the single-panel sheet, the Panels list)
 * reads:
 * - `sheet`: a modal bottom sheet over the model, for a portrait phone and the
 *   cover screen, whose width a side pane would take from the model.
 * - `side-pane`: a non-modal pane docked beside the viewport, for a phone on its
 *   side (a bottom sheet would cover most of a 412px-tall view) and a near-tablet.
 *   The model stays visible and interactive next to it.
 * - `segment`: the window spans a fold; the viewport fills one segment and the
 *   panel, non-modal, shares the other with the commands.
 * The desktop has no mobile host; it reads `sheet`, the shell's default.
 */
export type MobilePanelHostKind = 'sheet' | 'side-pane' | 'segment';

export function mobilePanelHost(formFactor: FormFactor): MobilePanelHostKind {
  switch (formFactor.mode) {
    case 'phone-landscape':
    case 'tablet-touch':
      return 'side-pane';
    case 'folded':
      return formFactor.fold ? 'segment' : 'sheet';
    default:
      return 'sheet';
  }
}
