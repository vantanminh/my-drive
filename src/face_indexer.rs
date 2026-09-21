use std::{io, path::Path};

use rustface::ImageData;
use thiserror::Error;

pub(crate) const DEFAULT_MODEL_PATH: &str = "/usr/local/share/my-drive/seeta_fd_frontal_v1.0.bin";
pub(crate) const MAX_FRAME_SIDE: u32 = 1280;
pub(crate) const MAX_FRAME_BYTES: usize = (MAX_FRAME_SIDE as usize) * (MAX_FRAME_SIDE as usize);

#[derive(Debug, Clone, Copy)]
pub(crate) struct DetectedFace {
    pub(crate) left: f32,
    pub(crate) top: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) confidence: f32,
}

#[derive(Debug, Error)]
pub(crate) enum FaceDetectionError {
    #[error("face detector model is unavailable")]
    ModelUnavailable(#[source] io::Error),
    #[error("face detector model could not be loaded")]
    ModelInvalid(#[source] io::Error),
    #[error("face frame is invalid")]
    InvalidFrame,
}

#[derive(Debug)]
pub(crate) struct GrayFrame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Vec<u8>,
}

pub(crate) fn parse_pgm(bytes: &[u8]) -> Result<GrayFrame, FaceDetectionError> {
    let mut cursor = 0;
    let magic = next_token(bytes, &mut cursor).ok_or(FaceDetectionError::InvalidFrame)?;
    if magic != b"P5" {
        return Err(FaceDetectionError::InvalidFrame);
    }
    let width = parse_dimension(next_token(bytes, &mut cursor))?;
    let height = parse_dimension(next_token(bytes, &mut cursor))?;
    let max_value = next_token(bytes, &mut cursor).ok_or(FaceDetectionError::InvalidFrame)?;
    if max_value != b"255" || width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE {
        return Err(FaceDetectionError::InvalidFrame);
    }
    let pixel_count = usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or(FaceDetectionError::InvalidFrame)?;
    // The PGM header ends with one required whitespace delimiter. Consume
    // exactly that delimiter so a leading whitespace-valued pixel is not
    // mistaken for additional header padding.
    if bytes
        .get(cursor)
        .is_none_or(|byte| !byte.is_ascii_whitespace())
    {
        return Err(FaceDetectionError::InvalidFrame);
    }
    if bytes[cursor] == b'\r' && bytes.get(cursor + 1) == Some(&b'\n') {
        cursor += 2;
    } else {
        cursor += 1;
    }
    let end = cursor
        .checked_add(pixel_count)
        .filter(|end| *end <= bytes.len())
        .ok_or(FaceDetectionError::InvalidFrame)?;
    if pixel_count == 0 || pixel_count > MAX_FRAME_BYTES {
        return Err(FaceDetectionError::InvalidFrame);
    }
    Ok(GrayFrame {
        width,
        height,
        pixels: bytes[cursor..end].to_vec(),
    })
}

pub(crate) fn detect(
    model_path: &Path,
    frame: GrayFrame,
) -> Result<Vec<DetectedFace>, FaceDetectionError> {
    if !model_path.is_file() {
        return Err(FaceDetectionError::ModelUnavailable(io::Error::new(
            io::ErrorKind::NotFound,
            model_path.display().to_string(),
        )));
    }
    let model_path = model_path.to_str().ok_or_else(|| {
        FaceDetectionError::ModelUnavailable(io::Error::new(
            io::ErrorKind::InvalidInput,
            "face detector model path is not valid UTF-8",
        ))
    })?;
    let mut detector =
        rustface::create_detector(model_path).map_err(FaceDetectionError::ModelInvalid)?;
    detector.set_min_face_size(40);
    detector.set_score_thresh(2.8);
    detector.set_pyramid_scale_factor(0.8);
    detector.set_slide_window_step(4, 4);
    let image = ImageData::new(&frame.pixels, frame.width, frame.height);
    let mut faces = detector.detect(&image);
    faces.sort_by(|left, right| right.score().total_cmp(&left.score()));
    Ok(faces
        .into_iter()
        .take(32)
        .filter_map(|face| {
            let bbox = face.bbox();
            let left = bbox.x().max(0) as f32 / frame.width as f32;
            let top = bbox.y().max(0) as f32 / frame.height as f32;
            let right = (bbox.x().max(0) as u32)
                .saturating_add(bbox.width())
                .min(frame.width) as f32
                / frame.width as f32;
            let bottom = (bbox.y().max(0) as u32)
                .saturating_add(bbox.height())
                .min(frame.height) as f32
                / frame.height as f32;
            let width = right - left;
            let height = bottom - top;
            if width <= 0.0 || height <= 0.0 {
                return None;
            }
            let score = face.score().max(0.0) as f32;
            Some(DetectedFace {
                left,
                top,
                width,
                height,
                confidence: (score / 10.0).clamp(0.0, 1.0),
            })
        })
        .collect())
}

fn parse_dimension(token: Option<&[u8]>) -> Result<u32, FaceDetectionError> {
    let token = token.ok_or(FaceDetectionError::InvalidFrame)?;
    let value = std::str::from_utf8(token)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or(FaceDetectionError::InvalidFrame)?;
    if value == 0 {
        return Err(FaceDetectionError::InvalidFrame);
    }
    Ok(value)
}

fn next_token<'a>(bytes: &'a [u8], cursor: &mut usize) -> Option<&'a [u8]> {
    while *cursor < bytes.len() {
        match bytes[*cursor] {
            b'#' => {
                while *cursor < bytes.len() && bytes[*cursor] != b'\n' {
                    *cursor += 1;
                }
            }
            byte if byte.is_ascii_whitespace() => *cursor += 1,
            _ => break,
        }
    }
    let start = *cursor;
    while *cursor < bytes.len() && !bytes[*cursor].is_ascii_whitespace() {
        *cursor += 1;
    }
    (start < *cursor).then_some(&bytes[start..*cursor])
}

#[cfg(test)]
mod tests {
    use super::{MAX_FRAME_SIDE, parse_pgm};

    #[test]
    fn parses_bounded_binary_pgm_with_comments() {
        let bytes = b"P5\n# generated\n2 1\n255\n\x00\xff";
        let frame = parse_pgm(bytes).unwrap();
        assert_eq!((frame.width, frame.height), (2, 1));
        assert_eq!(frame.pixels, [0, 255]);
    }

    #[test]
    fn accepts_crlf_pgm_headers_without_dropping_pixels() {
        let frame = parse_pgm(b"P5\r\n2 1\r\n255\r\n\x20\xff").unwrap();
        assert_eq!(frame.pixels, [0x20, 0xff]);
    }

    #[test]
    fn rejects_wrong_format_and_oversized_frames() {
        assert!(parse_pgm(b"P2\n1 1\n255\n0").is_err());
        let header = format!("P5\n{} 1\n255\n", MAX_FRAME_SIDE + 1);
        assert!(parse_pgm(header.as_bytes()).is_err());
    }
}
