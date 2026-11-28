use std::{
    io,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use ort::{
    environment::Environment,
    session::{Session, builder::GraphOptimizationLevel},
    value::Tensor,
};
use thiserror::Error;

pub(crate) const DEFAULT_MODEL_DIR: &str = "/usr/local/share/my-drive/face-models";
pub(crate) const DEFAULT_ORT_DYLIB_PATH: &str = "/usr/local/lib/libonnxruntime.so";
pub(crate) const DETECTOR_MODEL_FILE: &str = "det_10g.onnx";
pub(crate) const RECOGNIZER_MODEL_FILE: &str = "w600k_r50.onnx";
pub(crate) const MAX_FRAME_SIDE: u32 = 1280;
pub(crate) const MAX_FRAME_BYTES: usize = (MAX_FRAME_SIDE as usize) * (MAX_FRAME_SIDE as usize) * 3;
pub(crate) const EMBEDDING_DIM: usize = 512;
pub(crate) const DESCRIPTOR_LEN: usize = EMBEDDING_DIM * 4;
pub(crate) const FACE_INDEX_RECIPE_VERSION: i16 = 4;
pub(crate) const MIN_DET_SCORE: f32 = 0.45;
pub(crate) const FACE_MATCH_THRESHOLD: f32 = 0.45;
const DET_INPUT_SIZE: u32 = 640;
const NMS_IOU_THRESHOLD: f32 = 0.40;
const ALIGN_SIZE: usize = 112;
const MIN_FACE_PIXEL_SIDE: f32 = 16.0;
const MAX_FACE_ASPECT_RATIO: f32 = 3.5;
const MAX_FACES_PER_FRAME: usize = 32;

const SCRFD_STRIDES: [u32; 3] = [8, 16, 32];
const SCRFD_NUM_ANCHORS: usize = 2;

const ARCFACE_DST: [[f64; 2]; 5] = [
    [38.2946, 51.6963],
    [73.5318, 51.5014],
    [56.0252, 71.7366],
    [41.5493, 92.3655],
    [70.7299, 92.2041],
];

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
pub(crate) struct RgbFrame {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) pixels: Vec<u8>,
}

struct FaceEngine {
    _env: Environment,
    detector: Session,
    recognizer: Session,
}

static ENGINE_CACHE: OnceLock<Mutex<Option<(PathBuf, FaceEngine)>>> = OnceLock::new();
static ORT_INIT: OnceLock<Result<Environment, String>> = OnceLock::new();

pub(crate) fn parse_ppm(bytes: &[u8]) -> Result<RgbFrame, FaceDetectionError> {
    let mut cursor = 0;
    let magic = next_token(bytes, &mut cursor).ok_or(FaceDetectionError::InvalidFrame)?;
    if magic != b"P6" {
        return Err(FaceDetectionError::InvalidFrame);
    }
    let width = parse_dimension(next_token(bytes, &mut cursor))?;
    let height = parse_dimension(next_token(bytes, &mut cursor))?;
    let max_value = next_token(bytes, &mut cursor).ok_or(FaceDetectionError::InvalidFrame)?;
    if max_value != b"255" || width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE {
        return Err(FaceDetectionError::InvalidFrame);
    }
    let byte_count = usize::try_from(width)
        .ok()
        .and_then(|w| usize::try_from(height).ok().and_then(|h| w.checked_mul(h)))
        .and_then(|pixels| pixels.checked_mul(3))
        .ok_or(FaceDetectionError::InvalidFrame)?;
    // The PPM header ends with one required whitespace delimiter. Consume
    // exactly that delimiter so a leading whitespace-valued byte is not
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
        .checked_add(byte_count)
        .filter(|end| *end <= bytes.len())
        .ok_or(FaceDetectionError::InvalidFrame)?;
    if byte_count == 0 || byte_count > MAX_FRAME_BYTES {
        return Err(FaceDetectionError::InvalidFrame);
    }
    Ok(RgbFrame {
        width,
        height,
        pixels: bytes[cursor..end].to_vec(),
    })
}

