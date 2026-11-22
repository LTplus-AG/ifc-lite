// SPDX-License-Identifier: MPL-2.0

use ifc_lite_core::parser::parse_ref;

use super::super::durations::decimal_seconds;

pub(super) const DATE_CARRIERS: [&str; 4] = [
    "IFCCALENDARDATE", "IFCDATEANDTIME", "IFCLOCALTIME", "IFCCOORDINATEDUNIVERSALTIMEOFFSET",
];

#[derive(Clone, Copy)]
pub(super) enum Kind { Date, DateTime, Time }

impl Kind {
    pub(super) fn read(name: &str) -> Option<Self> {
        match name {
            "DATE" => Some(Self::Date),
            "DATETIME" => Some(Self::DateTime),
            "TIME" => Some(Self::Time),
            _ => None,
        }
    }
}

pub(super) struct DateRecord {
    pub(super) ty: String,
    pub(super) slots: Vec<String>,
}

struct Day { year: u16, month: u8, day: u8 }
struct Clock { hour: u8, minute: u8, second: String, zone: Option<i16> }

fn valid_day(year: u16, month: u8, day: u8) -> Option<Day> {
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    (year > 0 && year <= 9999 && day > 0 && day <= *days.get(usize::from(month.checked_sub(1)?))?)
        .then_some(Day { year, month, day })
}

fn unset(s: &str) -> bool {
    matches!(s, "$" | "*")
}

fn legacy_day(record: &DateRecord) -> Option<Day> {
    let [day, month, year] = record.slots.as_slice() else { return None };
    (record.ty == "IFCCALENDARDATE").then_some(())?;
    valid_day(year.parse().ok()?, month.parse().ok()?, day.parse().ok()?)
}

fn legacy_zone(record: &DateRecord) -> Option<i16> {
    let [hour, minute, sense] = record.slots.as_slice() else { return None };
    (record.ty == "IFCCOORDINATEDUNIVERSALTIMEOFFSET").then_some(())?;
    let (hour, minute) = (hour.parse::<i16>().ok()?, if unset(minute) { 0 } else { minute.parse::<i16>().ok()? });
    let sign = match sense.to_ascii_uppercase().as_str() { ".AHEAD." => 1, ".BEHIND." => -1, _ => return None };
    ((0..24).contains(&hour) && (0..60).contains(&minute)).then_some(sign * (hour * 60 + minute))
}

fn legacy_clock<'a>(record: &DateRecord, read: &impl Fn(Option<u32>) -> Option<&'a DateRecord>) -> Option<Clock> {
    let [h, m, s, z, dst] = record.slots.as_slice() else { return None };
    (record.ty == "IFCLOCALTIME").then_some(())?;
    let (hour, minute) = (h.parse::<u8>().ok()?, if unset(m) { 0 } else { m.parse::<u8>().ok()? });
    let input = if unset(s) { "0".to_owned() } else { decimal_seconds(s)? };
    let (whole, fraction) = input.split_once('.').unwrap_or((&input, ""));
    let whole = if digits(whole) { whole.parse::<u8>().ok()? } else { return None };
    if hour >= 24 || minute >= 60 || whole >= 60 || !fraction.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let trimmed = fraction.trim_end_matches('0');
    let second = if trimmed.is_empty() { format!("{whole:02}") } else { format!("{whole:02}.{trimmed}") };
    let zone = if unset(z) { None } else { Some(legacy_zone(read(parse_ref(z.as_bytes()))?)?) };
    let dst = if unset(dst) { 0 } else { dst.parse::<i16>().ok()? };
    if !(0..=2).contains(&dst) || (zone.is_none() && dst != 0) {
        return None;
    }
    let zone = zone.map(|zone| zone + dst * 60);
    if zone.is_some_and(|zone| zone.abs() >= 1440) {
        return None;
    }
    Some(Clock { hour, minute, second, zone })
}

