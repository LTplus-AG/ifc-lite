/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Owns the one `SceneProjector` instance for the mounted scene overlay
 * (#5486). Wires it to the live renderer via `RendererProjectorSource`, and
 * wakes it on pointer/wheel interaction with the viewport canvas — the
 * channel that lets an idle projector notice the camera started moving
 * again (see `projector.ts`'s docblock for why that can't come from inside
 * the loop itself).
 */

import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react';
import { SceneProjector } from './projector';
import { RendererProjectorSource } from './renderer-source';

/** Exported for tests that need to drive a `SceneProjector` directly (a fake source, no real renderer). Production code should use `useSceneProjector`. */
export const SceneProjectorContext = createContext<SceneProjector | null>(null);

/** Pointer/wheel event types that can mean "the camera might start moving". */
const WAKE_EVENTS = ['pointerdown', 'pointermove', 'wheel', 'pointerup'] as const;

export interface SceneProjectorProviderProps {
  /**
   * The overlay root's own container element, used only to scope
   * `closest('[data-viewport]')` — matters once more than one viewport can
   * be mounted (split view). Owned by `SceneOverlayRoot`.
   */
  containerRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}

export function SceneProjectorProvider({ containerRef, children }: SceneProjectorProviderProps): ReactNode {
  const cleanupListenersRef = useRef<(() => void) | null>(null);

  const projector = useMemo(() => {
    const source = new RendererProjectorSource(containerRef, (canvas) => attachWakeListeners(canvas));
    return new SceneProjector(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function attachWakeListeners(canvas: HTMLCanvasElement) {
    cleanupListenersRef.current?.();
    const wake = () => projector.wake();
    for (const type of WAKE_EVENTS) canvas.addEventListener(type, wake, { passive: true });
    const resizeObserver = new ResizeObserver(wake);
    resizeObserver.observe(canvas);
    cleanupListenersRef.current = () => {
      for (const type of WAKE_EVENTS) canvas.removeEventListener(type, wake);
      resizeObserver.disconnect();
    };
  }

  useEffect(() => {
    return () => {
      cleanupListenersRef.current?.();
      cleanupListenersRef.current = null;
      projector.stop();
    };
  }, [projector]);

  return <SceneProjectorContext.Provider value={projector}>{children}</SceneProjectorContext.Provider>;
}

/** The active `SceneProjector`, or `null` outside a `SceneProjectorProvider` (e.g. in an isolated primitive test). */
export function useSceneProjector(): SceneProjector | null {
  return useContext(SceneProjectorContext);
}