pub(crate) fn detect_frames(
    model_dir: &Path,
    frames: &[RgbFrame],
) -> Result<Vec<DetectedFace>, FaceDetectionError> {
    let detector_path = model_dir.join(DETECTOR_MODEL_FILE);
    let recognizer_path = model_dir.join(RECOGNIZER_MODEL_FILE);
    if !detector_path.is_file() {
        return Err(FaceDetectionError::ModelUnavailable(io::Error::new(
            io::ErrorKind::NotFound,
            detector_path.display().to_string(),
        )));
    }
    if !recognizer_path.is_file() {
        return Err(FaceDetectionError::ModelUnavailable(io::Error::new(
            io::ErrorKind::NotFound,
            recognizer_path.display().to_string(),
        )));
    }

    let cache = ENGINE_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().map_err(|_| {
        FaceDetectionError::ModelInvalid(io::Error::other("face engine mutex poisoned"))
    })?;
    let needs_load = guard
        .as_ref()
        .is_none_or(|(cached_dir, _)| cached_dir != model_dir);
    if needs_load {
        let engine = load_face_engine(&detector_path, &recognizer_path)?;
        *guard = Some((model_dir.to_path_buf(), engine));
    }
    let engine = &mut guard
        .as_mut()
        .ok_or_else(|| FaceDetectionError::ModelInvalid(io::Error::other("missing face engine")))?
        .1;

    let mut detected = Vec::new();
    for frame in frames {
        detected.extend(detect_single_frame(engine, frame)?);
    }
    Ok(suppress_overlaps(detected))
}

