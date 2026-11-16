/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/** The package declares ESM through `module` but points Node's `main` at a UMD
 * build under type:module. Import its actual ESM entry for both native hosts. */
declare module 'svg2pdf.js/dist/svg2pdf.es.min.js' {
  export { svg2pdf } from 'svg2pdf.js';
}
