/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
const fs=await import('node:fs');
fs.writeFileSync(process.env.REOPEN_OUT,JSON.stringify(bim.store.listStoreyLevels(bim.model.activeId())));
