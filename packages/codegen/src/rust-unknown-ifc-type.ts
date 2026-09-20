/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Render the generated owned representation for unsupported IFC keywords. */
export function generateUnknownIfcType(visibility: 'pub' | 'pub(crate)'): string {
  return `/// A normalized IFC keyword not declared by the supported schema universe.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
${visibility} struct UnknownIfcType {
    name: String,
    id: u32,
}

impl UnknownIfcType {
    fn new(name: String) -> Self {
        let id = crc32_hash(&name);
        Self { name, id }
    }

    /// Normalized uppercase STEP keyword.
    ${visibility} fn as_str(&self) -> &str {
        &self.name
    }

    /// CRC32 identifier of the normalized keyword.
    ${visibility} fn id(&self) -> u32 {
        self.id
    }
}

`;
}
