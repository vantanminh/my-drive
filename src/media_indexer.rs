use std::{
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use thiserror::Error;
use tokio::{
    fs as tokio_fs,
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{sleep, timeout},
};
use uuid::Uuid;

use crate::{
    face_indexer::{self, DEFAULT_MODEL_PATH, FaceDetectionError},
    storage::{LocalStorage, PreviewStorage, StorageError},
};

const WORKER_LOCK_ID: i64 = 4_831_170_923_501;
const POLL_INTERVAL: Duration = Duration::from_secs(5);
const LEASE_SECONDS: i64 = 300;
const TOOL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ATTEMPTS: i32 = 5;
const MAX_SOURCE_BYTES: i64 = 100 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: u64 = 24 * 1024 * 1024;
const CARD_MAX_BYTES: usize = 512 * 1024;
const VIEWER_MAX_BYTES: usize = 4 * 1024 * 1024;
const VIDEO_POSTER_MAX_BYTES: usize = 512 * 1024;

#[derive(Debug, Error)]
enum WorkerError {
    #[error("database operation failed: {0}")]
    Database(#[from] sqlx::Error),
    #[error("storage operation failed: {0}")]
    Storage(#[from] StorageError),
    #[error("temporary file operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("source object does not match its committed version")]
    SourceMismatch,
    #[error("source object exceeds the configured byte limit")]
    SourceTooLarge,
}

#[derive(Debug, FromRow)]
struct ClaimedJob {
    id: i64,
    file_version_id: Uuid,
    owner_id: Uuid,
    task: String,
    version_size_bytes: i64,
    object_size_bytes: Option<i64>,
    storage_key: Option<String>,
    mime_detected: Option<String>,
    object_checksum_sha256: Option<String>,
    object_state: Option<String>,
    attempts: i32,
}

#[derive(Clone, Copy)]
enum FailureClass {
    Unsupported,
    Permanent,
    Retryable,
}

struct JobFailure {
    class: FailureClass,
    code: &'static str,
}

struct GeneratedDerivative {
    variant: &'static str,
    width: i32,
    height: i32,
    bytes: Vec<u8>,
    checksum: String,
}

struct TempPath(PathBuf);

impl TempPath {
    fn create(extension: &str) -> io::Result<Self> {
        for _ in 0..8 {
            let path = std::env::temp_dir().join(format!(
                "my-drive-media-{}.{}",
                Uuid::new_v4(),
                extension
            ));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => {
                    drop(file);
                    return Ok(Self(path));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a unique image-index temporary file",
        ))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempPath {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(crate) async fn run_worker(pool: PgPool, storage: LocalStorage, previews: PreviewStorage) {
    loop {
        let mut lock_connection = match pool.acquire().await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::warn!(error = %error, "media index worker cannot connect to PostgreSQL");
                sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        let lock_acquired = match sqlx::query_scalar::<_, bool>("SELECT pg_try_advisory_lock($1)")
            .bind(WORKER_LOCK_ID)
            .fetch_one(&mut *lock_connection)
            .await
        {
            Ok(acquired) => acquired,
            Err(error) => {
                tracing::warn!(error = %error, "media index worker could not acquire its singleton lock");
                drop(lock_connection);
                sleep(POLL_INTERVAL).await;
                continue;
            }
        };
        if !lock_acquired {
            tracing::warn!("another media index worker holds the singleton lock");
            drop(lock_connection);
            sleep(POLL_INTERVAL).await;
            continue;
        }

        tracing::info!("media index worker acquired its singleton lock");
        loop {
            if let Err(error) = sqlx::query_scalar::<_, i32>("SELECT 1")
                .fetch_one(&mut *lock_connection)
                .await
            {
                tracing::warn!(error = %error, "media index singleton lock connection was lost");
                break;
            }
            match run_once(&pool, &storage, &previews).await {
                Ok(true) => {}
                Ok(false) => sleep(POLL_INTERVAL).await,
                Err(error) => {
                    tracing::warn!(error = %error, "media index worker pass failed");
                    sleep(POLL_INTERVAL).await;
                }
            }
        }
        drop(lock_connection);
    }
}

async fn run_once(
    pool: &PgPool,
    storage: &LocalStorage,
    previews: &PreviewStorage,
) -> Result<bool, WorkerError> {
    storage.ensure_mounted()?;
    previews.health()?;
    backfill_batch(pool).await?;
    fail_exhausted_leases(pool).await?;
    let Some(job) = claim_one(pool).await? else {
        return Ok(false);
    };

    let heartbeat_pool = pool.clone();
    let job_id = job.id;
    let attempt = job.attempts;
    let heartbeat = tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(30)).await;
            match sqlx::query(
                "UPDATE media_index_jobs \
                    SET lease_expires_at = now() + ($3::BIGINT * interval '1 second'), \
                        updated_at = now() \
                  WHERE id = $1 AND state = 'running' AND attempts = $2",
            )
            .bind(job_id)
            .bind(attempt)
            .bind(LEASE_SECONDS)
            .execute(&heartbeat_pool)
            .await
            {
                Ok(result) if result.rows_affected() == 1 => {}
                Ok(_) => break,
                Err(error) => {
                    tracing::warn!(job_id, error = %error, "media index lease heartbeat failed");
                }
            }
        }
    });
    let processing = process_job(pool, storage, previews, &job).await;
    heartbeat.abort();
    let _ = heartbeat.await;
    match processing {
        Ok(()) => tracing::info!(job_id = job.id, task = %job.task, "media indexing completed"),
        Err(failure) => {
            tracing::warn!(
                job_id = job.id,
                task = %job.task,
                error_code = failure.code,
                "media indexing failed"
            );
            record_failure(pool, &job, failure).await?;
        }
    }
    Ok(true)
}

async fn backfill_batch(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO media_index_jobs (file_version_id, task, recipe_version) \
         SELECT version.id, CASE \
                 WHEN object.mime_detected IN \
                     ('image/jpeg', 'image/png', 'image/webp', 'image/gif', \
                      'image/avif', 'image/bmp', 'image/x-icon', 'image/tiff', \
                      'image/heic', 'image/heif') \
                 THEN 'image_preview' ELSE 'video_thumbnail' END, 1 \
           FROM file_versions AS version \
           JOIN files AS file ON file.current_version_id = version.id \
           JOIN drive_entries AS entry ON entry.id = file.id \
           JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE entry.deleted_at IS NULL \
            AND object.state = 'ready' \
             AND object.mime_detected IN \
                 ('image/jpeg', 'image/png', 'image/webp', 'image/gif', \
                  'image/avif', 'image/bmp', 'image/x-icon', 'image/tiff', \
                  'image/heic', 'image/heif', \
                  'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', \
                  'video/x-msvideo', 'video/ogg', 'video/mpeg', 'video/mp2t', \
                  'video/x-flv', 'video/x-ms-wmv', 'video/3gpp') \
            AND NOT EXISTS ( \
                SELECT 1 FROM media_index_jobs AS existing \
                   WHERE existing.file_version_id = version.id \
                    AND existing.task = CASE \
                        WHEN object.mime_detected IN \
                            ('image/jpeg', 'image/png', 'image/webp', 'image/gif', \
                             'image/avif', 'image/bmp', 'image/x-icon', 'image/tiff', \
                             'image/heic', 'image/heif') \
                        THEN 'image_preview' ELSE 'video_thumbnail' END \
                    AND existing.recipe_version = 1 \
            ) \
          ORDER BY version.created_at, version.id \
          LIMIT 100 \
         ON CONFLICT (file_version_id, task, recipe_version) DO NOTHING",
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO media_index_jobs (file_version_id, task, recipe_version) \
         SELECT version.id, 'face_index', 1 \
           FROM file_versions AS version \
           JOIN files AS file ON file.current_version_id = version.id \
           JOIN drive_entries AS entry ON entry.id = file.id \
           JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE entry.deleted_at IS NULL \
            AND object.state = 'ready' \
            AND object.mime_detected IN ( \
                'image/jpeg', 'image/png', 'image/gif', 'image/webp', \
                'image/avif', 'image/bmp', 'image/x-icon', 'image/tiff', \
                'image/heic', 'image/heif', \
                 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', \
                 'video/x-msvideo', 'video/ogg', 'video/mpeg', 'video/mp2t', \
                 'video/x-flv', 'video/x-ms-wmv', 'video/3gpp' \
            ) \
            AND NOT EXISTS ( \
                SELECT 1 FROM media_index_jobs AS existing \
                 WHERE existing.file_version_id = version.id \
                   AND existing.task = 'face_index' \
                   AND existing.recipe_version = 1 \
            ) \
          ORDER BY version.created_at, version.id \
          LIMIT 100 \
         ON CONFLICT (file_version_id, task, recipe_version) DO NOTHING",
    )
    .execute(pool)
    .await?;
    Ok(())
}

async fn fail_exhausted_leases(pool: &PgPool) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE media_index_jobs \
            SET state = 'failed', lease_expires_at = NULL, current_stage = NULL, \
                error_code = 'decode_failed', last_error_at = now(), updated_at = now() \
          WHERE task IN ('image_preview', 'video_thumbnail', 'face_index') AND state = 'running' \
            AND lease_expires_at <= now() AND attempts >= $1",
    )
    .bind(MAX_ATTEMPTS)
    .execute(pool)
    .await?;
    Ok(())
}

