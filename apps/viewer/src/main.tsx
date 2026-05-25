/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Application entry point
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';
import 'maplibre-gl/dist/maplibre-gl.css';
// Wire the placement-edit helpers' parser-backed source reader. Pure
// side-effect import; keeps `@ifc-lite/parser` out of placement-edit
// itself so its overlay-path logic stays unit-testable.
import './lib/placement-edit.boot';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
