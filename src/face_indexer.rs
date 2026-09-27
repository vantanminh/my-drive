use std::{io, path::Path};

use rustface::ImageData;
use thiserror::Error;

pub(crate) const DEFAULT_MODEL_PATH: &str = "/usr/local/share/my-drive/seeta_fd_frontal_v1.0.bin";
pub(crate) const MAX_FRAME_SIDE: u32 = 1280;
pub(crate) const MAX_FRAME_BYTES: usize = (MAX_FRAME_SIDE as usize) * (MAX_FRAME_SIDE as usize);
pub(crate) const DESCRIPTOR_LEN: usize = 256;
pub(crate) const FACE_INDEX_RECIPE_VERSION: i16 = 3;
const PATCH_SIDE: usize = 32;
const HOG_CELLS: usize = 8;
const HOG_BINS: usize = 4;

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

pub(crate) fn detect_frames(
    model_path: &Path,
    frames: &[GrayFrame],
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
    // A lower minimum size and score catch smaller and dimmer faces. Overlap
    // suppression below drops the duplicate boxes this more sensitive pass creates.
    detector.set_min_face_size(20);
    detector.set_score_thresh(2.0);
    detector.set_pyramid_scale_factor(0.75);
    detector.set_slide_window_step(4, 4);
    let mut detected = Vec::new();
    for frame in frames {
        let enhanced = contrast_stretch(frame);
        let image = ImageData::new(&enhanced.pixels, frame.width, frame.height);
        let mut faces = detector.detect(&image);
        faces.sort_by(|left, right| right.score().total_cmp(&left.score()));
        detected.extend(faces.into_iter().take(32).filter_map(|face| {
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
                descriptor: sample_descriptor(frame, left, top, width, height),
            })
        }));
    }
    Ok(suppress_overlaps(detected))
}

/// Build a 256-byte histogram-of-gradients descriptor. Gradients survive
/// brightness changes better than raw pixels, so the same person is less likely
/// to split across lighting, while a different face still lands far away.
/// The descriptor is an implementation detail and is never returned by the API.
fn sample_descriptor(frame: &GrayFrame, left: f32, top: f32, width: f32, height: f32) -> Vec<u8> {
    // Keep a margin inside the detector box so background pixels do not
    // dominate the signature, but never shrink a tiny face to nothing.
    let inset_x = width * 0.08;
    let inset_y = height * 0.08;
    let crop_left = (left + inset_x).clamp(0.0, 0.98);
    let crop_top = (top + inset_y).clamp(0.0, 0.98);
    let crop_width = (width - inset_x * 2.0)
        .max(width * 0.64)
        .min(1.0 - crop_left);
    let crop_height = (height - inset_y * 2.0)
        .max(height * 0.64)
        .min(1.0 - crop_top);
    let mut patch = sample_patch(frame, crop_left, crop_top, crop_width, crop_height);
    stretch_bytes(&mut patch);
    histogram_of_gradients(&patch).to_vec()
}

fn sample_patch(
    frame: &GrayFrame,
    left: f32,
    top: f32,
    width: f32,
    height: f32,
) -> [u8; PATCH_SIDE * PATCH_SIDE] {
    let mut patch = [0_u8; PATCH_SIDE * PATCH_SIDE];
    let origin_x = left.clamp(0.0, 1.0) * frame.width.max(1) as f32;
    let origin_y = top.clamp(0.0, 1.0) * frame.height.max(1) as f32;
    let span_x = ((left + width).clamp(0.0, 1.0) * frame.width.max(1) as f32 - origin_x).max(1.0);
    let span_y = ((top + height).clamp(0.0, 1.0) * frame.height.max(1) as f32 - origin_y).max(1.0);
    for row in 0..PATCH_SIDE {
        for column in 0..PATCH_SIDE {
            let x = origin_x + (column as f32 + 0.5) * span_x / PATCH_SIDE as f32;
            let y = origin_y + (row as f32 + 0.5) * span_y / PATCH_SIDE as f32;
            patch[row * PATCH_SIDE + column] = bilinear(frame, x, y);
        }
    }
    patch
}

