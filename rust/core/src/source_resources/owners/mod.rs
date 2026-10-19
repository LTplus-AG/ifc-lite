// SPDX-License-Identifier: MPL-2.0
//! Unit 2 replacement owners; nonshipping until canonical grammar/callers migrate.
//! Only a cfg(test) parent declaration compiles this implementation. Standard
//! containers own every tracked backing block. Existing Raw APIs are unchanged.
mod build_error;
mod storage;
mod buffer;
mod text;
mod attribute;
mod views;
mod shared_entity;
mod cache;
#[cfg(test)]
mod attribute_tests;
#[cfg(test)]
mod lifetime_tests;
#[cfg(test)]
mod buffer_cache_tests;
