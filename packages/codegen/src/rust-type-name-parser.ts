/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ExpressSchema } from './express-parser.js';

/** One exact-name match shared by canonical and normalized input. */
export function generateTypeNameParser(schema: ExpressSchema): string {
  return `    /// Parse IFC type from string (case-insensitive)
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        // #3987: recognized STEP names need no normalization scan.
        if let Some(known) = Self::from_canonical_name(s) {
            return known;
        }
        if s.bytes().all(|b| b.is_ascii() && !b.is_ascii_lowercase()) {
            return Self::Unknown(crc32_hash(s));
        }
        // Keep Unicode uppercase expansion and the exact unknown-type CRC.
        let upper = s.to_uppercase();
        Self::from_canonical_name(&upper)
            .unwrap_or_else(|| Self::Unknown(crc32_hash(&upper)))
    }

    fn from_canonical_name(s: &str) -> Option<Self> {
        Some(match s {
${schema.entities.map(entity =>
    `            "${entity.name.toUpperCase()}" => Self::${entity.name},`).join('\n')}
            _ => return None,
        })
    }
`;
}