fn bilinear(frame: &GrayFrame, x: f32, y: f32) -> u8 {
    if frame.width == 0 || frame.height == 0 || frame.pixels.is_empty() {
        return 0;
    }
    let max_x = frame.width.saturating_sub(1) as f32;
    let max_y = frame.height.saturating_sub(1) as f32;
    let x = x.clamp(0.0, max_x);
    let y = y.clamp(0.0, max_y);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(frame.width.saturating_sub(1));
    let y1 = (y0 + 1).min(frame.height.saturating_sub(1));
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let sample = |px: u32, py: u32| -> f32 {
        let index = py as usize * frame.width as usize + px as usize;
        f32::from(frame.pixels.get(index).copied().unwrap_or(0))
    };
    let top = sample(x0, y0) * (1.0 - tx) + sample(x1, y0) * tx;
    let bottom = sample(x0, y1) * (1.0 - tx) + sample(x1, y1) * tx;
    (top * (1.0 - ty) + bottom * ty).round().clamp(0.0, 255.0) as u8
}

fn stretch_bytes(samples: &mut [u8]) {
    let Some(min) = samples.iter().copied().min() else {
        return;
    };
    let Some(max) = samples.iter().copied().max() else {
        return;
    };
    let span = u16::from(max.saturating_sub(min)).max(1);
    if span > 220 {
        return;
    }
    for sample in samples {
        *sample = ((u16::from(sample.saturating_sub(min)) * 255) / span).min(255) as u8;
    }
}

fn contrast_stretch(frame: &GrayFrame) -> GrayFrame {
    let mut pixels = frame.pixels.clone();
    stretch_bytes(&mut pixels);
    GrayFrame {
        width: frame.width,
        height: frame.height,
        pixels,
    }
}

fn histogram_of_gradients(patch: &[u8; PATCH_SIDE * PATCH_SIDE]) -> [u8; DESCRIPTOR_LEN] {
    let mut histogram = [0_f32; DESCRIPTOR_LEN];
    let cell = PATCH_SIDE / HOG_CELLS;
    for cell_y in 0..HOG_CELLS {
        for cell_x in 0..HOG_CELLS {
            for py in 0..cell {
                for px in 0..cell {
                    let x = cell_x * cell + px;
                    let y = cell_y * cell + py;
                    let left = patch_at(patch, x.saturating_sub(1), y);
                    let right = patch_at(patch, (x + 1).min(PATCH_SIDE - 1), y);
                    let up = patch_at(patch, x, y.saturating_sub(1));
                    let down = patch_at(patch, x, (y + 1).min(PATCH_SIDE - 1));
                    let gx = f32::from(right) - f32::from(left);
                    let gy = f32::from(down) - f32::from(up);
                    let magnitude = gx.hypot(gy);
                    if magnitude < 1.0 {
                        continue;
                    }
                    let mut angle = gy.atan2(gx);
                    if angle < 0.0 {
                        angle += std::f32::consts::PI;
                    }
                    let bin = ((angle / std::f32::consts::PI) * HOG_BINS as f32).floor() as usize
                        % HOG_BINS;
                    histogram[(cell_y * HOG_CELLS + cell_x) * HOG_BINS + bin] += magnitude;
                }
            }
        }
    }

    let mut accumulated = [0_f32; DESCRIPTOR_LEN];
    let mut counts = [0_u8; DESCRIPTOR_LEN];
    for block_y in 0..HOG_CELLS.saturating_sub(1) {
        for block_x in 0..HOG_CELLS.saturating_sub(1) {
            let mut energy = 1e-4_f32;
            for offset_y in 0..2 {
                for offset_x in 0..2 {
                    for bin in 0..HOG_BINS {
                        let index = ((block_y + offset_y) * HOG_CELLS + block_x + offset_x)
                            * HOG_BINS
                            + bin;
                        energy += histogram[index] * histogram[index];
                    }
                }
            }
            let norm = energy.sqrt();
            for offset_y in 0..2 {
                for offset_x in 0..2 {
                    for bin in 0..HOG_BINS {
                        let index = ((block_y + offset_y) * HOG_CELLS + block_x + offset_x)
                            * HOG_BINS
                            + bin;
                        accumulated[index] += (histogram[index] / norm).min(0.2);
                        counts[index] = counts[index].saturating_add(1);
                    }
                }
            }
        }
    }

    let mut values = [0_f32; DESCRIPTOR_LEN];
    let mut peak = 1e-6_f32;
    for index in 0..DESCRIPTOR_LEN {
        values[index] = if counts[index] == 0 {
            0.0
        } else {
            accumulated[index] / f32::from(counts[index])
        };
        peak = peak.max(values[index]);
    }
    let mut descriptor = [0_u8; DESCRIPTOR_LEN];
    for index in 0..DESCRIPTOR_LEN {
        descriptor[index] = ((values[index] / peak) * 255.0).round().clamp(0.0, 255.0) as u8;
    }
    descriptor
}

