/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Whether an unpaired socket's first frame may pair (#9523): it must be a
 * valid hello in this protocol version, a code must be live, and the code
 * must match. Every comparison waits out the `PairingGate` backoff after
 * recent wrong codes, and a waiting attempt keeps its slot even if its peer
 * leaves. What a paired session becomes is the caller's business (`admit`).
 */

import type { WebSocket } from 'ws';
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeCloseCode,
  BridgeErrorCode,
  parseTabMessage,
  type BridgeHelloMessage,
} from './bridge-protocol.js';
import { PairingCodes } from './pairing.js';
import { PairingGate } from './rate-limits.js';
import { clip } from './sanitize.js';
import type { Slot } from './tab-bridge-options.js';

export interface AdmissionHost {
  /** Coalesced log line of one kind. */
  note(kind: string, line: string): void;
  /** Send an error, close, and stop processing the socket. */
  kill(ws: WebSocket, code: BridgeErrorCode, message: string, closeCode: number): void;
  /** Run `fn` from a timer; a throw fails the socket instead of escaping. */
  guard(ws: WebSocket, what: string, fn: () => void): void;
  /** The slot no longer counts against the unpaired cap. */
  release(slot: Slot): void;
  /** The hello passed: make it the paired session. */
  admit(ws: WebSocket, slot: Slot, hello: BridgeHelloMessage): void;
}

export class PairingAdmission {
  readonly codes = new PairingCodes();
  private readonly gate: PairingGate;
  /** Code comparisons made, including attempts whose peer left before theirs. */
  attempts = 0;
  /** Wrong codes plus attempts abandoned before their comparison. */
  failedAttempts = 0;

  constructor(private readonly host: AdmissionHost, backoffBaseMs?: number, backoffMaxMs?: number) {
    this.gate = new PairingGate(backoffBaseMs, backoffMaxMs);
  }

  /** Current deferral of every comparison (0 with no recent failure). */
  delay(): number {
    return this.gate.delay();
  }

  /** Handle the first frame of an unpaired socket. */
  hello(ws: WebSocket, slot: Slot, text: string): void {
    const reject = (code: BridgeErrorCode, message: string, closeCode: number): void => this.host.kill(ws, code, message, closeCode);
    const parsed = parseTabMessage(text);
    if (!parsed.ok || parsed.value.type !== 'hello') {
      const why = parsed.ok ? `expected hello, got ${parsed.value.type}` : parsed.error;
      return reject(BridgeErrorCode.INVALID_MESSAGE, clip(`First message must be a valid hello: ${why}`, 300), BridgeCloseCode.INVALID_MESSAGE);
    }
    const hello = parsed.value;
    // Checked before the code, so a stale tab does not burn the user's code.
    if (hello.protocol !== BRIDGE_PROTOCOL_VERSION) {
      return reject(
        BridgeErrorCode.PROTOCOL_VERSION_MISMATCH,
        `This bridge speaks protocol ${BRIDGE_PROTOCOL_VERSION}; the tab sent ${clip(hello.protocol, 20)}. Update @ifc-lite/mcp or reload the viewer.`,
        BridgeCloseCode.PROTOCOL_VERSION_MISMATCH,
      );
    }
    if (!this.codes.live()) {
      // Nothing to guess while paired, so this neither waits nor feeds the gate.
      this.host.note('pairing attempts while paired', 'refused a pairing attempt: a tab is already paired and no code is live');
      return reject(
        BridgeErrorCode.PAIRING_FAILED,
        'No pairing code is live (a tab is already paired). Ask the agent to call bridge_status with pair_new_tab for a fresh link.',
        BridgeCloseCode.PAIRING_FAILED,
      );
    }
    const delay = this.gate.delay();
    if (delay === 0) return this.compare(ws, slot, hello);
    // During an attack every comparison waits; the slot stays taken even if the peer leaves.
    slot.held = true;
    const later = setTimeout(() => this.host.guard(ws, 'pairing attempt', () => {
      slot.held = false;
      this.compare(ws, slot, hello);
    }), delay);
    later.unref?.();
  }

  private compare(ws: WebSocket, slot: Slot, hello: BridgeHelloMessage): void {
    this.attempts++;
    if (ws.readyState !== ws.OPEN) {
      // Left before its comparison: counts as a failed guess, and frees the slot only now.
      this.failed();
      this.host.release(slot);
      return;
    }
    // Paired by another tab while this one waited out the backoff: no code was
    // guessed wrong, so the gate is not fed.
    if (!this.codes.live()) {
      this.host.release(slot);
      this.host.kill(ws, BridgeErrorCode.PAIRING_FAILED, 'No pairing code is live (a tab is already paired). Ask the agent to call bridge_status with pair_new_tab for a fresh link.', BridgeCloseCode.PAIRING_FAILED);
      return;
    }
    if (this.codes.consume(hello.pairingCode) !== 'ok') {
      this.failed();
      this.host.note('wrong pairing codes', 'refused a wrong pairing code');
      this.host.kill(ws, BridgeErrorCode.PAIRING_FAILED, 'Pairing code not accepted. Use the latest link or code from bridge_status.', BridgeCloseCode.PAIRING_FAILED);
      return;
    }
    this.gate.succeed();
    this.host.admit(ws, slot, hello);
  }

  private failed(): void {
    this.gate.fail();
    this.failedAttempts++;
  }
}
