/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Emit compact implementations for the public entity type, preserving its Rust layout. */
export function generateTypeTraits(names: readonly string[]): string {
  return `// The known variants have no payload. Passing their identity through a
// fieldless enum lets LLVM copy the tag without a separate return block for
// each of the thousand variants. Only the unknown keyword owns data.
macro_rules! impl_type_clone {
    ($($known:ident),* $(,)?) => {
        impl Clone for IfcType {
            fn clone(&self) -> Self {
                #[allow(clippy::enum_variant_names)] // The variants mirror the EXPRESS entity names.
                enum Known { $($known,)* }
                let known = match self {
                    $(Self::$known => Known::$known,)*
                    Self::Unknown(keyword) => return Self::Unknown(keyword.clone()),
                };
                match known {
                    $(Known::$known => Self::$known,)*
                }
            }
        }
    }
}
impl_type_clone!(
${names.map(name => '    ' + name + ',').join('\n')}
);

impl fmt::Debug for IfcType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unknown(keyword) => f.debug_tuple("Unknown").field(keyword).finish(),
            known => f.write_str(known.name()),
        }
    }
}
`;
}