fn patch_at(patch: &[u8; PATCH_SIDE * PATCH_SIDE], x: usize, y: usize) -> u8 {
    patch[y * PATCH_SIDE + x]
}

pub(crate) fn suppress_overlaps(mut faces: Vec<DetectedFace>) -> Vec<DetectedFace> {
    faces.sort_by(|left, right| {
        right
            .confidence
            .total_cmp(&left.confidence)
            .then_with(|| left.left.total_cmp(&right.left))
            .then_with(|| left.top.total_cmp(&right.top))
    });
    let mut kept = Vec::with_capacity(faces.len());
    for face in faces {
        if kept
            .iter()
            .any(|existing: &DetectedFace| iou(existing, &face) > 0.5)
        {
            continue;
        }
        kept.push(face);
    }
    kept
}

fn iou(left: &DetectedFace, right: &DetectedFace) -> f32 {
    let overlap_width =
        (left.left + left.width).min(right.left + right.width) - left.left.max(right.left);
    let overlap_height =
        (left.top + left.height).min(right.top + right.height) - left.top.max(right.top);
    if overlap_width <= 0.0 || overlap_height <= 0.0 {
        return 0.0;
    }
    let intersection = overlap_width * overlap_height;
    let union = left.width * left.height + right.width * right.height - intersection;
    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
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
    use super::{
        DESCRIPTOR_LEN, DetectedFace, GrayFrame, MAX_FRAME_SIDE, parse_pgm, sample_descriptor,
        suppress_overlaps,
    };

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

    fn mean_distance(left: &[u8], right: &[u8]) -> u32 {
        left.iter()
            .zip(right)
            .map(|(left, right)| u32::from(left.abs_diff(*right)))
            .sum::<u32>()
            / left.len() as u32
    }

    #[test]
    fn similar_faces_are_closer_than_a_different_pattern() {
        let mut face = vec![40_u8; 96 * 96];
        for y in 20..76 {
            for x in 24..72 {
                let dx = x as i32 - 48;
                let dy = y as i32 - 48;
                if dx * dx + dy * dy < 28 * 28 {
                    face[y * 96 + x] = 180;
                }
            }
        }
        let frame = GrayFrame {
            width: 96,
            height: 96,
            pixels: face,
        };
        let shifted = sample_descriptor(&frame, 0.18, 0.16, 0.52, 0.58);
        let again = sample_descriptor(&frame, 0.2, 0.18, 0.5, 0.56);
        let mut stripes = vec![20_u8; 96 * 96];
        for y in 0..96 {
            for x in 0..96 {
                stripes[y * 96 + x] = if y % 8 < 4 { 30 } else { 210 };
            }
        }
        let other = sample_descriptor(
            &GrayFrame {
                width: 96,
                height: 96,
                pixels: stripes,
            },
            0.2,
            0.18,
            0.5,
            0.56,
        );
        let close = mean_distance(&shifted, &again);
        let far = mean_distance(&shifted, &other);
        assert!(close < far, "close {close} should be below far {far}");
        assert!(close < 48, "similar crops drifted by {close}");
    }

    #[test]
    fn overlapping_detections_keep_the_stronger_face() {
        let strong = DetectedFace {
            left: 0.2,
            top: 0.2,
            width: 0.3,
            height: 0.3,
            confidence: 0.9,
            descriptor: vec![1, 2, 3],
        };
        let duplicate = DetectedFace {
            left: 0.22,
            top: 0.21,
            width: 0.3,
            height: 0.3,
            confidence: 0.4,
            descriptor: vec![4, 5, 6],
        };
        let other = DetectedFace {
            left: 0.7,
            top: 0.6,
            width: 0.2,
            height: 0.2,
            confidence: 0.5,
            descriptor: vec![7, 8, 9],
        };
        let kept = suppress_overlaps(vec![duplicate, other, strong]);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].confidence, 0.9);
        assert_eq!(kept[1].confidence, 0.5);
    }
}
