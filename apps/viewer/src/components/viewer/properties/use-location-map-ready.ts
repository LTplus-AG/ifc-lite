/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useState, type RefObject } from 'react';
import { useViewerStore } from '@/store';

/** Hidden property panels must not create a WebGL context during model load. */
export function useLocationMapReady(container: RefObject<HTMLDivElement | null>, hasLocation: boolean): boolean {
  const loading = useViewerStore((s) => s.loading);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element || !hasLocation || !loading || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio > 0)) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [container, hasLocation, loading]);
  return !loading || visible;
}
