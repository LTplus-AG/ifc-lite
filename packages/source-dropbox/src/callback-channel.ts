/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How the OAuth popup hands its result back to the page that opened it.
 *
 * The obvious mechanism (open the popup, poll `popup.closed` and
 * `popup.location.href` until the redirect lands on this app's own origin)
 * does not work in this app, and fails in the most misleading way possible.
 * The viewer serves `Cross-Origin-Opener-Policy: same-origin` (it needs
 * `crossOriginIsolated` for `SharedArrayBuffer`). Under that header, opening
 * a CROSS-ORIGIN popup severs the opener/openee relationship: the
 * `WindowProxy` `window.open` returns is a disconnected stub of a window this
 * page is no longer allowed to observe. Probed live against the running
 * viewer with the authorization host:
 *
 *   window.crossOriginIsolated              -> true
 *   w = window.open('https://www.dropbox.com/')
 *   w.closed          (1.5s later)          -> true, while the window is
 *                                              visibly open on screen
 *   w.location.href                         -> throws SecurityError
 *
 * So `popup.closed` reports a lie, and the poll loop rejects with "sign-in
 * was cancelled (the popup was closed)" on its very first tick while the user
 * is still looking at Dropbox's consent screen. A same-origin control popup
 * behaves normally (`closed === false`, `location.href` readable), which is
 * what makes this specific to the cross-origin authorization step.
 *
 * What still works is that the REDIRECT lands back on this app's own origin.
 * The callback page is therefore same-origin with its opener and can hand the
 * result back over a `BroadcastChannel`, which is scoped by origin and does
 * not care about the opener link that COOP cut. The opener listens on that
 * channel instead of touching the popup at all.
 *
 * Consequences worth knowing before changing any of this:
 *
 *  - **Cancellation is not detectable.** `popup.closed` is the only signal a
 *    browser gives for "the user closed the window", and it is exactly the
 *    thing COOP made unusable here. A user who closes the popup therefore
 *    waits out the timeout instead of getting an immediate "cancelled".
 *    That is a deliberate trade, not an oversight: there is no correct
 *    substitute signal, and inventing one (a heartbeat from the popup, an
 *    unload beacon) buys a nicer error message for a real cost in moving
 *    parts.
 *  - **`popup.close()` from the opener is also inert** on a severed popup.
 *    The callback page closes itself.
 */

/**
 * Name of the `BroadcastChannel`, and the `type` tag every message on it
 * carries.
 *
 * MUST stay byte-identical to the literal in the callback page that posts the
 * message: `apps/viewer/public/oauth/dropbox/callback.html`. That page is a
 * static, unbundled HTML file (deliberately: see its own comment), so it
 * cannot import this constant. The two are kept in lockstep by hand.
 */
export const OAUTH_CALLBACK_CHANNEL = 'ifc-lite:oauth-callback';

/** What the callback page posts. `url` is the full redirect URL, query string
 *  included, for the opener to hand to `parseAuthorizationCallback`. */
export interface OAuthCallbackMessage {
  readonly type: typeof OAUTH_CALLBACK_CHANNEL;
  readonly state: string;
  readonly url: string;
}

export interface WaitForOAuthCallbackOptions {
  /** The `state` this sign-in attempt generated. Messages carrying any other
   *  `state` are ignored rather than consumed, which is what keeps two
   *  concurrent sign-ins (two providers, or two tabs) from completing each
   *  other's flow. Every listener sees every message on this shared channel. */
  readonly expectedState: string;
  readonly timeoutMs: number;
  /** Message for the timeout rejection, so each provider can phrase its own. */
  readonly timeoutMessage: string;
}

/**
 * Resolves with the full callback URL the popup was redirected to, once the
 * callback page broadcasts it. Rejects after `timeoutMs`.
 *
 * Attach this BEFORE the redirect can possibly happen (i.e. immediately after
 * opening the popup, with no `await` in between): `BroadcastChannel` does not
 * buffer, so a message posted before this subscribes is simply lost.
 *
 * `state` is validated here only to route the message to the right waiter.
 * The authoritative CSRF check is still `parseAuthorizationCallback`, which
 * the caller runs on the returned URL.
 */
export function waitForOAuthCallback(options: WaitForOAuthCallbackOptions): Promise<string> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.reject(
      new Error('OAuth sign-in requires BroadcastChannel, which this environment does not provide'),
    );
  }

  return new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel(OAUTH_CALLBACK_CHANNEL);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const teardown = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      channel.close();
    };

    timer = setTimeout(() => {
      teardown();
      reject(new Error(options.timeoutMessage));
    }, options.timeoutMs);

    channel.onmessage = (event: MessageEvent): void => {
      const data = event.data as Partial<OAuthCallbackMessage> | null | undefined;
      if (!data || data.type !== OAUTH_CALLBACK_CHANNEL) return;
      if (typeof data.url !== 'string') return;
      if (data.state !== options.expectedState) return; // Someone else's sign-in.
      teardown();
      resolve(data.url);
    };
  });
}