pub(super) fn from_legacy<'a>(source: &str, kind: Kind, read: impl Fn(Option<u32>) -> Option<&'a DateRecord>) -> Option<(String, bool)> {
    let record = read(parse_ref(source.as_bytes()))?;
    let narrowed = matches!(kind, Kind::Date) && record.ty == "IFCDATEANDTIME";
    let child = |slot: &str| read(parse_ref(slot.as_bytes()));
    let (day, clock) = match (kind, record.ty.as_str(), record.slots.as_slice()) {
        (Kind::Date, "IFCDATEANDTIME", [date, _]) => (Some(legacy_day(child(date)?)?), None),
        (Kind::Date, _, _) => (Some(legacy_day(record)?), None),
        (Kind::Time, _, _) => (None, Some(legacy_clock(record, &read)?)),
        (Kind::DateTime, "IFCDATEANDTIME", [date, time]) => {
            (Some(legacy_day(child(date)?)?), Some(legacy_clock(child(time)?, &read)?))
        }
        (Kind::DateTime, _, _) => return None,
    };
    let day = day.map_or_else(String::new, |Day { year, month, day }| format!("{year:04}-{month:02}-{day:02}"));
    let Some(Clock { hour, minute, second, zone }) = clock else { return Some((format!("'{day}'"), narrowed)) };
    let junction = if day.is_empty() { "" } else { "T" };
    let zone = match zone {
        None => String::new(),
        Some(0) => "Z".to_owned(),
        Some(zone) => format!("{}{:02}:{:02}", if zone < 0 { '-' } else { '+' }, zone.abs() / 60, zone.abs() % 60),
    };
    Some((format!("'{day}{junction}{hour:02}:{minute:02}:{second}{zone}'"), false))
}

fn digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit())
}

fn iso_day(text: &str) -> Option<Day> {
    let (year, rest) = text.split_once('-')?;
    let (month, day) = rest.split_once('-')?;
    (year.len() == 4 && month.len() == 2 && day.len() == 2 && [year, month, day].into_iter().all(digits)).then_some(())?;
    valid_day(year.parse().ok()?, month.parse().ok()?, day.parse().ok()?)
}

fn clock_fields(text: &str) -> Option<(u8, u8)> {
    let (hour, minute) = text.split_once(':')?;
    (hour.len() == 2 && minute.len() == 2 && digits(hour) && digits(minute)).then_some(())?;
    let (hour, minute) = (hour.parse().ok()?, minute.parse().ok()?);
    (hour < 24 && minute < 60).then_some((hour, minute))
}

fn iso_clock(text: &str) -> Option<Clock> {
    let (hm, rest) = (text.get(..5)?, text.get(5..)?.strip_prefix(':')?);
    let (hour, minute) = clock_fields(hm)?;
    let (sec, zone) = if let Some(sec) = rest.strip_suffix('Z') {
        (sec, Some(0))
    } else if let Some(at) = rest.find(['-', '+']) {
        let (h, m) = clock_fields(&rest[at + 1..])?;
        let magnitude = i16::from(h) * 60 + i16::from(m);
        (&rest[..at], Some(if rest.as_bytes()[at] == b'-' { -magnitude } else { magnitude }))
    } else {
        (rest, None)
    };
    let (whole, fraction) = sec.split_once('.').unwrap_or((sec, ""));
    (whole.len() == 2 && digits(whole) && whole.parse::<u8>().ok()? < 60
        && ((fraction.is_empty() && !sec.contains('.')) || digits(fraction))).then_some(())?;
    Some(Clock { hour, minute, second: sec.to_owned(), zone })
}

pub(super) fn to_legacy(token: &str, kind: Kind, mut add: impl FnMut(String) -> Option<u32>) -> Option<u32> {
    let token = token.strip_prefix('\'')?.strip_suffix('\'')?;
    let (day, clock) = match kind {
        Kind::Date => (Some(iso_day(token)?), None),
        Kind::Time => (None, Some(iso_clock(token)?)),
        Kind::DateTime => {
            let (date, time) = token.split_once('T')?;
            (Some(iso_day(date)?), Some(iso_clock(time)?))
        }
    };
    let date = match day {
        Some(Day { year, month, day }) => Some(add(format!("IFCCALENDARDATE({day},{month},{year})"))?),
        None => None,
    };
    let Some(Clock { hour, minute, second, zone }) = clock else { return date };
    let zone = match zone {
        None => "$".to_owned(),
        Some(zone) => {
            let sense = if zone < 0 { ".BEHIND." } else { ".AHEAD." };
            let offset = add(format!("IFCCOORDINATEDUNIVERSALTIMEOFFSET({},{},{sense})", zone.abs() / 60, zone.abs() % 60))?;
            format!("#{offset}")
        }
    };
    let second = second.strip_prefix('0').unwrap_or(&second);
    let dot = if second.contains('.') { "" } else { "." };
    let time = add(format!("IFCLOCALTIME({hour},{minute},{second}{dot},{zone},$)"))?;
    match date {
        Some(date) => add(format!("IFCDATEANDTIME(#{date},#{time})")),
        None => Some(time),
    }
}
