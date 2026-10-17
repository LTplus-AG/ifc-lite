// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7784 C9a-1 drift 6: the pipe parser used to trim Unicode whitespace
//! outside the root and ignore CDATA there. The terrain parser is ahead of it
//! in the stream, so only the pipe parser fed directly shows the difference.

use quick_xml::events::{BytesCData, BytesText, Event};

use super::PipeParser;
use crate::{LandXmlDiagnosticCode as Code, LandXmlLimits};

fn refusal(event: Event<'_>) -> Option<(Code, String)> {
    let mut parser = PipeParser::new_stream(LandXmlLimits::default());
    parser.consume_event(event).err().map(|error| (error.code, error.message))
}

#[test]
fn outside_the_root_only_xml_whitespace_is_padding() {
    for padding in [" ", "\t\r\n", ""] {
        assert_eq!(refusal(Event::Text(BytesText::from_escaped(padding))), None, "{padding:?}");
    }
    // U+00A0 and U+2003 are Unicode whitespace, not XML `S`.
    for not_padding in ["\u{a0}", "\u{2003}", " x "] {
        let (code, message) = refusal(Event::Text(BytesText::from_escaped(not_padding))).expect("refused");
        assert_eq!(code, Code::InvalidXml, "{not_padding:?}");
        assert_eq!(message, "LandXML document has non-whitespace content before its root element");
    }
}

#[test]
fn cdata_outside_the_root_is_refused() {
    let (code, message) = refusal(Event::CData(BytesCData::new(" "))).expect("refused");
    assert_eq!(code, Code::InvalidXml);
    assert_eq!(message, "LandXML document has CDATA before its root element");
}