async fn claim_one(pool: &PgPool) -> Result<Option<ClaimedJob>, sqlx::Error> {
    sqlx::query_as::<_, ClaimedJob>(
        "WITH candidate AS ( \
             SELECT job.id \
               FROM media_index_jobs AS job \
              WHERE job.task IN ('image_preview', 'video_thumbnail', 'face_index') AND job.attempts < $1 \
                AND ( \
                    (job.state IN ('queued', 'retry_wait') AND job.available_at <= now()) \
                    OR (job.state = 'running' AND job.lease_expires_at <= now()) \
                ) \
                AND EXISTS (SELECT 1 FROM media_index_control WHERE singleton = TRUE AND paused = FALSE) \
              ORDER BY COALESCE(job.lease_expires_at, job.available_at), job.id \
              LIMIT 1 FOR UPDATE SKIP LOCKED \
         ) \
         UPDATE media_index_jobs AS job \
            SET state = 'running', attempts = job.attempts + 1, available_at = now(), \
                lease_expires_at = now() + ($2::BIGINT * interval '1 second'), \
                current_stage = 'opening_source', processed_bytes = 0, error_code = NULL, \
                last_error_at = NULL, updated_at = now() \
           FROM candidate, file_versions AS version \
           JOIN drive_entries AS entry ON entry.id = version.file_id \
           LEFT JOIN storage_objects AS object ON object.id = version.storage_object_id \
          WHERE job.id = candidate.id AND version.id = job.file_version_id \
         RETURNING job.id, job.file_version_id, entry.owner_id, job.task, version.size_bytes AS version_size_bytes, \
                   object.size_bytes AS object_size_bytes, object.storage_key, \
                   object.mime_detected, object.checksum_sha256 AS object_checksum_sha256, \
                   object.state AS object_state, job.attempts",
    )
    .bind(MAX_ATTEMPTS)
    .bind(LEASE_SECONDS)
    .fetch_optional(pool)
    .await
}

async fn process_job(
    pool: &PgPool,
    storage: &LocalStorage,
    previews: &PreviewStorage,
    job: &ClaimedJob,
) -> Result<(), JobFailure> {
    match job.task.as_str() {
        "image_preview" => process_image_job(pool, storage, previews, job).await,
        "video_thumbnail" => process_video_job(pool, storage, previews, job).await,
        "face_index" => process_face_job(pool, storage, job).await,
        _ => Err(unsupported("unsupported_format")),
    }
}

async fn process_image_job(
    pool: &PgPool,
    storage: &LocalStorage,
    previews: &PreviewStorage,
    job: &ClaimedJob,
) -> Result<(), JobFailure> {
    let mime = job
        .mime_detected
        .as_deref()
        .ok_or_else(|| unsupported("unsupported_format"))?;
    if !supports_image_mime(mime) {
        return Err(unsupported("unsupported_format"));
    }
    let (input_path, actual_size) = prepare_source(pool, storage, job, mime).await?;

    set_stage(pool, job, "checking_dimensions", actual_size)
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;
    let mut generated = Vec::with_capacity(2);
    let mut viewer_png: Option<TempPath> = None;
    for (variant, side, maximum_bytes) in [
        ("viewer", 1920_u32, VIEWER_MAX_BYTES),
        ("card", 384_u32, CARD_MAX_BYTES),
    ] {
        set_stage(pool, job, &format!("thumbnailing_{variant}"), actual_size)
            .await
            .map_err(|_| retryable("preview_storage_unavailable"))?;
        let thumbnail =
            TempPath::create("png").map_err(|_| retryable("preview_storage_unavailable"))?;
        let output =
            TempPath::create("webp").map_err(|_| retryable("preview_storage_unavailable"))?;
        let thumbnail_input = viewer_png
            .as_ref()
            .map_or(input_path.path(), TempPath::path);
        thumbnail_to_png(thumbnail_input, thumbnail.path(), side, mime)
            .await
            .map_err(map_decode_tool_error)?;
        let thumbnail_size = tokio_fs::metadata(thumbnail.path())
            .await
            .map_err(|_| retryable("preview_storage_unavailable"))?
            .len();
        if thumbnail_size == 0 || thumbnail_size > MAX_THUMBNAIL_BYTES {
            return Err(unsupported("resource_limit"));
        }
        encode_webp(thumbnail.path(), output.path())
            .await
            .map_err(map_decode_tool_error)?;
        let output_size = tokio_fs::metadata(output.path())
            .await
            .map_err(|_| retryable("preview_storage_unavailable"))?
            .len();
        if output_size == 0 || output_size > maximum_bytes as u64 {
            return Err(unsupported("resource_limit"));
        }
        let bytes = tokio_fs::read(output.path())
            .await
            .map_err(|_| retryable("preview_storage_unavailable"))?;
        let (width, height) = validate_metadata_free_webp(&bytes, maximum_bytes)
            .map_err(|_| permanent("decode_failed"))?;
        if width > side || height > side {
            return Err(permanent("decode_failed"));
        }
        if variant == "viewer" {
            viewer_png = Some(thumbnail);
        }
        generated.push(GeneratedDerivative {
            variant,
            width: i32::try_from(width).map_err(|_| unsupported("resource_limit"))?,
            height: i32::try_from(height).map_err(|_| unsupported("resource_limit"))?,
            checksum: format!("{:x}", Sha256::digest(&bytes)),
            bytes,
        });
    }

    publish_and_complete(pool, previews, job, actual_size, &generated).await
}

async fn process_video_job(
    pool: &PgPool,
    storage: &LocalStorage,
    previews: &PreviewStorage,
    job: &ClaimedJob,
) -> Result<(), JobFailure> {
    let mime = job
        .mime_detected
        .as_deref()
        .ok_or_else(|| unsupported("unsupported_format"))?;
    if !supports_video_mime(mime) {
        return Err(unsupported("unsupported_format"));
    }
    let (input_path, actual_size) = prepare_source(pool, storage, job, mime).await?;
    set_stage(pool, job, "extracting_video_poster", actual_size)
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;

    let frame = TempPath::create("png").map_err(|_| retryable("preview_storage_unavailable"))?;
    extract_video_frame(input_path.path(), frame.path())
        .await
        .map_err(|error| {
            tracing::warn!(job_id = job.id, error = ?error, "video frame extraction failed");
            map_decode_tool_error(error)
        })?;
    let frame_size = tokio_fs::metadata(frame.path())
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?
        .len();
    if frame_size == 0 || frame_size > MAX_THUMBNAIL_BYTES {
        return Err(unsupported("resource_limit"));
    }

    set_stage(pool, job, "encoding_video_poster", actual_size)
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;
    let output = TempPath::create("webp").map_err(|_| retryable("preview_storage_unavailable"))?;
    encode_webp(frame.path(), output.path())
        .await
        .map_err(|error| {
            tracing::warn!(job_id = job.id, error = ?error, "video poster encoding failed");
            map_decode_tool_error(error)
        })?;
    let bytes = tokio_fs::read(output.path())
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;
    let (width, height) =
        validate_metadata_free_webp(&bytes, VIDEO_POSTER_MAX_BYTES).map_err(|_| {
            tracing::warn!(job_id = job.id, "video poster WebP validation failed");
            permanent("decode_failed")
        })?;
    if width > 384 || height > 384 {
        return Err(permanent("decode_failed"));
    }
    let generated = [GeneratedDerivative {
        variant: "video_poster",
        width: i32::try_from(width).map_err(|_| unsupported("resource_limit"))?,
        height: i32::try_from(height).map_err(|_| unsupported("resource_limit"))?,
        checksum: format!("{:x}", Sha256::digest(&bytes)),
        bytes,
    }];
    publish_and_complete(pool, previews, job, actual_size, &generated).await
}

