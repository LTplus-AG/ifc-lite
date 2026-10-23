// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! JSON parsing with JavaScript's lossless UTF-16 string semantics.
use std::collections::HashMap;
use crate::sidecar_value::{DocumentValue, JsString, ordered_object};

type Error = serde_json::Error;
fn error(message: &str) -> Error { <Error as serde::de::Error>::custom(message) }
struct Parser<'a> { text: &'a str, pos: usize }
impl Parser<'_> {
    fn peek(&self) -> Option<u8> { self.text.as_bytes().get(self.pos).copied() }
    fn whitespace(&mut self) { while matches!(self.peek(), Some(b' ' | b'\n' | b'\r' | b'\t')) { self.pos += 1; } }
    fn take(&mut self, byte: u8) -> Result<(), Error> {
        if self.peek() != Some(byte) { return Err(error("unexpected JSON token")); }
        self.pos += 1;
        Ok(())
    }
    fn string(&mut self) -> Result<JsString, Error> {
        self.take(b'"')?;
        let mut units = Vec::new();
        loop {
            match self.peek().ok_or_else(|| error("unterminated JSON string"))? {
                b'"' => { self.pos += 1; return Ok(JsString::from_units(units)); }
                b'\\' => {
                    self.pos += 1;
                    let escape = self.peek().ok_or_else(|| error("unterminated JSON escape"))?;
                    self.pos += 1;
                    units.push(match escape {
                        b'"' => u16::from(b'"'), b'\\' => u16::from(b'\\'), b'/' => u16::from(b'/'),
                        b'b' => 8, b'f' => 12, b'n' => 10, b'r' => 13, b't' => 9,
                        b'u' => {
                            let mut unit = 0u16;
                            for _ in 0..4 {
                                let byte = self.peek().ok_or_else(|| error("short Unicode escape"))?;
                                let digit = char::from(byte).to_digit(16).ok_or_else(|| error("invalid Unicode escape"))?;
                                unit = unit * 16 + digit as u16;
                                self.pos += 1;
                            }
                            unit
                        }
                        _ => return Err(error("invalid JSON escape")),
                    });
                }
                byte if byte < 0x20 => return Err(error("unescaped control in JSON string")),
                _ => {
                    let ch = self.text[self.pos..].chars().next().unwrap();
                    self.pos += ch.len_utf8();
                    let mut buffer = [0; 2];
                    units.extend_from_slice(ch.encode_utf16(&mut buffer));
                }
            }
        }
    }
    fn number(&mut self) -> Result<DocumentValue, Error> {
        let start = self.pos;
        if self.peek() == Some(b'-') { self.pos += 1; }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.digits(),
            _ => return Err(error("invalid JSON number")),
        }
        if self.peek() == Some(b'.') {
            self.pos += 1;
            self.required_digits()?;
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) { self.pos += 1; }
            self.required_digits()?;
        }
        let value = self.text[start..self.pos].parse::<f64>().map_err(|_| error("invalid JSON number"))?;
        Ok(DocumentValue::Number(value))
    }
    fn digits(&mut self) { while matches!(self.peek(), Some(b'0'..=b'9')) { self.pos += 1; } }
    fn required_digits(&mut self) -> Result<(), Error> {
        let start = self.pos;
        self.digits();
        if start == self.pos { Err(error("expected JSON digit")) } else { Ok(()) }
    }
    fn value(&mut self, depth: usize) -> Result<DocumentValue, Error> {
        // Match the previous serde reader's bounded nesting; strings and file
        // length do not consume stack, and each input token is consumed once.
        if depth >= 128 { return Err(error("JSON nesting limit exceeded")); }
        self.whitespace();
        match self.peek() {
            Some(b'"') => Ok(DocumentValue::String(self.string()?)),
            Some(b'[') => {
                self.pos += 1;
                self.whitespace();
                let mut items = Vec::new();
                if self.peek() != Some(b']') {
                    loop {
                        items.push(self.value(depth + 1)?);
                        self.whitespace();
                        if self.peek() != Some(b',') { break; }
                        self.pos += 1;
                    }
                }
                self.take(b']')?;
                Ok(DocumentValue::Array(items))
            }
            Some(b'{') => {
                self.pos += 1;
                self.whitespace();
                let mut entries: Vec<(JsString, DocumentValue)> = Vec::new();
                let mut positions = HashMap::new();
                if self.peek() != Some(b'}') {
                    loop {
                        self.whitespace();
                        let key = self.string()?;
                        self.whitespace();
                        self.take(b':')?;
                        let value = self.value(depth + 1)?;
                        // JSON.parse keeps first position and last value for
                        // duplicate keys, comparing their decoded code units.
                        if let Some(&index) = positions.get(&key) {
                            let entry: &mut (JsString, DocumentValue) = &mut entries[index];
                            entry.1 = value;
                        } else {
                            positions.insert(key.clone(), entries.len());
                            entries.push((key, value));
                        }
                        self.whitespace();
                        if self.peek() != Some(b',') { break; }
                        self.pos += 1;
                    }
                }
                self.take(b'}')?;
                Ok(ordered_object(entries))
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => {
                for (literal, value) in [("null", DocumentValue::Null), ("true", DocumentValue::Bool(true)), ("false", DocumentValue::Bool(false))] {
                    if self.text[self.pos..].starts_with(literal) { self.pos += literal.len(); return Ok(value); }
                }
                Err(error("unexpected JSON token"))
            }
        }
    }
}
/// Parse wire JSON while retaining JavaScript strings and enumeration order.
pub fn parse_ordered_json(text: &str) -> Result<DocumentValue, Error> {
    let mut parser = Parser { text, pos: 0 };
    let value = parser.value(0)?;
    parser.whitespace();
    if parser.pos != text.len() { return Err(error("trailing JSON content")); }
    Ok(value)
}
