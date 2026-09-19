//! USD amounts as fixed-point integers with 8 decimal places, matching the
//! `NUMERIC(20, 8)` columns and the values the Node backend wrote.

use std::fmt;

const SCALE: u32 = 8;
const SCALE_FACTOR: i128 = 100_000_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Usd(pub i128);

fn round_divide(value: i128, divisor: i128) -> i128 {
    let quotient = value / divisor;
    let remainder = (value % divisor).abs();
    if remainder * 2 >= divisor {
        quotient + value.signum()
    } else {
        quotient
    }
}

impl Usd {
    pub const ZERO: Usd = Usd(0);

    /// Parses decimal strings (optionally with an exponent) and JSON numbers.
    pub fn parse(value: &str) -> Option<Usd> {
        let value = value.trim();
        let (negative, rest) = match value.as_bytes().first()? {
            b'-' => (true, &value[1..]),
            b'+' => (false, &value[1..]),
            _ => (false, value),
        };
        let (mantissa, exponent) = match rest.find(['e', 'E']) {
            Some(index) => (&rest[..index], rest[index + 1..].parse::<i32>().ok()?),
            None => (rest, 0),
        };
        if exponent.abs() > 100 {
            return None;
        }
        let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
        if whole.is_empty()
            || !whole.bytes().all(|b| b.is_ascii_digit())
            || !fraction.bytes().all(|b| b.is_ascii_digit())
            || (mantissa.contains('.') && fraction.is_empty())
        {
            return None;
        }
        let digits = format!("{whole}{fraction}");
        let coefficient: i128 = digits.trim_start_matches('0').parse().unwrap_or(0);
        if digits.len() > 36 {
            return None;
        }
        let shift = SCALE as i32 - (fraction.len() as i32 - exponent);
        let scaled = if shift >= 0 {
            coefficient.checked_mul(10i128.checked_pow(shift as u32)?)?
        } else {
            round_divide(coefficient, 10i128.checked_pow((-shift) as u32)?)
        };
        Some(Usd(if negative { -scaled } else { scaled }))
    }

    pub fn from_json(value: &serde_json::Value) -> Option<Usd> {
        match value {
            serde_json::Value::String(s) => Usd::parse(s),
            serde_json::Value::Number(n) => Usd::parse(&n.to_string()),
            _ => None,
        }
    }

    /// `rate` is USD per million units.
    pub fn per_million(units: u64, rate: Usd) -> i128 {
        units as i128 * rate.0
    }

    pub fn divide(value: i128, divisor: i128) -> Usd {
        Usd(round_divide(value, divisor))
    }

    pub fn to_f64(self) -> f64 {
        self.0 as f64 / SCALE_FACTOR as f64
    }
}

impl fmt::Display for Usd {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let sign = if self.0 < 0 { "-" } else { "" };
        let absolute = self.0.unsigned_abs();
        let scale = SCALE_FACTOR as u128;
        write!(f, "{sign}{}.{:08}", absolute / scale, absolute % scale)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_formats_like_node() {
        assert_eq!(Usd::parse("1").unwrap().to_string(), "1.00000000");
        assert_eq!(Usd::parse("0.4").unwrap().to_string(), "0.40000000");
        assert_eq!(Usd::parse("4.52").unwrap().to_string(), "4.52000000");
        assert_eq!(Usd::parse("1e-2").unwrap().to_string(), "0.01000000");
        assert_eq!(Usd::parse("0.123456789").unwrap().to_string(), "0.12345679");
        assert_eq!(Usd::parse("-3").unwrap().to_string(), "-3.00000000");
        assert!(Usd::parse("abc").is_none());
        assert!(Usd::parse("1.").is_none());
        assert!(Usd::parse("").is_none());
    }

    #[test]
    fn divides_with_half_up_rounding() {
        assert_eq!(Usd::divide(5, 2).0, 3);
        assert_eq!(Usd::divide(-5, 2).0, -3);
        assert_eq!(Usd::divide(4, 3).0, 1);
    }
}