async fn process_face_job(
    pool: &PgPool,
    storage: &LocalStorage,
    job: &ClaimedJob,
) -> Result<(), JobFailure> {
    let mime = job
        .mime_detected
        .as_deref()
        .ok_or_else(|| unsupported("unsupported_format"))?;
    if !supports_image_mime(mime) && !supports_video_mime(mime) {
        return Err(unsupported("unsupported_format"));
    }
    let (input_path, actual_size) = prepare_source(pool, storage, job, mime).await?;
    set_stage(pool, job, "extracting_face_frame", actual_size)
        .await
        .map_err(|_| retryable("face_index_unavailable"))?;
    let frame_path = TempPath::create("pgm").map_err(|_| retryable("face_index_unavailable"))?;
    extract_gray_frame(input_path.path(), frame_path.path())
        .await
        .map_err(|error| {
            tracing::warn!(job_id = job.id, error = ?error, "face frame extraction failed");
            map_face_tool_error(error)
        })?;
    let frame_bytes = tokio_fs::read(frame_path.path())
        .await
        .map_err(|_| retryable("face_index_unavailable"))?;
    let model_path = std::env::var_os("FACE_DETECTOR_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_MODEL_PATH));
    set_stage(pool, job, "detecting_faces", actual_size)
        .await
        .map_err(|_| retryable("face_index_unavailable"))?;
    let detections = tokio::task::spawn_blocking(move || {
        let frame = face_indexer::parse_pgm(&frame_bytes)?;
        face_indexer::detect(&model_path, frame)
    })
    .await
    .map_err(|_| retryable("face_index_unavailable"))?
    .map_err(map_face_detection_error)?;

    if !owns_lease(pool, job).await.unwrap_or(false) {
        return Err(retryable("face_index_unavailable"));
    }
    let mut transaction = pool
        .begin()
        .await
        .map_err(|_| retryable("face_index_unavailable"))?;
    let completed = sqlx::query(
        "UPDATE media_index_jobs \
            SET state = 'completed', lease_expires_at = NULL, current_stage = NULL, \
                processed_bytes = $3, error_code = NULL, completed_at = now(), updated_at = now() \
          WHERE id = $1 AND task = 'face_index' AND state = 'running' AND attempts = $2",
    )
    .bind(job.id)
    .bind(job.attempts)
    .bind(actual_size as i64)
    .execute(&mut *transaction)
    .await
    .map_err(|_| retryable("face_index_unavailable"))?;
    if completed.rows_affected() != 1 {
        transaction
            .rollback()
            .await
            .map_err(|_| retryable("face_index_unavailable"))?;
        return Err(retryable("face_index_unavailable"));
    }
    for (face_index, face) in detections.iter().enumerate() {
        let cluster_id = Uuid::new_v4();
        sqlx::query("INSERT INTO face_clusters (id, owner_id) VALUES ($1, $2)")
            .bind(cluster_id)
            .bind(job.owner_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| retryable("face_index_unavailable"))?;
        sqlx::query(
            "INSERT INTO face_observations \
             (file_version_id, cluster_id, recipe_version, face_index, confidence, \
              box_left, box_top, box_width, box_height) \
             VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8)",
        )
        .bind(job.file_version_id)
        .bind(cluster_id)
        .bind(i16::try_from(face_index).unwrap_or(i16::MAX))
        .bind(face.confidence)
        .bind(face.left)
        .bind(face.top)
        .bind(face.width)
        .bind(face.height)
        .execute(&mut *transaction)
        .await
        .map_err(|_| retryable("face_index_unavailable"))?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| retryable("face_index_unavailable"))?;
    Ok(())
}

async fn prepare_source(
    pool: &PgPool,
    storage: &LocalStorage,
    job: &ClaimedJob,
    mime: &str,
) -> Result<(TempPath, u64), JobFailure> {
    if job.object_state.as_deref() != Some("ready") {
        return Err(permanent("input_missing"));
    }
    if job.version_size_bytes != job.object_size_bytes.unwrap_or(-1) || job.version_size_bytes <= 0
    {
        return Err(permanent("input_missing"));
    }
    if job.version_size_bytes > MAX_SOURCE_BYTES {
        return Err(unsupported("resource_limit"));
    }
    if !supports_image_mime(mime) && !supports_video_mime(mime) {
        return Err(unsupported("unsupported_format"));
    }
    let storage_key = job
        .storage_key
        .as_deref()
        .ok_or_else(|| permanent("input_missing"))?;

    let input_extension = media_extension(mime).ok_or_else(|| unsupported("unsupported_format"))?;
    let input_path =
        TempPath::create(input_extension).map_err(|_| retryable("preview_storage_unavailable"))?;
    let (actual_size, checksum, prefix) =
        copy_source(pool, storage, job, storage_key, input_path.path())
            .await
            .map_err(|error| match error {
                WorkerError::Storage(StorageError::Io(error))
                    if error.kind() == io::ErrorKind::NotFound =>
                {
                    permanent("input_missing")
                }
                WorkerError::SourceMismatch => permanent("input_missing"),
                WorkerError::SourceTooLarge => unsupported("resource_limit"),
                _ => retryable("preview_storage_unavailable"),
            })?;
    if actual_size != job.version_size_bytes as u64 {
        return Err(permanent("input_missing"));
    }
    if job
        .object_checksum_sha256
        .as_deref()
        .is_none_or(|expected| !checksum.eq_ignore_ascii_case(expected))
    {
        return Err(permanent("decode_failed"));
    }
    if !matches_magic(mime, &prefix) {
        return Err(permanent("decode_failed"));
    }

    Ok((input_path, actual_size))
}

async fn publish_and_complete(
    pool: &PgPool,
    previews: &PreviewStorage,
    job: &ClaimedJob,
    actual_size: u64,
    generated: &[GeneratedDerivative],
) -> Result<(), JobFailure> {
    for derivative in generated {
        if !owns_lease(pool, job).await.unwrap_or(false) {
            return Err(retryable("preview_storage_unavailable"));
        }
        set_stage(
            pool,
            job,
            &format!("publishing_{}", derivative.variant),
            actual_size,
        )
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;
        previews
            .publish_derivative(
                job.file_version_id,
                derivative.variant,
                1,
                &derivative.bytes,
            )
            .await
            .map_err(|_| retryable("preview_storage_unavailable"))?;
    }

    let mut transaction = pool
        .begin()
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;
    let completed = sqlx::query(
        "UPDATE media_index_jobs \
            SET state = 'completed', lease_expires_at = NULL, current_stage = NULL, \
                processed_bytes = $4, error_code = NULL, completed_at = now(), updated_at = now() \
          WHERE id = $1 AND task = $3 AND state = 'running' AND attempts = $2",
    )
    .bind(job.id)
    .bind(job.attempts)
    .bind(&job.task)
    .bind(actual_size as i64)
    .execute(&mut *transaction)
    .await
    .map_err(|_| retryable("preview_storage_unavailable"))?;
    if completed.rows_affected() != 1 {
        transaction
            .rollback()
            .await
            .map_err(|_| retryable("preview_storage_unavailable"))?;
        return Err(retryable("preview_storage_unavailable"));
    }
    for derivative in generated {
        sqlx::query(
            "SELECT public.media_indexer_upsert_derivative( \
                $1, $2, 1::smallint, $3, 'image/webp', $4, $5, $6, $7 \
             )",
        )
        .bind(job.file_version_id)
        .bind(derivative.variant)
        .bind(format!(
            "{}/{derivative_variant}-v1.webp",
            job.file_version_id,
            derivative_variant = derivative.variant
        ))
        .bind(i64::try_from(derivative.bytes.len()).unwrap_or(i64::MAX))
        .bind(derivative.width)
        .bind(derivative.height)
        .bind(&derivative.checksum)
        .execute(&mut *transaction)
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;
    }
    transaction
        .commit()
        .await
        .map_err(|_| retryable("preview_storage_unavailable"))?;
    Ok(())
}

async fn copy_source(
    pool: &PgPool,
    storage: &LocalStorage,
    job: &ClaimedJob,
    storage_key: &str,
    destination: &Path,
) -> Result<(u64, String, Vec<u8>), WorkerError> {
    let mut source = storage.open_object(storage_key).await?;
    let source_metadata = source.metadata().await?;
    if source_metadata.len() != job.version_size_bytes as u64
        || source_metadata.len() > MAX_SOURCE_BYTES as u64
    {
        return Err(if source_metadata.len() > MAX_SOURCE_BYTES as u64 {
            WorkerError::SourceTooLarge
        } else {
            WorkerError::SourceMismatch
        });
    }
    let mut output = tokio_fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(destination)
        .await?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut last_reported = 0_u64;
    let mut prefix = Vec::with_capacity(512);
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = source.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > MAX_SOURCE_BYTES as u64 {
            return Err(WorkerError::SourceTooLarge);
        }
        hasher.update(&buffer[..read]);
        if prefix.len() < 512 {
            let needed = 512 - prefix.len();
            prefix.extend_from_slice(&buffer[..read.min(needed)]);
        }
        output.write_all(&buffer[..read]).await?;
        if total - last_reported >= 4 * 1024 * 1024 {
            set_stage(pool, job, "copying_source", total)
                .await
                .map_err(|error| WorkerError::Database(sqlx::Error::Protocol(error.to_string())))?;
            last_reported = total;
        }
    }
    output.sync_all().await?;
    set_stage(pool, job, "checking_dimensions", total)
        .await
        .map_err(|error| WorkerError::Database(sqlx::Error::Protocol(error.to_string())))?;
    Ok((total, format!("{:x}", hasher.finalize()), prefix))
}