fn load_face_engine(
    detector_path: &Path,
    recognizer_path: &Path,
) -> Result<FaceEngine, FaceDetectionError> {
    let dylib_path = std::env::var_os("ORT_DYLIB_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_ORT_DYLIB_PATH));
    let env_result = ORT_INIT.get_or_init(|| {
        if !dylib_path.is_file() {
            return Err(format!(
                "ONNX Runtime library not found at {}",
                dylib_path.display()
            ));
        }
        let builder = ort::init_from(&dylib_path)
            .map_err(|error| format!("failed to load {}: {error}", dylib_path.display()))?;
        builder
            .with_name("my-drive-face")
            .with_telemetry(false)
            .build()
            .map_err(|error| format!("failed to initialize ONNX Runtime: {error}"))
    });
    let env = match env_result {
        Ok(env) => env.clone(),
        Err(message) => {
            return Err(FaceDetectionError::ModelUnavailable(io::Error::new(
                io::ErrorKind::NotFound,
                message.clone(),
            )));
        }
    };

    let detector = build_session(&env, detector_path)?;
    let recognizer = build_session(&env, recognizer_path)?;
    Ok(FaceEngine {
        _env: env,
        detector,
        recognizer,
    })
}

fn build_session(env: &Environment, model_path: &Path) -> Result<Session, FaceDetectionError> {
    let to_invalid = |error: ort::Error<ort::session::builder::SessionBuilder>| {
        FaceDetectionError::ModelInvalid(io::Error::other(error.to_string()))
    };
    let builder = Session::builder(env)
        .map_err(|error| FaceDetectionError::ModelInvalid(io::Error::other(error.to_string())))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(to_invalid)?
        .with_intra_threads(1)
        .map_err(to_invalid)?
        .with_inter_threads(1)
        .map_err(to_invalid)?;
    let mut builder = builder;
    builder
        .commit_from_file(model_path)
        .map_err(|error| FaceDetectionError::ModelInvalid(io::Error::other(error.to_string())))
}

#[derive(Debug, Clone)]
struct ScrfdCandidate {
    x1: f32,
    y1: f32,
    x2: f32,
    y2: f32,
    score: f32,
    kps: [[f32; 2]; 5],
}

fn detect_single_frame(
    engine: &mut FaceEngine,
    frame: &RgbFrame,
) -> Result<Vec<DetectedFace>, FaceDetectionError> {
    if frame.width == 0 || frame.height == 0 || frame.pixels.len() < 3 {
        return Err(FaceDetectionError::InvalidFrame);
    }
    let (det_input, det_scale) = prepare_scrfd_input(frame);
    let det_tensor = Tensor::from_array((
        [1_usize, 3, DET_INPUT_SIZE as usize, DET_INPUT_SIZE as usize],
        det_input.into_boxed_slice(),
    ))
    .map_err(|error| FaceDetectionError::ModelInvalid(io::Error::other(error.to_string())))?;

    let outputs = engine
        .detector
        .run(ort::inputs![det_tensor])
        .map_err(|error| FaceDetectionError::ModelInvalid(io::Error::other(error.to_string())))?;
    if outputs.len() < 9 {
        return Err(FaceDetectionError::ModelInvalid(io::Error::other(
            "unexpected SCRFD output tensor count",
        )));
    }

    let mut raw_tensors: Vec<Vec<f32>> = Vec::with_capacity(9);
    for index in 0..9 {
        let (_, data) = outputs[index]
            .try_extract_tensor::<f32>()
            .map_err(|error| {
                FaceDetectionError::ModelInvalid(io::Error::other(error.to_string()))
            })?;
        raw_tensors.push(data.to_vec());
    }
    drop(outputs);

    let candidates = decode_scrfd_outputs(&raw_tensors, det_scale, MIN_DET_SCORE)?;
    let kept = nms_scrfd(candidates, NMS_IOU_THRESHOLD);

    let mut faces = Vec::new();
    for candidate in kept.into_iter().take(MAX_FACES_PER_FRAME) {
        let x1 = candidate.x1.clamp(0.0, frame.width as f32);
        let y1 = candidate.y1.clamp(0.0, frame.height as f32);
        let x2 = candidate.x2.clamp(0.0, frame.width as f32);
        let y2 = candidate.y2.clamp(0.0, frame.height as f32);
        let box_w = x2 - x1;
        let box_h = y2 - y1;
        if box_w < MIN_FACE_PIXEL_SIDE || box_h < MIN_FACE_PIXEL_SIDE {
            continue;
        }
        let aspect = (box_w / box_h).max(box_h / box_w);
        if aspect > MAX_FACE_ASPECT_RATIO {
            continue;
        }
        let aligned = align_face_arcface(frame, &candidate.kps);
        let embedding = extract_arcface_embedding(&mut engine.recognizer, aligned)?;
        let left = (x1 / frame.width as f32).clamp(0.0, 1.0);
        let top = (y1 / frame.height as f32).clamp(0.0, 1.0);
        let width = (box_w / frame.width as f32).min(1.0 - left);
        let height = (box_h / frame.height as f32).min(1.0 - top);
        if width <= 0.0 || height <= 0.0 {
            continue;
        }
        faces.push(DetectedFace {
            left,
            top,
            width,
            height,
            confidence: candidate.score.clamp(0.0, 1.0),
            descriptor: encode_embedding(&embedding),
        });
    }
    Ok(faces)
}

fn prepare_scrfd_input(frame: &RgbFrame) -> (Vec<f32>, f32) {
    let side = DET_INPUT_SIZE as usize;
    let plane_size = side * side;
    // OpenCV blobFromImage on a zero-padded 640x640 uint8 canvas normalizes
    // black padding pixels as (0.0 - 127.5) / 128.0.
    let pad_value = -127.5_f32 / 128.0_f32;
    let mut tensor = vec![pad_value; 3 * plane_size];

    let im_ratio = frame.height as f32 / frame.width as f32;
    let (new_w, new_h) = if im_ratio > 1.0 {
        let h = DET_INPUT_SIZE;
        let w = ((h as f32 / im_ratio) as u32).clamp(1, DET_INPUT_SIZE);
        (w, h)
    } else {
        let w = DET_INPUT_SIZE;
        let h = ((w as f32 * im_ratio) as u32).clamp(1, DET_INPUT_SIZE);
        (w, h)
    };
    let det_scale = new_h as f32 / frame.height as f32;

    let scale_x = frame.width as f32 / new_w as f32;
    let scale_y = frame.height as f32 / new_h as f32;
    for y in 0..new_h {
        let src_y = ((y as f32 + 0.5) * scale_y - 0.5).clamp(0.0, (frame.height - 1) as f32);
        let row_offset = y as usize * side;
        for x in 0..new_w {
            let src_x = ((x as f32 + 0.5) * scale_x - 0.5).clamp(0.0, (frame.width - 1) as f32);
            let [r, g, b] = bilinear_rgb(frame, src_x, src_y);
            let idx = row_offset + x as usize;
            tensor[idx] = (r - 127.5) / 128.0;
            tensor[plane_size + idx] = (g - 127.5) / 128.0;
            tensor[2 * plane_size + idx] = (b - 127.5) / 128.0;
        }
    }
    (tensor, det_scale)
}

fn decode_scrfd_outputs(
    outputs: &[Vec<f32>],
    det_scale: f32,
    score_threshold: f32,
) -> Result<Vec<ScrfdCandidate>, FaceDetectionError> {
    let fmc = SCRFD_STRIDES.len();
    let mut candidates = Vec::new();
    for (idx, &stride) in SCRFD_STRIDES.iter().enumerate() {
        let scores = &outputs[idx];
        let bboxes = &outputs[idx + fmc];
        let kps = &outputs[idx + fmc * 2];
        let grid_side = DET_INPUT_SIZE / stride;
        let expected_anchors = (grid_side * grid_side) as usize * SCRFD_NUM_ANCHORS;
        if scores.len() != expected_anchors
            || bboxes.len() != expected_anchors * 4
            || kps.len() != expected_anchors * 10
        {
            return Err(FaceDetectionError::ModelInvalid(io::Error::other(
                "SCRFD output tensor shape mismatch",
            )));
        }
        let stride_f = stride as f32;
        for (anchor_idx, &score) in scores.iter().enumerate() {
            if score < score_threshold {
                continue;
            }
            let cell = anchor_idx / SCRFD_NUM_ANCHORS;
            let cy = (cell as u32 / grid_side) as f32 * stride_f;
            let cx = (cell as u32 % grid_side) as f32 * stride_f;

            let bbox_base = anchor_idx * 4;
            let x1 = (cx - bboxes[bbox_base] * stride_f) / det_scale;
            let y1 = (cy - bboxes[bbox_base + 1] * stride_f) / det_scale;
            let x2 = (cx + bboxes[bbox_base + 2] * stride_f) / det_scale;
            let y2 = (cy + bboxes[bbox_base + 3] * stride_f) / det_scale;

            let kps_base = anchor_idx * 10;
            let mut points = [[0.0_f32; 2]; 5];
            for (k, point) in points.iter_mut().enumerate() {
                point[0] = (cx + kps[kps_base + k * 2] * stride_f) / det_scale;
                point[1] = (cy + kps[kps_base + k * 2 + 1] * stride_f) / det_scale;
            }
            candidates.push(ScrfdCandidate {
                x1,
                y1,
                x2,
                y2,
                score,
                kps: points,
            });
        }
    }
    Ok(candidates)
}

fn nms_scrfd(mut candidates: Vec<ScrfdCandidate>, iou_threshold: f32) -> Vec<ScrfdCandidate> {
    candidates.sort_by(|left, right| right.score.total_cmp(&left.score));
    let mut kept: Vec<ScrfdCandidate> = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let area_c = (candidate.x2 - candidate.x1 + 1.0).max(0.0)
            * (candidate.y2 - candidate.y1 + 1.0).max(0.0);
        let suppressed = kept.iter().any(|existing| {
            let xx1 = existing.x1.max(candidate.x1);
            let yy1 = existing.y1.max(candidate.y1);
            let xx2 = existing.x2.min(candidate.x2);
            let yy2 = existing.y2.min(candidate.y2);
            let w = (xx2 - xx1 + 1.0).max(0.0);
            let h = (yy2 - yy1 + 1.0).max(0.0);
            let inter = w * h;
            let area_e = (existing.x2 - existing.x1 + 1.0).max(0.0)
                * (existing.y2 - existing.y1 + 1.0).max(0.0);
            let denom = area_e + area_c - inter;
            denom > 0.0 && (inter / denom) > iou_threshold
        });
        if !suppressed {
            kept.push(candidate);
        }
    }
    kept
}

