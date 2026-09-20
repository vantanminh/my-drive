#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct ByteRange {
    pub start: u64,
    pub end: u64,
}

impl ByteRange {
    pub fn len(self) -> u64 {
        self.end - self.start + 1
    }
}

pub(super) fn parse_range(value: Option<&str>, size: u64) -> Result<Option<ByteRange>, ()> {
    let Some(value) = value else {
        return Ok(None);
    };
    if size == 0 {
        return Err(());
    }
    let Some(specification) = value.strip_prefix("bytes=") else {
        return Err(());
    };
    if specification.contains(',') {
        return Err(());
    }
    let Some((first, last)) = specification.split_once('-') else {
        return Err(());
    };
    if first.is_empty() {
        let suffix = last.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let length = suffix.min(size);
        return Ok(Some(ByteRange {
            start: size - length,
            end: size - 1,
        }));
    }

    let start = first.parse::<u64>().map_err(|_| ())?;
    if start >= size {
        return Err(());
    }
    let end = if last.is_empty() {
        size - 1
    } else {
        let requested_end = last.parse::<u64>().map_err(|_| ())?;
        if requested_end < start {
            return Err(());
        }
        requested_end.min(size - 1)
    };
    Ok(Some(ByteRange { start, end }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_open_ended_and_suffix_ranges() {
        assert_eq!(parse_range(None, 10), Ok(None));
        assert_eq!(
            parse_range(Some("bytes=2-5"), 10),
            Ok(Some(ByteRange { start: 2, end: 5 }))
        );
        assert_eq!(
            parse_range(Some("bytes=7-"), 10),
            Ok(Some(ByteRange { start: 7, end: 9 }))
        );
        assert_eq!(
            parse_range(Some("bytes=-4"), 10),
            Ok(Some(ByteRange { start: 6, end: 9 }))
        );
        assert_eq!(
            parse_range(Some("bytes=-20"), 10),
            Ok(Some(ByteRange { start: 0, end: 9 }))
        );
        assert_eq!(
            parse_range(Some("bytes=0-900"), 10),
            Ok(Some(ByteRange { start: 0, end: 9 }))
        );
    }

    #[test]
    fn rejects_unsatisfiable_and_unsupported_ranges() {
        for value in [
            "items=0-1",
            "bytes=10-",
            "bytes=5-2",
            "bytes=-0",
            "bytes=1-2,5-6",
            "bytes=abc-def",
        ] {
            assert_eq!(parse_range(Some(value), 10), Err(()), "accepted {value}");
        }
        assert_eq!(parse_range(Some("bytes=0-0"), 0), Err(()));
    }
}
