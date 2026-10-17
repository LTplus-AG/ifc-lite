// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use thiserror::Error;

/// Result type for IFC-Lite core operations
pub type Result<T> = std::result::Result<T, Error>;

/// Errors that can occur during IFC parsing
#[derive(Error, Debug)]
pub enum Error {
    #[error("Parse error at position {position}: {message}")]
    ParseError { position: usize, message: String },

    #[error("Invalid entity reference: #{0}")]
    InvalidEntityRef(u32),

    #[error("Invalid IFC type: {0}")]
    InvalidIfcType(String),

    #[error("Unexpected token at position {position}: expected {expected}, got {got}")]
    UnexpectedToken {
        position: usize,
        expected: String,
        got: String,
    },

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("UTF-8 error: {0}")]
    Utf8(#[from] std::str::Utf8Error),

    /// The record holds a `REAL` literal the double range cannot represent
    /// (`1.E400`), refused by input admission (#7678). A lossless decode
    /// reads the same record for the data model.
    #[error("Entity #{0} holds a REAL outside the double range; refused by input admission")]
    UnrepresentableReal(u32),

    /// A point or direction record that is not an `IfcCartesianPoint` /
    /// `IfcDirection` holding 2 or 3 finite numbers, or an optional reference
    /// slot holding anything but `$`, `*` or `#n`, refused as geometry input
    /// (F3b, D3). Counted with the unrepresentable reals in
    /// `EntityDecoder::refused_records`.
    #[error("Entity #{0} is malformed geometry input; refused")]
    MalformedRecord(u32),

    /// A declared conversion-based length unit whose factor (the
    /// `IFCMEASUREWITHUNIT` `factor`) is not a positive finite number, so no
    /// metre scale is right for the model (#7678, CORE-15). `overflowed`: the
    /// factor read as `+inf` (`1.E400`), which main used as the scale.
    #[error("Length unit factor #{factor} is not a positive finite number; geometry refused")]
    UnusableUnitFactor { factor: u32, overflowed: bool },
}

impl Error {
    pub fn parse(position: usize, message: impl Into<String>) -> Self {
        Self::ParseError {
            position,
            message: message.into(),
        }
    }

    pub fn unexpected(
        position: usize,
        expected: impl Into<String>,
        got: impl Into<String>,
    ) -> Self {
        Self::UnexpectedToken {
            position,
            expected: expected.into(),
            got: got.into(),
        }
    }
}