async fn set_stage(
    pool: &PgPool,
    job: &ClaimedJob,
    stage: &str,
    processed_bytes: u64,
) -> Result<(), sqlx::Error> {
    let result = sqlx::query(
        "UPDATE media_index_jobs \
            SET current_stage = $3, processed_bytes = $4, \
                lease_expires_at = now() + ($5::BIGINT * interval '1 second'), updated_at = now() \
          WHERE id = $1 AND state = 'running' AND attempts = $2",
    )
    .bind(job.id)
    .bind(job.attempts)
    .bind(stage)
    .bind(i64::try_from(processed_bytes).unwrap_or(i64::MAX))
    .bind(LEASE_SECONDS)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(sqlx::Error::Protocol(
            "media index job lease was lost".to_owned(),
        ));
    }
    Ok(())
}

async fn owns_lease(pool: &PgPool, job: &ClaimedJob) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM media_index_jobs \
          WHERE id = $1 AND state = 'running' AND attempts = $2 \
            AND lease_expires_at > now())",
    )
    .bind(job.id)
    .bind(job.attempts)
    .fetch_one(pool)
    .await
}

async fn record_failure(
    pool: &PgPool,
    job: &ClaimedJob,
    failure: JobFailure,
) -> Result<(), sqlx::Error> {
    let (state, delay) = match failure.class {
        FailureClass::Unsupported => ("unsupported", 0_i64),
        FailureClass::Permanent => ("failed", 0_i64),
        FailureClass::Retryable if job.attempts >= MAX_ATTEMPTS => ("failed", 0_i64),
        FailureClass::Retryable => {
            let exponent = u32::try_from(job.attempts.saturating_sub(1))
                .unwrap_or(0)
                .min(8);
            ("retry_wait", 10_i64.saturating_mul(1_i64 << exponent))
        }
    };
    sqlx::query(
        "UPDATE media_index_jobs \
            SET state = $3, available_at = now() + ($4::BIGINT * interval '1 second'), \
                lease_expires_at = NULL, current_stage = NULL, processed_bytes = 0, \
                error_code = $5, last_error_at = now(), updated_at = now() \
          WHERE id = $1 AND state = 'running' AND attempts = $2",
    )
    .bind(job.id)
    .bind(job.attempts)
    .bind(state)
    .bind(delay)
    .bind(failure.code)
    .execute(pool)
    .await?;
    Ok(())
}

async fn thumbnail_to_png(
    input: &Path,
    output: &Path,
    side: u32,
    mime: &str,
) -> Result<(), ToolError> {
    let mut command = Command::new("my-drive-vips-thumbnailer");
    command
        .arg(input)
        .arg(output)
        .arg(side.to_string())
        .env("VIPS_CONCURRENCY", "1")
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let result = timeout(TOOL_TIMEOUT, command.status())
        .await
        .map_err(|_| ToolError::TimedOut)?
        .map_err(|_| ToolError::Failed)?;
    if result.success() {
        Ok(())
    } else if result.code() == Some(3) {
        Err(ToolError::ResourceLimit)
    } else if supports_ffmpeg_image_mime(mime) {
        thumbnail_to_png_with_ffmpeg(input, output, side).await
    } else {
        Err(ToolError::Failed)
    }
}

async fn thumbnail_to_png_with_ffmpeg(
    input: &Path,
    output: &Path,
    side: u32,
) -> Result<(), ToolError> {
    let input = input.to_str().ok_or(ToolError::InvalidOutput)?;
    let output = output.to_str().ok_or(ToolError::InvalidOutput)?;
    let scale = format!("scale={side}:{side}:force_original_aspect_ratio=decrease");
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-filter_complex_threads",
            "1",
            "-max_alloc",
            "134217728",
            "-probesize",
            "1M",
            "-analyzeduration",
            "2M",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            &scale,
            "-f",
            "image2",
            "-y",
            output,
        ])
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let result = timeout(TOOL_TIMEOUT, command.status())
        .await
        .map_err(|_| ToolError::TimedOut)?
        .map_err(|_| ToolError::Failed)?;
    if result.success() {
        Ok(())
    } else {
        Err(ToolError::Failed)
    }
}

async fn extract_video_frame(input: &Path, output: &Path) -> Result<(), ToolError> {
    let input = input.to_str().ok_or(ToolError::InvalidOutput)?;
    let output = output.to_str().ok_or(ToolError::InvalidOutput)?;
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-probesize",
            "1M",
            "-analyzeduration",
            "2M",
            "-ss",
            "0",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=384:384:force_original_aspect_ratio=decrease",
            "-threads:v",
            "1",
            "-f",
            "image2",
            "-y",
            output,
        ])
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let result = timeout(TOOL_TIMEOUT, command.status())
        .await
        .map_err(|_| ToolError::TimedOut)?
        .map_err(|_| ToolError::Failed)?;
    if result.success() {
        Ok(())
    } else {
        Err(ToolError::Failed)
    }
}

async fn extract_gray_frame(input: &Path, output: &Path) -> Result<(), ToolError> {
    let input = input.to_str().ok_or(ToolError::InvalidOutput)?;
    let output = output.to_str().ok_or(ToolError::InvalidOutput)?;
    let mut command = Command::new("ffmpeg");
    command
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-filter_complex_threads",
            "1",
            "-max_alloc",
            "134217728",
            "-probesize",
            "1M",
            "-analyzeduration",
            "2M",
            "-ss",
            "0",
            "-i",
            input,
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=1280:1280:force_original_aspect_ratio=decrease,format=gray",
            "-pix_fmt",
            "gray",
            "-f",
            "image2",
            "-y",
            output,
        ])
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let result = timeout(TOOL_TIMEOUT, command.status())
        .await
        .map_err(|_| ToolError::TimedOut)?
        .map_err(|_| ToolError::Failed)?;
    if result.success() {
        Ok(())
    } else {
        Err(ToolError::Failed)
    }
}

