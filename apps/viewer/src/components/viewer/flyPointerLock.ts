/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The pointer lock fly mode holds while you look around, so the cursor stops
 * at no screen edge and cannot land on another window mid-gesture.
 *
 * Kept apart from `flyControls.ts` because it is the one piece that is pure
 * browser negotiation: an option not every engine knows, a promise not every
 * engine returns, and a refusal that must stay survivable.
 */

/**
 * The pointer-lock half of an element. `requestPointerLock` takes an options
 * argument only in newer Chromium, and returns a promise only there too, so
 * the DOM lib's signature is not the one every browser actually implements.
 */
export interface LockableElement {
  requestPointerLock?: (options?: { unadjustedMovement?: boolean }) => Promise<void> | void;
  ownerDocument: Document;
}

export interface FlyPointerLock {
  /** Remember the element to lock, without locking it yet. */
  arm(element: Element | null): void;
  /**
   * Take the lock, once. Called when the press has become a gesture — never
   * on the press itself: while the pointer is locked the browser fires no
   * `contextmenu` at all, so locking eagerly killed the right-click menu.
   */
  request(): void;
  /** True while this element actually holds the lock. */
  isLocked(): boolean;
  /** Release the lock and forget the element. */
  release(): void;
}

const warn = (error: unknown): void => {
  console.warn('[flyPointerLock] Pointer lock refused; looking with cursor deltas:', error);
};

/**
 * @param onLost called when a lock this session asked for goes away while the
 * session is still armed — Esc, or the browser revoking it. `release()` never
 * reports its own exit.
 */
export function createFlyPointerLock(onLost?: () => void): FlyPointerLock {
  let target: LockableElement | null = null;
  let requested = false;
  let heldLock = false;
  let listening: Document | null = null;

  const onLockChange = (): void => {
    const el = target;
    if (!el) return;
    if (el.ownerDocument.pointerLockElement === el) {
      // Only a lock this session asked for is its own; a stale grant is given back.
      if (requested) heldLock = true;
    } else if (heldLock) {
      heldLock = false;
      onLost?.();
    }
  };
  const unlisten = (): void => {
    listening?.removeEventListener('pointerlockchange', onLockChange);
    listening = null;
  };
  /**
   * Bumped by every `arm()` and `release()`. A request settles asynchronously
   * and a quick gesture can end first, so each continuation checks that its
   * session is still the live one before retrying, and gives back a lock the
   * browser granted to a session that no longer exists (#4868 review).
   */
  let session = 0;

  /**
   * A grant for a dead session: exit it, unless a live session on the same
   * element has requested the lock itself. A newer press that has not asked
   * yet is still a click, and a held lock would make the browser withhold its
   * `contextmenu` (#4868 review).
   */
  const settleStale = (el: LockableElement): void => {
    if ((target !== el || !requested) && el.ownerDocument.pointerLockElement === el) el.ownerDocument.exitPointerLock();
  };

  return {
    arm(element) {
      session++;
      unlisten();
      target = element ? (element as unknown as LockableElement) : null;
      requested = false;
      heldLock = false;
      const doc = target?.ownerDocument;
      if (onLost && typeof doc?.addEventListener === 'function') {
        doc.addEventListener('pointerlockchange', onLockChange);
        listening = doc;
      }
    },

    request() {
      const el = target;
      if (!el || requested || typeof el.requestPointerLock !== 'function') return;
      requested = true;
      if (el.ownerDocument.pointerLockElement === el) return;
      const token = session;
      const onGranted = (): void => {
        if (token !== session) settleStale(el);
      };
      try {
        // `unadjustedMovement` asks for raw device deltas, i.e. without the OS
        // mouse acceleration curve, so a slow sweep and a fast one turn the
        // same amount per centimetre of desk. Engines that do not know the
        // option reject the promise, so retry plainly; engines that do not
        // return a promise have nothing to retry.
        void Promise.resolve(el.requestPointerLock({ unadjustedMovement: true })).then(onGranted, () => {
          if (token !== session) return; // the gesture is over; do not start a new request
          try {
            void Promise.resolve(el.requestPointerLock?.()).then(onGranted, warn);
          } catch (error) {
            warn(error);
          }
        });
      } catch (error) {
        warn(error);
      }
    },

    isLocked: () => target !== null && target.ownerDocument.pointerLockElement === target,

    release() {
      session++;
      unlisten();
      const doc = target?.ownerDocument;
      target = null;
      requested = false;
      heldLock = false;
      if (doc?.pointerLockElement) doc.exitPointerLock();
    },
  };
}
