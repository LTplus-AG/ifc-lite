/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * THE ONE PLACE THE REVIEW LANE TALKS TO TYPESAFE.
 *
 * TypeSafe's System One endpoint answers typed questions (a `noul` is a yes/no
 * with a calibrated probability; a `choice` picks one option and returns the
 * distribution) over a JSON `state`. It does not generate text and has no
 * tools, so the untrusted review text placed in `state` can only bend a
 * probability, never an action. One request, ~300 ms, ~2k tokens.
 *
 * FAIL SOFT BY CONSTRUCTION. `available(env)` is the only gate: no key, no
 * call, and every caller keeps its previous behaviour (the stem matcher, the
 * unjudged findings). A caller that needs the network to be up in order to
 * post anything would turn an outage into silence, which this repository has
 * a name for. `fetchImpl` is injectable so the tests never touch the network.
 */

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = 'jev-latest';

export const noul = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });

export function available(env = process.env) {
  return typeof env.TYPESAFE_API_KEY === 'string' && env.TYPESAFE_API_KEY.trim().length > 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @returns {Promise<{ answers: Record<string, any>, model: string, usage: { input_tokens: number, output_tokens: number } }>}
 */
export async function systemOne({ state, questions, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 30_000, retries = 2 }) {
  if (!available(env)) throw new Error('TYPESAFE_API_KEY is not set');
  const body = JSON.stringify({ state, model: env.TYPESAFE_MODEL || MODEL, questions });
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchImpl(env.TYPESAFE_BASE_URL || ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY.trim()}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      // 429 and 529 are documented as "back off and retry"; so is any 5xx.
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`TypeSafe HTTP ${res.status}: ${text.slice(0, 200)}`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${text.slice(0, 300)}`);
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed.answers !== 'object') throw new Error('TypeSafe response had no `answers`');
      return parsed;
    } catch (err) {
      lastErr = err;
      if (/HTTP 4\d\d/.test(String(err?.message))) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
  throw lastErr;
}
