/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Minimal typing for the parts of @3dconnexion/3dconnexionjs this package uses (the SDK ships no types).
declare module '@3dconnexion/3dconnexionjs' {
  export class _3Dconnexion {
    constructor(client: object);
    session?: { close(): void } | null;
    connect(): number;
    create3dmouse(view: HTMLElement | Window, appName: string, options?: number): void;
    delete3dmouse(): void;
    update3dcontroller(value: object): void;
  }
  export default _3Dconnexion;
}