async fn encode_webp(input: &Path, output: &Path) -> Result<(), ToolError> {
    let input = input.to_str().ok_or(ToolError::InvalidOutput)?;
    let output = output.to_str().ok_or(ToolError::InvalidOutput)?;
    let mut command = Command::new("cwebp");
    command
        .args([
            "-quiet",
            "-q",
            "75",
            "-alpha_q",
            "100",
            "-m",
            "0",
            "-metadata",
            "none",
            input,
            "-o",
            output,
        ])
        .kill_on_drop(true)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let result = timeout(TOOL_TIMEOUT, command.status())
        .await
        .map_err(|_| ToolError::TimedOut)?
        .map_err(|_| ToolError::Failed)?;
    if result.success() {
        Ok(())
    } else {
        Err(ToolError::Failed)
    }
}

#[derive(Debug)]
enum ToolError {
    TimedOut,
    Failed,
    InvalidOutput,
    ResourceLimit,
}

fn map_decode_tool_error(error: ToolError) -> JobFailure {
    match error {
        ToolError::TimedOut | ToolError::ResourceLimit => unsupported("resource_limit"),
        ToolError::Failed | ToolError::InvalidOutput => permanent("decode_failed"),
    }
}

fn map_face_tool_error(error: ToolError) -> JobFailure {
    match error {
        ToolError::TimedOut | ToolError::ResourceLimit => unsupported("resource_limit"),
        ToolError::Failed | ToolError::InvalidOutput => permanent("decode_failed"),
    }
}

fn map_face_detection_error(error: FaceDetectionError) -> JobFailure {
    match error {
        FaceDetectionError::ModelUnavailable(_) | FaceDetectionError::ModelInvalid(_) => {
            unsupported("detector_unavailable")
        }
        FaceDetectionError::InvalidFrame => permanent("decode_failed"),
    }
}

fn matches_magic(mime: &str, prefix: &[u8]) -> bool {
    match mime {
        "image/jpeg" => prefix.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => prefix.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/gif" => prefix.starts_with(b"GIF87a") || prefix.starts_with(b"GIF89a"),
        "image/webp" => prefix.len() >= 12 && &prefix[..4] == b"RIFF" && &prefix[8..12] == b"WEBP",
        "image/avif" => {
            prefix.get(4..8) == Some(b"ftyp")
                && prefix
                    .windows(4)
                    .any(|value| value == b"avif" || value == b"avis")
        }
        "image/bmp" => prefix.starts_with(b"BM"),
        "image/x-icon" => prefix.starts_with(&[0x00, 0x00, 0x01, 0x00]),
        "image/tiff" => {
            prefix.starts_with(&[b'I', b'I', 0x2a, 0x00])
                || prefix.starts_with(&[b'M', b'M', 0x00, 0x2a])
        }
        "image/heic" | "image/heif" => {
            prefix.get(4..8) == Some(b"ftyp")
                && prefix.windows(4).any(|value| {
                    matches!(
                        value,
                        b"heic" | b"heix" | b"hevc" | b"hevx" | b"mif1" | b"msf1"
                    )
                })
        }
        "video/mp4" => prefix.get(4..8) == Some(b"ftyp") && prefix.len() >= 12,
        "video/webm" => {
            prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
                && prefix.windows(4).any(|value| value == b"webm")
        }
        "video/quicktime" => {
            prefix.get(4..8) == Some(b"ftyp") && prefix.windows(4).any(|value| value == b"qt  ")
        }
        "video/x-matroska" => {
            prefix.starts_with(&[0x1a, 0x45, 0xdf, 0xa3])
                && prefix.windows(8).any(|value| value == b"matroska")
        }
        "video/x-msvideo" => {
            prefix.len() >= 12 && &prefix[..4] == b"RIFF" && &prefix[8..12] == b"AVI "
        }
        "video/ogg" => {
            prefix.starts_with(b"OggS") && prefix.windows(6).any(|value| value == b"theora")
        }
        "video/mpeg" => {
            prefix.starts_with(&[0x00, 0x00, 0x01, 0xba])
                || prefix.starts_with(&[0x00, 0x00, 0x01, 0xb3])
        }
        "video/mp2t" => {
            prefix.len() >= 377
                && [0_usize, 188, 376]
                    .into_iter()
                    .all(|offset| prefix.get(offset) == Some(&0x47))
        }
        "video/x-flv" => {
            prefix.starts_with(b"FLV") && prefix.get(3).is_some_and(|version| *version == 1)
        }
        "video/x-ms-wmv" => prefix.starts_with(&[
            0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62,
            0xce, 0x6c,
        ]),
        "video/3gpp" => {
            prefix.get(4..8) == Some(b"ftyp")
                && prefix.windows(4).any(|value| {
                    matches!(
                        value,
                        b"3gp4" | b"3gp5" | b"3gp6" | b"3gp7" | b"3gg6" | b"3gs6"
                    )
                })
        }
        _ => false,
    }
}

fn supports_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "image/bmp"
            | "image/x-icon"
            | "image/tiff"
            | "image/heic"
            | "image/heif"
    )
}

fn supports_ffmpeg_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/gif" | "image/avif" | "image/bmp" | "image/x-icon"
    )
}

fn supports_video_mime(mime: &str) -> bool {
    matches!(
        mime,
        "video/mp4"
            | "video/webm"
            | "video/quicktime"
            | "video/x-matroska"
            | "video/x-msvideo"
            | "video/ogg"
            | "video/mpeg"
            | "video/mp2t"
            | "video/x-flv"
            | "video/x-ms-wmv"
            | "video/3gpp"
    )
}

fn media_extension(mime: &str) -> Option<&'static str> {
    match mime {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/avif" => Some("avif"),
        "image/bmp" => Some("bmp"),
        "image/x-icon" => Some("ico"),
        "image/tiff" => Some("tiff"),
        "image/heic" => Some("heic"),
        "image/heif" => Some("heif"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        "video/quicktime" => Some("mov"),
        "video/x-matroska" => Some("mkv"),
        "video/x-msvideo" => Some("avi"),
        "video/ogg" => Some("ogv"),
        "video/mpeg" => Some("mpg"),
        "video/mp2t" => Some("ts"),
        "video/x-flv" => Some("flv"),
        "video/x-ms-wmv" => Some("wmv"),
        "video/3gpp" => Some("3gp"),
        _ => None,
    }
}

