/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState, type RefObject } from 'react';
import { useViewerStore } from '@/store';

/** Initialise only a visible minimap; old browsers fall back to load settlement. */
export function useLocationMapReady(container: RefObject<HTMLDivElement | null>, hasLocation: boolean): boolean {
  const loading = useViewerStore((s) => s.loading);
  const [visible, setVisible] = useState(false);
  const observesVisibility = typeof IntersectionObserver === 'function';
  const eligible = !observesVisibility && !loading && hasLocation;
  const [settledOnce, setSettledOnce] = useState(eligible);
  useEffect(() => { if (eligible) setSettledOnce(true); }, [eligible]);
  useEffect(() => {
    const element = container.current;
    if (!element || !hasLocation || settledOnce || visible || !observesVisibility) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { threshold: 0.01 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, hasLocation, settledOnce, visible, observesVisibility]);
  // Later primary/federated loads must not re-enter the init effect and flyTo.
  return settledOnce || eligible || visible;
}
