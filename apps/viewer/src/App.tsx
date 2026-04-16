/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Main application component.
 *
 * The web viewer renders only the ViewerLayout.
 * The /settings page is desktop-only (mounted by the Tauri shell).
 */

import { ViewerLayout } from './components/viewer/ViewerLayout';
import { BimProvider } from './sdk/BimProvider';
import { Toaster } from './components/ui/toast';

export function App() {
  return (
    <BimProvider>
      <ViewerLayout />
      <Toaster />
    </BimProvider>
  );
}

export default App;
