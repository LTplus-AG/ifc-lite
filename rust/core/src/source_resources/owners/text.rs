// SPDX-License-Identifier: MPL-2.0
use super::{build_error::OwnerError, storage::{copy_bytes, Domain, Shared, SharedWeak, Stored}};

struct TextBlock<A: Domain> { bytes: Box<[u8], A> }
impl<A: Domain> Stored<A> for TextBlock<A> {
    fn compatible(&self, allocator: &A) -> bool { Box::allocator(&self.bytes).same_domain(allocator) }
}
pub(super) struct OwnedText<A: Domain>(Shared<TextBlock<A>, A>);
pub(super) struct TextWeak<A: Domain>(SharedWeak<TextBlock<A>, A>);
impl<A: Domain> OwnedText<A> {
    /// Input already is UTF-8. Grammar, escaping and lossy decoding belong to
    /// the canonical collector in unit 3, not to this owning storage layer.
    pub fn try_new(allocator: &A, text: &str) -> Result<Self, OwnerError> {
        let bytes = copy_bytes(allocator, text.as_bytes())?;
        Shared::try_new(allocator, TextBlock { bytes }).map(Self).map_err(|error| error.error)
    }
    pub fn as_str(&self) -> &str {
        // SAFETY: bytes were copied from str and cannot be mutated/extracted.
        unsafe { std::str::from_utf8_unchecked(&self.0.get().bytes) }
    }
    pub fn downgrade(&self) -> TextWeak<A> { TextWeak(self.0.downgrade()) }
}
impl<A: Domain> Clone for OwnedText<A> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}
impl<A: Domain> Clone for TextWeak<A> {
    fn clone(&self) -> Self { Self(self.0.clone()) }
}
impl<A: Domain> TextWeak<A> {
    pub fn upgrade(&self) -> Option<OwnedText<A>> { self.0.upgrade().map(OwnedText) }
}
impl<A: Domain> Stored<A> for OwnedText<A> {
    fn compatible(&self, allocator: &A) -> bool { self.0.allocator().same_domain(allocator) }
}
