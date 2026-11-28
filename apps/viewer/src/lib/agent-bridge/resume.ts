/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

const STORAGE_KEY = 'ifc-lite.bridge.resume';
export interface ResumeTicket { port: number; key: string; pendingNonce?: string }

export function savedTicket(): ResumeTicket | undefined {
  try {
    const text = window.sessionStorage.getItem(STORAGE_KEY);
    if (!text) return;
    const ticket = JSON.parse(text);
    if (Number.isInteger(ticket?.port) && ticket.port > 0 && ticket.port <= 65535
        && typeof ticket.key === 'string' && /^[0-9a-f]{64}$/.test(ticket.key)) return {
      port: ticket.port, key: ticket.key,
      ...(typeof ticket.pendingNonce === 'string' && /^[0-9a-f]{32}$/.test(ticket.pendingNonce) ? { pendingNonce: ticket.pendingNonce } : {}),
    };
  } catch (err) {
    console.debug('[agent-bridge] could not read saved pairing', err);
  }
}

export function saveTicket(ticket?: ResumeTicket): void {
  if (typeof window === 'undefined') return;
  try {
    if (ticket) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ticket));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.debug('[agent-bridge] could not update saved pairing', err);
  }
}

export async function handshakeProofs(secret: string, pendingNonce?: string) {
  const hex = (bytes: Uint8Array) => Array.from(bytes, (n) => n.toString(16).padStart(2, '0')).join('');
  const nonce = (pendingNonce ?? '') + hex(crypto.getRandomValues(new Uint8Array(16)));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = async (role: string) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode('ifc-lite/' + role + '/' + (role === 'next' ? nonce.slice(0, 32) : nonce)))));
  const [tab, bridge, next] = await Promise.all(['tab', 'bridge', 'next'].map(mac));
  return { nonce, tab, bridge, next };
}
