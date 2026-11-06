/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import * as React from 'react';

/**
 * The invisible file input behind an "Open…" or "Load…" button. Open it with
 * `ref.current.click()` directly in that button's click handler, before any
 * await: Safari only opens a file picker during the click's user activation
 * and silently ignores a deferred `click()` (#8802).
 */
const HiddenFileInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'className'>>(
  (props, ref) => <input ref={ref} type="file" className="hidden" {...props} />,
);
HiddenFileInput.displayName = 'HiddenFileInput';

export { HiddenFileInput };