/// 2D Umeyama similarity transform mapping detected 5-point landmarks to
/// InsightFace's 112x112 canonical ArcFace alignment template.
fn estimate_arcface_affine(src: &[[f32; 2]; 5]) -> Option<[f64; 4]> {
    let mut mean_src = [0.0_f64; 2];
    let mut mean_dst = [0.0_f64; 2];
    for i in 0..5 {
        mean_src[0] += f64::from(src[i][0]);
        mean_src[1] += f64::from(src[i][1]);
        mean_dst[0] += ARCFACE_DST[i][0];
        mean_dst[1] += ARCFACE_DST[i][1];
    }
    mean_src[0] /= 5.0;
    mean_src[1] /= 5.0;
    mean_dst[0] /= 5.0;
    mean_dst[1] /= 5.0;

    let mut src_var = 0.0_f64;
    let mut num_a = 0.0_f64;
    let mut num_b = 0.0_f64;
    for i in 0..5 {
        let sx = f64::from(src[i][0]) - mean_src[0];
        let sy = f64::from(src[i][1]) - mean_src[1];
        let dx = ARCFACE_DST[i][0] - mean_dst[0];
        let dy = ARCFACE_DST[i][1] - mean_dst[1];
        src_var += sx * sx + sy * sy;
        num_a += dx * sx + dy * sy;
        num_b += dy * sx - dx * sy;
    }
    if src_var <= 1e-9 {
        return None;
    }
    let a = num_a / src_var;
    let b = num_b / src_var;
    let norm_sq = a * a + b * b;
    if norm_sq <= 1e-12 {
        return None;
    }
    let tx = mean_dst[0] - (a * mean_src[0] - b * mean_src[1]);
    let ty = mean_dst[1] - (b * mean_src[0] + a * mean_src[1]);
    Some([a, b, tx, ty])
}

