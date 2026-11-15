/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The PROJ oracle (`scripts/geo/generate-proj-oracle.py`). The fixture lives
 * with the CRS engine in `packages/geo`; the viewer's placement tests read the
 * same file through this module.
 */

import PROJ_ORACLE from '../../../../packages/geo/src/__fixtures__/proj-oracle.json' with { type: 'json' };

export default PROJ_ORACLE;