fn validate_metadata_free_webp(bytes: &[u8], max_bytes: usize) -> Result<(u32, u32), ()> {
    if bytes.len() < 20
        || bytes.len() > max_bytes
        || &bytes[..4] != b"RIFF"
        || &bytes[8..12] != b"WEBP"
    {
        return Err(());
    }
    let riff_length = u32::from_le_bytes(bytes[4..8].try_into().map_err(|_| ())?) as usize;
    if riff_length.checked_add(8) != Some(bytes.len()) {
        return Err(());
    }

    let mut offset = 12_usize;
    let mut vp8_dimensions = None;
    let mut extended_dimensions = None;
    let mut saw_vp8 = false;
    let mut saw_vp8l = false;
    let mut saw_alpha = false;
    let mut vp8l_has_alpha = false;
    while offset < bytes.len() {
        let header_end = offset.checked_add(8).ok_or(())?;
        if header_end > bytes.len() {
            return Err(());
        }
        let kind = &bytes[offset..offset + 4];
        let chunk_size =
            u32::from_le_bytes(bytes[offset + 4..header_end].try_into().map_err(|_| ())?) as usize;
        let data_start = header_end;
        let data_end = data_start.checked_add(chunk_size).ok_or(())?;
        if data_end > bytes.len() {
            return Err(());
        }
        let data = &bytes[data_start..data_end];
        match kind {
            b"VP8X" => {
                if extended_dimensions.is_some() || data.len() < 10 || data[0] & 0x2e != 0 {
                    return Err(());
                }
                let width =
                    1 + u32::from(data[4]) + (u32::from(data[5]) << 8) + (u32::from(data[6]) << 16);
                let height =
                    1 + u32::from(data[7]) + (u32::from(data[8]) << 8) + (u32::from(data[9]) << 16);
                extended_dimensions = Some((width, height));
            }
            b"ALPH" => {
                if saw_alpha {
                    return Err(());
                }
                saw_alpha = true;
            }
            b"VP8 " => {
                if saw_vp8 || data.len() < 10 || data[3..6] != [0x9d, 0x01, 0x2a] {
                    return Err(());
                }
                saw_vp8 = true;
                let width = u16::from_le_bytes([data[6], data[7]]) & 0x3fff;
                let height = u16::from_le_bytes([data[8], data[9]]) & 0x3fff;
                vp8_dimensions = Some((u32::from(width), u32::from(height)));
            }
            b"VP8L" => {
                if saw_vp8l || data.len() < 5 || data[0] != 0x2f {
                    return Err(());
                }
                saw_vp8l = true;
                vp8l_has_alpha = data[4] & 0x10 != 0;
                let width = 1 + u32::from(data[1]) + (u32::from(data[2] & 0x3f) << 8);
                let height = 1
                    + u32::from(data[2] >> 6)
                    + (u32::from(data[3]) << 2)
                    + (u32::from(data[4] & 0x0f) << 10);
                vp8_dimensions = Some((width, height));
            }
            _ => return Err(()),
        }
        if chunk_size & 1 == 1 && (data_end >= bytes.len() || bytes[data_end] != 0) {
            return Err(());
        }
        offset = data_end.checked_add(chunk_size & 1).ok_or(())?;
    }
    if offset != bytes.len() || (saw_vp8 && saw_vp8l) || (!saw_vp8 && !saw_vp8l) {
        return Err(());
    }
    let (width, height) = extended_dimensions.or(vp8_dimensions).ok_or(())?;
    if width == 0 || height == 0 {
        return Err(());
    }
    if extended_dimensions
        .is_some_and(|dimensions| vp8_dimensions.is_some_and(|inner| inner != dimensions))
    {
        return Err(());
    }
    if extended_dimensions.is_some_and(|_| {
        let has_alpha_flag = bytes.get(20).is_some_and(|flags| flags & 0x10 != 0);
        has_alpha_flag != (saw_alpha || vp8l_has_alpha)
    }) {
        return Err(());
    }
    Ok((width, height))
}

fn unsupported(code: &'static str) -> JobFailure {
    JobFailure {
        class: FailureClass::Unsupported,
        code,
    }
}

fn permanent(code: &'static str) -> JobFailure {
    JobFailure {
        class: FailureClass::Permanent,
        code,
    }
}