fn align_face_arcface(frame: &RgbFrame, kps: &[[f32; 2]; 5]) -> Vec<f32> {
    let plane_size = ALIGN_SIZE * ALIGN_SIZE;
    let mut tensor = vec![0.0_f32; 3 * plane_size];
    let Some([a, b, tx, ty]) = estimate_arcface_affine(kps) else {
        return tensor;
    };
    let det = a * a + b * b;
    for y in 0..ALIGN_SIZE {
        let v = y as f64 - ty;
        let row_offset = y * ALIGN_SIZE;
        for x in 0..ALIGN_SIZE {
            let u = x as f64 - tx;
            let src_x = ((a * u + b * v) / det) as f32;
            let src_y = ((-b * u + a * v) / det) as f32;
            let [r, g, bl] = if src_x >= 0.0
                && src_y >= 0.0
                && src_x <= (frame.width.saturating_sub(1)) as f32
                && src_y <= (frame.height.saturating_sub(1)) as f32
            {
                bilinear_rgb(frame, src_x, src_y)
            } else {
                [0.0, 0.0, 0.0]
            };
            let idx = row_offset + x;
            tensor[idx] = (r - 127.5) / 127.5;
            tensor[plane_size + idx] = (g - 127.5) / 127.5;
            tensor[2 * plane_size + idx] = (bl - 127.5) / 127.5;
        }
    }
    tensor
}

