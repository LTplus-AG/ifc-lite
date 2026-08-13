/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Give happy-dom a viewport, for components that measure before they render
 * (#2434).
 *
 * happy-dom implements the DOM but not layout: every `getBoundingClientRect()`
 * returns zeros and every `clientHeight` is 0. That is invisible for most
 * components and fatal for one specific family — `@tanstack/react-virtual`
 * asks the scroll container how tall it is, is told 0, and renders ZERO rows.
 * A result list mounted without this stub produces
 * `<div style="height: 28px; position: relative;"></div>` and nothing to click,
 * which reads as "this component cannot be tested" rather than "the harness is
 * missing a viewport".
 *
 * Deliberately NOT folded into `setup-dom.ts`: that module is imported by 35
 * test files, and silently giving all of them a fake viewport would change what
 * they exercise. Opt in from the files that virtualize.
 *
 * The numbers are a plain desktop viewport. Nothing should depend on the exact
 * values — if an assertion needs a specific height, it should set that height
 * itself and say why.
 */

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

let installed = false;

/**
 * Make every element report a non-zero box. Idempotent, and returns a function
 * that restores the original descriptors.
 */
export function installLayout(): () => void {
  if (installed) return () => {};
  installed = true;

  /**
   * happy-dom spreads these across the chain — `getBoundingClientRect` sits on
   * `Element.prototype` but `clientHeight`/`clientWidth` on
   * `HTMLElement.prototype`. Defining all three on `Element` leaves the
   * `HTMLElement` pair shadowing the stub, so every element still reports
   * `clientHeight === 0`. Patch whichever prototype actually owns each one.
   */
  function ownerOf(name: string): Record<string, unknown> {
    let proto: object | null = window.HTMLElement.prototype;
    while (proto) {
      if (Object.getOwnPropertyDescriptor(proto, name)) return proto as Record<string, unknown>;
      proto = Object.getPrototypeOf(proto);
    }
    return window.Element.prototype as unknown as Record<string, unknown>;
  }

  const rectProto = ownerOf('getBoundingClientRect');
  const sizeProto = ownerOf('clientHeight');
  const restore: Array<() => void> = [];
  for (const [proto, name] of [
    [rectProto, 'getBoundingClientRect'],
    [sizeProto, 'clientHeight'],
    [sizeProto, 'clientWidth'],
  ] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, name);
    restore.push(() => {
      if (descriptor) Object.defineProperty(proto, name, descriptor);
      else delete proto[name];
    });
  }

  const proto = rectProto;
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    value(this: Element) {
      // An element that has set its own inline height should be believed —
      // virtualizers size their spacer from it, and a flat 800 there would
      // make the row count meaningless.
      const inline = Number.parseFloat((this as HTMLElement).style?.height ?? '');
      const height = Number.isFinite(inline) && inline > 0 ? inline : VIEWPORT_HEIGHT;
      return {
        x: 0, y: 0, top: 0, left: 0,
        width: VIEWPORT_WIDTH, height,
        right: VIEWPORT_WIDTH, bottom: height,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
  // Same inline-height rule as the rect stub above: an element that declares
  // its own height must report it through BOTH channels, or a component that
  // measures via clientHeight sees 800 where getBoundingClientRect says 28.
  Object.defineProperty(sizeProto, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const inline = Number.parseFloat(this.style?.height ?? '');
      return Number.isFinite(inline) && inline > 0 ? inline : VIEWPORT_HEIGHT;
    },
  });
  Object.defineProperty(sizeProto, 'clientWidth', { configurable: true, get: () => VIEWPORT_WIDTH });

  // happy-dom HAS a ResizeObserver, but it never delivers an entry — nothing
  // resizes when there is no layout. A measure-then-render component therefore
  // mounts, asks how big its scroll container is, and is never told:
  // `@tanstack/react-virtual` sizes its spacer correctly (`height: 56px` for
  // two 28px rows) and then renders NO rows, because its visible range is
  // derived from a viewport it never received. Delivering one entry on
  // `observe()` is what turns that back into a real list.
  const RealResizeObserver = window.ResizeObserver;
  class ImmediateResizeObserver implements ResizeObserver {
    #callback: ResizeObserverCallback;
    #inner: ResizeObserver;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
      this.#inner = new RealResizeObserver(callback);
    }
    observe(target: Element, options?: ResizeObserverOptions): void {
      this.#inner.observe(target, options);
      const rect = target.getBoundingClientRect();
      const entry = {
        target,
        contentRect: rect,
        borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        contentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
        devicePixelContentBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
      } as unknown as ResizeObserverEntry;
      this.#callback([entry], this);
    }
    unobserve(target: Element): void { this.#inner.unobserve(target); }
    disconnect(): void { this.#inner.disconnect(); }
  }
  const originalRO = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
  Object.defineProperty(window, 'ResizeObserver', { configurable: true, writable: true, value: ImmediateResizeObserver });
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: ImmediateResizeObserver });

  return () => {
    installed = false;
    for (const undo of restore) undo();
    if (originalRO) {
      Object.defineProperty(window, 'ResizeObserver', originalRO);
      Object.defineProperty(globalThis, 'ResizeObserver', originalRO);
    }
  };
}