fn retryable(code: &'static str) -> JobFailure {
    JobFailure {
        class: FailureClass::Retryable,
        code,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        backfill_batch, claim_one, matches_magic, record_failure, retryable, run_once,
        supports_ffmpeg_image_mime, supports_image_mime, supports_video_mime,
        validate_metadata_free_webp,
    };
    use sqlx::{PgPool, postgres::PgPoolOptions};
    use std::net::SocketAddr;
    use tempfile::tempdir;
    use uuid::Uuid;

    use crate::{
        Config, MediaPreviewConfig,
        storage::{LocalStorage, PreviewStorage},
    };

    #[test]
    fn worker_preview_registry_accepts_verified_raster_formats() {
        for mime in [
            "image/jpeg",
            "image/png",
            "image/gif",
            "image/webp",
            "image/avif",
            "image/bmp",
            "image/x-icon",
            "image/tiff",
            "image/heic",
            "image/heif",
        ] {
            assert!(supports_image_mime(mime), "{mime}");
        }
        for mime in ["image/svg+xml", "image/jp2"] {
            assert!(!supports_image_mime(mime), "{mime}");
        }
        for mime in ["image/gif", "image/avif", "image/bmp", "image/x-icon"] {
            assert!(supports_ffmpeg_image_mime(mime), "{mime}");
        }
        assert!(!supports_ffmpeg_image_mime("image/jpeg"));
    }

    #[test]
    fn worker_video_registry_accepts_common_ffmpeg_containers() {
        for mime in [
            "video/mp4",
            "video/webm",
            "video/quicktime",
            "video/x-matroska",
            "video/x-msvideo",
            "video/ogg",
            "video/mpeg",
            "video/mp2t",
            "video/x-flv",
            "video/x-ms-wmv",
            "video/3gpp",
        ] {
            assert!(supports_video_mime(mime), "{mime}");
        }
        for mime in ["video/x-ms-asf", "video/x-m4v", "video/avi"] {
            assert!(!supports_video_mime(mime), "{mime}");
        }
    }

    #[test]
    fn decoder_registry_checks_sniffed_mime_against_content_signature() {
        assert!(matches_magic("image/jpeg", &[0xff, 0xd8, 0xff, 0]));
        assert!(matches_magic("image/png", b"\x89PNG\r\n\x1a\nrest"));
        assert!(matches_magic("image/gif", b"GIF89arest"));
        assert!(matches_magic("image/webp", b"RIFF\x00\x00\x00\x00WEBP"));
        assert!(matches_magic("image/avif", b"\x00\x00\x00\x18ftypavif"));
        assert!(matches_magic("image/bmp", b"BMrest"));
        assert!(matches_magic("image/x-icon", b"\x00\x00\x01\x00rest"));
        assert!(matches_magic("image/tiff", b"II*\x00rest"));
        assert!(matches_magic("image/tiff", b"MM\x00*rest"));
        assert!(matches_magic("image/heic", b"\x00\x00\x00\x18ftypheic"));
        assert!(matches_magic("image/heif", b"\x00\x00\x00\x18ftypmif1"));
        assert!(matches_magic("video/mp4", b"\x00\x00\x00\x18ftypisom"));
        assert!(matches_magic(
            "video/webm",
            b"\x1a\x45\xdf\xa3\xa3\x42\x82\x84webm"
        ));
        assert!(matches_magic(
            "video/quicktime",
            b"\x00\x00\x00\x18ftypqt  "
        ));
        assert!(matches_magic(
            "video/x-matroska",
            b"\x1a\x45\xdf\xa3\xa3\x42\x82\x84matroska"
        ));
        assert!(matches_magic(
            "video/x-msvideo",
            b"RIFF\x00\x00\x00\x00AVI "
        ));
        assert!(matches_magic("video/ogg", b"OggS\x00\x02\x00theora"));
        assert!(matches_magic("video/mpeg", b"\x00\x00\x01\xba"));
        assert!(matches_magic("video/x-flv", b"FLV\x01"));
        assert!(matches_magic(
            "video/x-ms-wmv",
            b"0&\xb2u\x8ef\xcf\x11\xa6\xd9\x00\xaa\x00b\xcel"
        ));
        assert!(matches_magic("video/3gpp", b"\x00\x00\x00\x18ftyp3gp6"));
        let transport_stream = [0x47_u8; 512];
        assert!(matches_magic("video/mp2t", &transport_stream));
        assert!(!matches_magic("image/jpeg", b"\x89PNG\r\n\x1a\n"));
        assert!(!matches_magic("image/gif", b"GIF89"));
        assert!(!matches_magic("image/avif", b"\x00\x00\x00\x18ftypisom"));
        assert!(!matches_magic("image/x-icon", b"\x00\x00\x02\x00rest"));
        assert!(!matches_magic("video/webm", b"\x1a\x45\xdf\xa3matroska"));
        assert!(!matches_magic(
            "video/x-matroska",
            b"\x1a\x45\xdf\xa3unknown"
        ));
    }

    #[test]
    fn webp_validator_rejects_metadata_chunks_and_oversized_outputs() {
        let mut bytes = b"RIFF\x12\x00\x00\x00WEBPVP8 \x04\x00\x00\x00\x00\x00\x00\x00".to_vec();
        let length = u32::try_from(bytes.len() - 8).unwrap();
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        assert_eq!(validate_metadata_free_webp(&bytes, 100), Err(()));
        assert_eq!(validate_metadata_free_webp(&bytes, 16), Err(()));

        let mut valid =
            b"RIFF\x16\x00\x00\x00WEBPVP8 \x0a\x00\x00\x00\x00\x00\x00\x9d\x01\x2a\x20\x00\x10\x00"
                .to_vec();
        let length = u32::try_from(valid.len() - 8).unwrap();
        valid[4..8].copy_from_slice(&length.to_le_bytes());
        assert_eq!(validate_metadata_free_webp(&valid, 100), Ok((32, 16)));

        let mut with_metadata = valid.clone();
        with_metadata.splice(12..12, b"EXIF\x00\x00\x00\x00".iter().copied());
        let length = u32::try_from(with_metadata.len() - 8).unwrap();
        with_metadata[4..8].copy_from_slice(&length.to_le_bytes());
        assert_eq!(validate_metadata_free_webp(&with_metadata, 100), Err(()));
    }

    #[test]
    fn webp_validator_accepts_metadata_free_alpha_with_bounded_canvas() {
        let mut bytes = b"RIFF\x00\x00\x00\x00WEBP\
            VP8X\x0a\x00\x00\x00\x10\x00\x00\x00\x1f\x00\x00\x0f\x00\x00\
            ALPH\x01\x00\x00\x00\x00\x00\
            VP8 \x0a\x00\x00\x00\x00\x00\x00\x9d\x01\x2a\x20\x00\x10\x00"
            .to_vec();
        let length = u32::try_from(bytes.len() - 8).unwrap();
        bytes[4..8].copy_from_slice(&length.to_le_bytes());
        assert_eq!(validate_metadata_free_webp(&bytes, 100), Ok((32, 16)));
    }

    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
    async fn backfill_queues_existing_current_images_once_and_skips_ineligible_versions() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
            .expect("connect to disposable PostgreSQL");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");

        let owner_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash, role) \
             VALUES ($1, $2, 'test-only-hash', 'owner')",
        )
        .bind(owner_id)
        .bind(format!("media-backfill-{owner_id}@example.test"))
        .execute(&pool)
        .await
        .expect("insert isolated owner");

        let mut candidates = Vec::with_capacity(102);
        for index in 0..102 {
            candidates.push(
                insert_backfill_file(
                    &pool,
                    owner_id,
                    &format!("candidate-{index}"),
                    "image/png",
                    "ready",
                    true,
                    false,
                )
                .await,
            );
        }
        let preexisting_failed = sqlx::query(
            "INSERT INTO media_index_jobs \
                 (file_version_id, task, recipe_version, state, attempts, error_code) \
             VALUES ($1, 'image_preview', 1, 'failed', 3, 'decode_failed')",
        )
        .bind(candidates[0].1)
        .execute(&pool)
        .await
        .expect("insert existing job that backfill must preserve");
        assert_eq!(preexisting_failed.rows_affected(), 1);
        sqlx::query(
            "INSERT INTO media_index_jobs (file_version_id, task, recipe_version, state) \
             VALUES ($1, 'image_preview', 2, 'completed')",
        )
        .bind(candidates[1].1)
        .execute(&pool)
        .await
        .expect("insert another recipe for the same file version");

        let historical_version =
            insert_backfill_version(&pool, candidates[0].0, "image/jpeg", "ready").await;
        let deleted_image = insert_backfill_file(
            &pool,
            owner_id,
            "deleted",
            "image/webp",
            "ready",
            true,
            true,
        )
        .await;
        let pending_image = insert_backfill_file(
            &pool,
            owner_id,
            "pending",
            "image/jpeg",
            "pending",
            true,
            false,
        )
        .await;
        let non_image = insert_backfill_file(
            &pool,
            owner_id,
            "non-image",
            "application/octet-stream",
            "ready",
            true,
            false,
        )
        .await;
        let video =
            insert_backfill_file(&pool, owner_id, "video", "video/mp4", "ready", true, false).await;

        backfill_batch(&pool)
            .await
            .expect("first bounded backfill batch");
        let (after_first, queued_after_first): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE state = 'queued') \
               FROM media_index_jobs \
              WHERE file_version_id = ANY($1) AND task = 'image_preview' AND recipe_version = 1",
        )
        .bind(
            candidates
                .iter()
                .map(|candidate| candidate.1)
                .collect::<Vec<_>>(),
        )
        .fetch_one(&pool)
        .await
        .expect("inspect first bounded backfill batch");
        assert_eq!(after_first, 101);
        assert_eq!(queued_after_first, 100);

        let preserved: (String, i32, Option<String>) = sqlx::query_as(
            "SELECT state, attempts, error_code FROM media_index_jobs \
              WHERE file_version_id = $1 AND task = 'image_preview' AND recipe_version = 1",
        )
        .bind(candidates[0].1)
        .fetch_one(&pool)
        .await
        .expect("fetch existing job after backfill");
        assert_eq!(
            preserved,
            ("failed".to_owned(), 3, Some("decode_failed".to_owned()))
        );

        backfill_batch(&pool)
            .await
            .expect("second bounded backfill batch");
        backfill_batch(&pool)
            .await
            .expect("idempotent backfill after completion");
        let after_all: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM media_index_jobs \
              WHERE file_version_id = ANY($1) AND task = 'image_preview' AND recipe_version = 1",
        )
        .bind(
            candidates
                .iter()
                .map(|candidate| candidate.1)
                .collect::<Vec<_>>(),
        )
        .fetch_one(&pool)
        .await
        .expect("count all backfilled candidate versions");
        assert_eq!(after_all, 102);
        let recipes_for_one_version: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT recipe_version) FROM media_index_jobs \
              WHERE file_version_id = $1 AND task = 'image_preview'",
        )
        .bind(candidates[1].1)
        .fetch_one(&pool)
        .await
        .expect("count distinct recipes for one file version");
        assert_eq!(recipes_for_one_version, 2);

        let decoy_jobs: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM media_index_jobs \
              WHERE file_version_id = ANY($1) AND task = 'image_preview' AND recipe_version = 1",
        )
        .bind(vec![
            historical_version,
            deleted_image.1,
            pending_image.1,
            non_image.1,
        ])
        .fetch_one(&pool)
        .await
        .expect("count ineligible backfill jobs");
        assert_eq!(decoy_jobs, 0);
        let video_job: (String, i16) = sqlx::query_as(
            "SELECT task, recipe_version FROM media_index_jobs WHERE file_version_id = $1",
        )
        .bind(video.1)
        .fetch_one(&pool)
        .await
        .expect("fetch backfilled video poster job");
        assert_eq!(video_job, ("video_thumbnail".to_owned(), 1));

        let mut cleanup_versions = candidates
            .iter()
            .map(|candidate| candidate.1)
            .collect::<Vec<_>>();
        cleanup_versions.extend([
            historical_version,
            deleted_image.1,
            pending_image.1,
            non_image.1,
            video.1,
        ]);
        let mut cleanup_files = candidates
            .iter()
            .map(|candidate| candidate.0)
            .collect::<Vec<_>>();
        cleanup_files.extend([deleted_image.0, pending_image.0, non_image.0, video.0]);
        sqlx::query("UPDATE drive_entries SET deleted_at = now() WHERE id = ANY($1)")
            .bind(cleanup_files)
            .execute(&pool)
            .await
            .expect("deactivate files created by backfill test");
        sqlx::query("DELETE FROM media_index_jobs WHERE file_version_id = ANY($1)")
            .bind(cleanup_versions)
            .execute(&pool)
            .await
            .expect("remove jobs created by backfill test");

        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
    async fn expired_worker_lease_recovers_and_retry_wait_claims_once() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
        let pool = PgPoolOptions::new()
            .max_connections(3)
            .connect(&database_url)
            .await
            .expect("connect to disposable PostgreSQL");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");

        let owner_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash, role) \
             VALUES ($1, $2, 'test-only-hash', 'owner')",
        )
        .bind(owner_id)
        .bind(format!("media-lease-{owner_id}@example.test"))
        .execute(&pool)
        .await
        .expect("insert isolated owner");
        let (file_id, version_id) = insert_backfill_file(
            &pool,
            owner_id,
            "lease-recovery",
            "image/png",
            "ready",
            true,
            false,
        )
        .await;
        let job_id: i64 = sqlx::query_scalar(
            "INSERT INTO media_index_jobs \
                 (file_version_id, task, recipe_version, state, attempts, lease_expires_at) \
             VALUES ($1, 'image_preview', 1, 'running', 1, now() - interval '1 second') \
             RETURNING id",
        )
        .bind(version_id)
        .fetch_one(&pool)
        .await
        .expect("insert job with expired lease");

        let (first, second) = tokio::join!(claim_one(&pool), claim_one(&pool));
        let job = match (first.expect("first claim"), second.expect("second claim")) {
            (Some(job), None) | (None, Some(job)) => job,
            _ => panic!("exactly one concurrent claimant must recover the expired lease"),
        };
        assert_eq!(job.id, job_id);
        assert_eq!(job.attempts, 2);

        record_failure(&pool, &job, retryable("preview_storage_unavailable"))
            .await
            .expect("record retryable failure");
        let retry_state: (String, i32, Option<String>) = sqlx::query_as(
            "SELECT state, attempts, error_code FROM media_index_jobs WHERE id = $1",
        )
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .expect("inspect retry wait");
        assert_eq!(
            retry_state,
            (
                "retry_wait".to_owned(),
                2,
                Some("preview_storage_unavailable".to_owned())
            )
        );

        sqlx::query(
            "UPDATE media_index_jobs SET available_at = now() - interval '1 second' WHERE id = $1",
        )
        .bind(job_id)
        .execute(&pool)
        .await
        .expect("simulate elapsed retry delay");
        let retry = claim_one(&pool)
            .await
            .expect("claim retry after backoff")
            .expect("retry becomes claimable");
        assert_eq!(retry.id, job_id);
        assert_eq!(retry.attempts, 3);
        sqlx::query("UPDATE drive_entries SET deleted_at = now() WHERE id = $1")
            .bind(file_id)
            .execute(&pool)
            .await
            .expect("deactivate file created by lease recovery test");
        sqlx::query("DELETE FROM media_index_jobs WHERE id = $1")
            .bind(job_id)
            .execute(&pool)
            .await
            .expect("remove job created by lease recovery test");

        pool.close().await;
    }

    #[tokio::test]
    #[ignore = "requires a disposable PostgreSQL database in TEST_DATABASE_URL"]
    async fn preview_storage_disappearance_fails_closed_without_hdd_fallback() {
        let database_url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to a disposable PostgreSQL database");
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect(&database_url)
            .await
            .expect("connect to disposable PostgreSQL");
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .expect("apply migrations");

        let owner_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, email, password_hash, role) \
             VALUES ($1, $2, 'test-only-hash', 'owner')",
        )
        .bind(owner_id)
        .bind(format!("media-mount-{owner_id}@example.test"))
        .execute(&pool)
        .await
        .expect("insert isolated owner");
        let (file_id, version_id) = insert_backfill_file(
            &pool,
            owner_id,
            "ssd-disappearance",
            "image/png",
            "ready",
            true,
            false,
        )
        .await;
        sqlx::query(
            "INSERT INTO media_index_jobs (file_version_id, task, recipe_version) \
             VALUES ($1, 'image_preview', 1)",
        )
        .bind(version_id)
        .execute(&pool)
        .await
        .expect("insert queued preview job");

        let temporary = tempdir().expect("create temporary HDD and SSD roots");
        let hdd_root = temporary.path().join("hdd");
        let ssd_root = temporary.path().join("ssd");
        std::fs::create_dir_all(&hdd_root).expect("create HDD root");
        std::fs::create_dir_all(&ssd_root).expect("create SSD root");
        let storage = LocalStorage::open_readonly(&Config {
            database_url: "postgres://not-used-in-test".to_owned(),
            bind_addr: "127.0.0.1:3000".parse::<SocketAddr>().unwrap(),
            storage_root: hdd_root.clone(),
            expected_mount: hdd_root.clone(),
            require_mount: false,
            require_device_match: false,
            expected_device: None,
            media_preview: None,
            max_file_size: 1024,
            owner_quota_bytes: 4096,
            min_free_bytes: 0,
            min_free_percent: 0.0,
            upload_session_ttl_seconds: 3600,
            trash_retention_days: 30,
            session_ttl_seconds: 3600,
            bootstrap_owner: None,
            cookie_secure: false,
        })
        .expect("open HDD read-only");
        let previews = PreviewStorage::new(&MediaPreviewConfig {
            root: ssd_root.clone(),
            expected_mount: ssd_root.clone(),
            require_mount: false,
            require_device_match: false,
            expected_device: None,
        });
        previews
            .prepare()
            .expect("prepare SSD root before disappearance");
        std::fs::remove_dir(&ssd_root).expect("simulate SSD mount disappearance");

        assert!(run_once(&pool, &storage, &previews).await.is_err());
        assert!(!hdd_root.join("previews").exists());
        let job: (String, i32) = sqlx::query_as(
            "SELECT state, attempts FROM media_index_jobs WHERE file_version_id = $1",
        )
        .bind(version_id)
        .fetch_one(&pool)
        .await
        .expect("inspect queued job after SSD loss");
        assert_eq!(job, ("queued".to_owned(), 0));
        sqlx::query("UPDATE drive_entries SET deleted_at = now() WHERE id = $1")
            .bind(file_id)
            .execute(&pool)
            .await
            .expect("deactivate file created by SSD disappearance test");
        sqlx::query("DELETE FROM media_index_jobs WHERE file_version_id = $1")
            .bind(version_id)
            .execute(&pool)
            .await
            .expect("remove job created by SSD disappearance test");

        pool.close().await;
    }

    async fn insert_backfill_file(
        pool: &PgPool,
        owner_id: Uuid,
        name: &str,
        mime: &str,
        object_state: &str,
        current: bool,
        deleted: bool,
    ) -> (Uuid, Uuid) {
        let file_id = Uuid::new_v4();
        let object_id = Uuid::new_v4();
        let version_id = Uuid::new_v4();
        let storage_key = crate::storage::LocalStorage::storage_key(object_id);
        sqlx::query(
            "INSERT INTO drive_entries (id, owner_id, kind, name, deleted_at) \
             VALUES ($1, $2, 'file', $3, CASE WHEN $4 THEN now() ELSE NULL END)",
        )
        .bind(file_id)
        .bind(owner_id)
        .bind(format!("{name}-{file_id}"))
        .bind(deleted)
        .execute(pool)
        .await
        .expect("insert backfill file entry");
        sqlx::query("INSERT INTO files (id) VALUES ($1)")
            .bind(file_id)
            .execute(pool)
            .await
            .expect("insert backfill file projection");
        sqlx::query(
            "INSERT INTO storage_objects (id, storage_key, size_bytes, mime_detected, state) \
             VALUES ($1, $2, 8, $3, $4)",
        )
        .bind(object_id)
        .bind(storage_key)
        .bind(mime)
        .bind(object_state)
        .execute(pool)
        .await
        .expect("insert backfill storage object");
        sqlx::query(
            "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) \
             VALUES ($1, $2, $3, 8)",
        )
        .bind(version_id)
        .bind(file_id)
        .bind(object_id)
        .execute(pool)
        .await
        .expect("insert backfill file version");
        if current {
            sqlx::query("UPDATE files SET current_version_id = $1 WHERE id = $2")
                .bind(version_id)
                .bind(file_id)
                .execute(pool)
                .await
                .expect("set current backfill file version");
        }
        (file_id, version_id)
    }

    async fn insert_backfill_version(
        pool: &PgPool,
        file_id: Uuid,
        mime: &str,
        object_state: &str,
    ) -> Uuid {
        let object_id = Uuid::new_v4();
        let version_id = Uuid::new_v4();
        let storage_key = crate::storage::LocalStorage::storage_key(object_id);
        sqlx::query(
            "INSERT INTO storage_objects (id, storage_key, size_bytes, mime_detected, state) \
             VALUES ($1, $2, 8, $3, $4)",
        )
        .bind(object_id)
        .bind(storage_key)
        .bind(mime)
        .bind(object_state)
        .execute(pool)
        .await
        .expect("insert historical backfill storage object");
        sqlx::query(
            "INSERT INTO file_versions (id, file_id, storage_object_id, size_bytes) \
             VALUES ($1, $2, $3, 8)",
        )
        .bind(version_id)
        .bind(file_id)
        .bind(object_id)
        .execute(pool)
        .await
        .expect("insert historical backfill version");
        version_id
    }
}