fn extract_arcface_embedding(
    recognizer: &mut Session,
    aligned_nchw: Vec<f32>,
) -> Result<[f32; EMBEDDING_DIM], FaceDetectionError> {
    let rec_tensor = Tensor::from_array((
        [1_usize, 3, ALIGN_SIZE, ALIGN_SIZE],
        aligned_nchw.into_boxed_slice(),
    ))
    .map_err(|error| FaceDetectionError::ModelInvalid(io::Error::other(error.to_string())))?;
    let outputs = recognizer
        .run(ort::inputs![rec_tensor])
        .map_err(|error| FaceDetectionError::ModelInvalid(io::Error::other(error.to_string())))?;
    if outputs.len() == 0 {
        return Err(FaceDetectionError::ModelInvalid(io::Error::other(
            "ArcFace model returned no outputs",
        )));
    }
    let (_, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|error| FaceDetectionError::ModelInvalid(io::Error::other(error.to_string())))?;
    if data.len() != EMBEDDING_DIM {
        return Err(FaceDetectionError::ModelInvalid(io::Error::other(
            "ArcFace output length mismatch",
        )));
    }
    let mut embedding = [0.0_f32; EMBEDDING_DIM];
    embedding.copy_from_slice(data);
    if !l2_normalize(&mut embedding) {
        return Err(FaceDetectionError::ModelInvalid(io::Error::other(
            "ArcFace embedding has near-zero norm",
        )));
    }
    Ok(embedding)
}

