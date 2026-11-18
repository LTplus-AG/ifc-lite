/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * "Take me to it" for the sections at the bottom of a model's Georeference
 * panel (Site context, Surface runoff). A command
 * opens the Properties panel on the model and arms a focus request; the
 * section it names, once mounted for that model, scrolls into view, takes a
 * brief highlight and consumes the request. Before this, the palette's
 * "Load site context" only un-collapsed a panel and left the user to find a
 * section at the very bottom of it (or a section that was not rendered).
 */

import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

export type GeorefSection = 'siteContext' | 'floodCheck' | 'addGeoref';

interface FocusRequest { modelId: string; section: GeorefSection; at: number }

/** A request nobody consumed (the panel never showed that model) must not scroll a panel opened by hand much later. */
const REQUEST_TTL_MS = 10_000;

let pending: FocusRequest | null = null;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };

/** Arm a focus request; the matching section consumes it when it is on screen. */
export function requestGeorefSectionFocus(modelId: string, section: GeorefSection): void {
  pending = { modelId, section, at: Date.now() };
  notify();
}

/** The armed request, for tests and for a section deciding whether to render its explanation. */
export function pendingGeorefSectionFocus(): FocusRequest | null {
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Attribute a focused section carries for a moment, for the highlight ring. */
export const GEOREF_FOCUS_ATTRIBUTE = 'data-georef-focus';
const HIGHLIGHT_MS = 1600;

/**
 * Scroll `ref` into view and highlight it when a request for this model and
 * section is armed. `ready` lets a section wait until it rendered its content
 * (the anchor resolves asynchronously) before it consumes the request.
 * Returns true once a request named this section, for the rest of the
 * section's life: a section that normally stays quiet (Surface runoff on a
 * model it cannot check) explains itself when the user asked for it.
 */
export function useGeorefSectionFocus(modelId: string, section: GeorefSection, ref: RefObject<HTMLElement | null>, ready = true): boolean {
  const request = useSyncExternalStore(subscribe, pendingGeorefSectionFocus, pendingGeorefSectionFocus);
  const matches = request !== null && request.modelId === modelId && request.section === section && Date.now() - request.at < REQUEST_TTL_MS;
  const [requested, setRequested] = useState(false);
  if (matches && !requested) setRequested(true);
  // The highlight outlives the request (consuming it re-renders with `matches` false), so its timer is not tied to that effect.
  const highlight = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (highlight.current) clearTimeout(highlight.current); }, []);
  useEffect(() => {
    const element = ref.current;
    if (!matches || !ready || !element) return;
    pending = null;
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    element.setAttribute(GEOREF_FOCUS_ATTRIBUTE, '');
    (element.querySelector<HTMLElement>('button:not([disabled])') ?? element).focus({ preventScroll: true });
    if (highlight.current) clearTimeout(highlight.current);
    highlight.current = setTimeout(() => { element.removeAttribute(GEOREF_FOCUS_ATTRIBUTE); highlight.current = null; }, HIGHLIGHT_MS);
    notify();
  }, [matches, ready, ref]);
  return requested || matches;
}

/** Classes for a section that can be focused: the ring shows only while the attribute is set. */
export const GEOREF_FOCUS_CLASS = 'scroll-mt-4 transition-shadow data-[georef-focus]:ring-2 data-[georef-focus]:ring-inset data-[georef-focus]:ring-primary';
