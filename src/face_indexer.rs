use std::{io, path::Path};

use rustface::ImageData;
use thiserror::Error;

pub(crate) const DEFAULT_MODEL_PATH: &str = "/usr/local/share/my-drive/seeta_fd_frontal_v1.0.bin";
pub(crate) const MAX_FRAME_SIDE: u32 = 1280;
pub(crate) const MAX_FRAME_BYTES: usize = (MAX_FRAME_SIDE as usize) * (MAX_FRAME_SIDE as usize);
pub(crate) const DESCRIPTOR_SIDE: u32 = 16;
pub(crate) const DESCRIPTOR_LEN: usize = (DESCRIPTOR_SIDE as usize) * (DESCRIPTOR_SIDE as usize);

#[derive(Debug, Clone)]
pub(crate) struct DetectedFace {
    pub(crate) left: f32,
    pub(crate) top: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
    pub(crate) confidence: f32,
    pub(crate) descriptor: Vec<u8>,
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
                descriptor: sample_descriptor(&frame, left, top, width, height),
            })
        })
        .collect())
}

/// Build a small contrast-normalized face descriptor without a neural
/// embedding model. Sampling only 16x16 grayscale pixels keeps CPU and storage
/// bounded on the low-power indexer while still giving repeated photographs a
/// stable appearance signature. The descriptor is an implementation detail;
/// callers must not expose it through an API.
fn sample_descriptor(frame: &GrayFrame, left: f32, top: f32, width: f32, height: f32) -> Vec<u8> {
    let x0 = ((left.clamp(0.0, 1.0) * frame.width as f32).floor() as u32)
        .min(frame.width.saturating_sub(1));
    let y0 = ((top.clamp(0.0, 1.0) * frame.height as f32).floor() as u32)
        .min(frame.height.saturating_sub(1));
    let x1 = (((left + width).clamp(0.0, 1.0) * frame.width as f32).ceil() as u32)
        .max(x0.saturating_add(1))
        .min(frame.width);
    let y1 = (((top + height).clamp(0.0, 1.0) * frame.height as f32).ceil() as u32)
        .max(y0.saturating_add(1))
        .min(frame.height);
    let sample_width = x1.saturating_sub(x0).max(1);
    let sample_height = y1.saturating_sub(y0).max(1);
    let mut samples = [0_u8; DESCRIPTOR_LEN];
    let mut sum = 0_u64;
    for row in 0..DESCRIPTOR_SIDE {
        for column in 0..DESCRIPTOR_SIDE {
            let x = x0.saturating_add(
                ((u64::from(column) * 2 + 1) * u64::from(sample_width)
                    / u64::from(DESCRIPTOR_SIDE * 2))
                .min(u64::from(sample_width.saturating_sub(1))) as u32,
            );
            let y = y0.saturating_add(
                ((u64::from(row) * 2 + 1) * u64::from(sample_height)
                    / u64::from(DESCRIPTOR_SIDE * 2))
                .min(u64::from(sample_height.saturating_sub(1))) as u32,
            );
            let index = usize::try_from(y)
                .ok()
                .and_then(|y| {
                    usize::try_from(x)
                        .ok()
                        .and_then(|x| y.checked_mul(frame.width as usize)?.checked_add(x))
                })
                .unwrap_or(0)
                .min(frame.pixels.len().saturating_sub(1));
            let offset = usize::try_from(row * DESCRIPTOR_SIDE + column).unwrap_or(0);
            samples[offset] = frame.pixels[index];
            sum = sum.saturating_add(u64::from(samples[offset]));
        }
    }

    let count = DESCRIPTOR_LEN as f64;
    let mean = sum as f64 / count;
    let variance = samples
        .iter()
        .map(|sample| {
            let delta = f64::from(*sample) - mean;
            delta * delta
        })
        .sum::<f64>()
        / count;
    let standard_deviation = variance.sqrt().max(1.0);
    samples
        .iter()
        .map(|sample| {
            ((f64::from(*sample) - mean) * 48.0 / standard_deviation + 128.0)
                .round()
                .clamp(0.0, 255.0) as u8
        })
        .collect()
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
    use super::{DESCRIPTOR_LEN, GrayFrame, MAX_FRAME_SIDE, parse_pgm, sample_descriptor};

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

    #[test]
    fn descriptor_is_bounded_and_contrast_normalized() {
        let frame = GrayFrame {
            width: 32,
            height: 32,
            pixels: (0..1024).map(|value| (value % 251) as u8).collect(),
        };
        let descriptor = sample_descriptor(&frame, 0.25, 0.25, 0.5, 0.5);
        assert_eq!(descriptor.len(), DESCRIPTOR_LEN);
        assert!(descriptor.iter().any(|value| *value != 128));
    }

    #[test]
    fn descriptor_is_stable_for_identical_crop_and_changes_for_other_crop() {
        let pixels = (0..4096)
            .map(|value| ((value * 17 + value / 31) % 251) as u8)
            .collect();
        let frame = GrayFrame {
            width: 64,
            height: 64,
            pixels,
        };
        let first = sample_descriptor(&frame, 0.1, 0.1, 0.3, 0.3);
        let same = sample_descriptor(&frame, 0.1, 0.1, 0.3, 0.3);
        let other = sample_descriptor(&frame, 0.6, 0.6, 0.3, 0.3);
        assert_eq!(first, same);
        assert_ne!(first, other);
    }
}