fn bilinear_rgb(frame: &RgbFrame, x: f32, y: f32) -> [f32; 3] {
    if frame.width == 0 || frame.height == 0 || frame.pixels.len() < 3 {
        return [0.0, 0.0, 0.0];
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
    let w00 = (1.0 - tx) * (1.0 - ty);
    let w10 = tx * (1.0 - ty);
    let w01 = (1.0 - tx) * ty;
    let w11 = tx * ty;
    let sample = |px: u32, py: u32| -> [f32; 3] {
        let base = (py as usize * frame.width as usize + px as usize) * 3;
        [
            f32::from(frame.pixels.get(base).copied().unwrap_or(0)),
            f32::from(frame.pixels.get(base + 1).copied().unwrap_or(0)),
            f32::from(frame.pixels.get(base + 2).copied().unwrap_or(0)),
        ]
    };
    let p00 = sample(x0, y0);
    let p10 = sample(x1, y0);
    let p01 = sample(x0, y1);
    let p11 = sample(x1, y1);
    [
        p00[0] * w00 + p10[0] * w10 + p01[0] * w01 + p11[0] * w11,
        p00[1] * w00 + p10[1] * w10 + p01[1] * w01 + p11[1] * w11,
        p00[2] * w00 + p10[2] * w10 + p01[2] * w01 + p11[2] * w11,
    ]
}

pub(crate) fn l2_normalize(vector: &mut [f32]) -> bool {
    let norm_sq: f32 = vector.iter().map(|v| v * v).sum();
    let norm = norm_sq.sqrt();
    if !norm.is_finite() || norm < 1e-8 {
        return false;
    }
    for value in vector {
        *value /= norm;
    }
    true
}

pub(crate) fn encode_embedding(vector: &[f32; EMBEDDING_DIM]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(DESCRIPTOR_LEN);
    for &value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

pub(crate) fn decode_embedding(bytes: &[u8]) -> Option<[f32; EMBEDDING_DIM]> {
    if bytes.len() != DESCRIPTOR_LEN {
        return None;
    }
    let mut vector = [0.0_f32; EMBEDDING_DIM];
    let (chunks, _) = bytes.as_chunks::<4>();
    for (index, &chunk) in chunks.iter().enumerate() {
        let value = f32::from_le_bytes(chunk);
        if !value.is_finite() {
            return None;
        }
        vector[index] = value;
    }
    if !l2_normalize(&mut vector) {
        return None;
    }
    Some(vector)
}

pub(crate) fn cosine_similarity(left: &[f32; EMBEDDING_DIM], right: &[f32; EMBEDDING_DIM]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(a, b)| a * b)
        .sum::<f32>()
        .clamp(-1.0, 1.0)
}

pub(crate) fn blend_centroid(
    current: &[f32; EMBEDDING_DIM],
    current_weight: usize,
    addition: &[f32; EMBEDDING_DIM],
    addition_weight: usize,
) -> [f32; EMBEDDING_DIM] {
    let w1 = current_weight.max(1) as f32;
    let w2 = addition_weight.max(1) as f32;
    let mut blended = [0.0_f32; EMBEDDING_DIM];
    for i in 0..EMBEDDING_DIM {
        blended[i] = current[i] * w1 + addition[i] * w2;
    }
    if !l2_normalize(&mut blended) {
        return *current;
    }
    blended
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
        ARCFACE_DST, DESCRIPTOR_LEN, DetectedFace, EMBEDDING_DIM, MAX_FRAME_SIDE, blend_centroid,
        cosine_similarity, decode_embedding, encode_embedding, estimate_arcface_affine, parse_ppm,
        suppress_overlaps,
    };

    #[test]
    fn parses_bounded_binary_ppm_with_comments() {
        let bytes = b"P6\n# generated\n2 1\n255\n\x01\x02\x03\xff\x80\x00";
        let frame = parse_ppm(bytes).unwrap();
        assert_eq!((frame.width, frame.height), (2, 1));
        assert_eq!(frame.pixels, [1, 2, 3, 255, 128, 0]);
    }

    #[test]
    fn accepts_crlf_ppm_headers_without_dropping_pixels() {
        let frame = parse_ppm(b"P6\r\n1 1\r\n255\r\n\x20\x40\xff").unwrap();
        assert_eq!(frame.pixels, [0x20, 0x40, 0xff]);
    }

    #[test]
    fn rejects_wrong_format_and_oversized_frames() {
        assert!(parse_ppm(b"P5\n1 1\n255\n0").is_err());
        let header = format!("P6\n{} 1\n255\n", MAX_FRAME_SIDE + 1);
        assert!(parse_ppm(header.as_bytes()).is_err());
    }

    #[test]
    fn embedding_round_trips_and_computes_cosine_similarity() {
        let mut a = [0.0_f32; EMBEDDING_DIM];
        a[0] = 1.0;
        let mut b = [0.0_f32; EMBEDDING_DIM];
        b[0] = 0.6;
        b[1] = 0.8;
        let bytes_a = encode_embedding(&a);
        assert_eq!(bytes_a.len(), DESCRIPTOR_LEN);
        let decoded_a = decode_embedding(&bytes_a).unwrap();
        assert!((cosine_similarity(&decoded_a, &b) - 0.6).abs() < 1e-5);
        let blended = blend_centroid(&decoded_a, 1, &b, 1);
        let norm: f32 = blended.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
        assert!(decode_embedding(&[0_u8; 256]).is_none());
    }

    #[test]
    fn umeyama_affine_recovers_exact_similarity_transform() {
        let scale = 2.0_f32;
        let offset = [15.0_f32, 24.0_f32];
        let mut src = [[0.0_f32; 2]; 5];
        for i in 0..5 {
            src[i][0] = ARCFACE_DST[i][0] as f32 * scale + offset[0];
            src[i][1] = ARCFACE_DST[i][1] as f32 * scale + offset[1];
        }
        let [a, b, tx, ty] = estimate_arcface_affine(&src).unwrap();
        assert!((a - 0.5).abs() < 1e-6);
        assert!(b.abs() < 1e-6);
        assert!((tx + 7.5).abs() < 1e-5);
        assert!((ty + 12.0).abs() < 1e-5);
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
