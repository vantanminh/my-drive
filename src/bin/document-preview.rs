#![forbid(unsafe_code)]

use std::{io, net::SocketAddr, path::PathBuf, process::Stdio, sync::Arc, time::Duration};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderValue, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use tokio::{fs, net::TcpListener, process::Command, sync::Semaphore, time::timeout};
use uuid::Uuid;

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024;
const MAX_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const CONVERSION_TIMEOUT: Duration = Duration::from_secs(32);

#[derive(Clone)]
struct AppState {
    conversion_slots: Arc<Semaphore>,
}

#[derive(Clone, Copy)]
enum OfficeFormat {
    Doc,
    Docx,
    Ppt,
    Pptx,
    Xls,
    Xlsx,
    Rtf,
    Csv,
}

impl OfficeFormat {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "doc" => Some(Self::Doc),
            "docx" => Some(Self::Docx),
            "ppt" => Some(Self::Ppt),
            "pptx" => Some(Self::Pptx),
            "xls" => Some(Self::Xls),
            "xlsx" => Some(Self::Xlsx),
            "rtf" => Some(Self::Rtf),
            "csv" => Some(Self::Csv),
            _ => None,
        }
    }
}

struct TemporaryDirectory(PathBuf);

impl TemporaryDirectory {
    fn create() -> io::Result<Self> {
        let path = std::env::temp_dir().join(format!("my-drive-preview-{}", Uuid::new_v4()));
        std::fs::create_dir(&path)?;
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o700))?;
        Ok(Self(path))
    }

    fn path(&self) -> &std::path::Path {
        &self.0
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let bind_addr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:3100".to_owned())
        .parse::<SocketAddr>()?;
    let listener = TcpListener::bind(bind_addr).await?;
    let app = Router::new()
        .route("/health", get(health))
        .route("/convert/{format}", post(convert))
        .layer(DefaultBodyLimit::max(MAX_INPUT_BYTES))
        .with_state(AppState {
            conversion_slots: Arc::new(Semaphore::new(1)),
        });
    axum::serve(listener, app).await?;
    Ok(())
}

async fn health() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn convert(
    State(state): State<AppState>,
    Path(format): Path<String>,
    body: Body,
) -> Result<Response, ConvertError> {
    let format = OfficeFormat::parse(&format).ok_or(ConvertError::UnsupportedFormat)?;
    let _permit = state
        .conversion_slots
        .acquire()
        .await
        .map_err(|_| ConvertError::Unavailable)?;
    let input = to_bytes(body, MAX_INPUT_BYTES)
        .await
        .map_err(|_| ConvertError::PayloadTooLarge)?;
    if input.is_empty() {
        return Err(ConvertError::InvalidDocument);
    }

    let directory = TemporaryDirectory::create().map_err(|_| ConvertError::Unavailable)?;
    let source = directory
        .path()
        .join(format!("source.{}", format.extension()));
    let output = directory.path().join("source.pdf");
    let home = directory.path().join("home");
    let temporary = directory.path().join("tmp");
    let profile = directory.path().join("profile");
    fs::create_dir(&home)
        .await
        .map_err(|_| ConvertError::Unavailable)?;
    fs::create_dir(&temporary)
        .await
        .map_err(|_| ConvertError::Unavailable)?;
    fs::create_dir(&profile)
        .await
        .map_err(|_| ConvertError::Unavailable)?;
    fs::write(&source, &input)
        .await
        .map_err(|_| ConvertError::Unavailable)?;
    drop(input);

    let profile_url =
        reqwest::Url::from_file_path(&profile).map_err(|_| ConvertError::Unavailable)?;
    let command = Command::new("timeout")
        .arg("--signal=KILL")
        .arg("--kill-after=2s")
        .arg("30s")
        .arg("libreoffice")
        .arg(format!("-env:UserInstallation={profile_url}"))
        .arg("--headless")
        .arg("--nologo")
        .arg("--nodefault")
        .arg("--nolockcheck")
        .arg("--norestore")
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(directory.path())
        .arg(&source)
        .env("HOME", &home)
        .env("TMPDIR", &temporary)
        .env("SAL_USE_VCLPLUGIN", "svp")
        .env("SAL_DISABLE_OPENCL", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let result = timeout(CONVERSION_TIMEOUT, command)
        .await
        .map_err(|_| ConvertError::TimedOut)?
        .map_err(|_| ConvertError::Unavailable)?;
    if !result.status.success() {
        return Err(ConvertError::InvalidDocument);
    }

    let metadata = fs::metadata(&output)
        .await
        .map_err(|_| ConvertError::InvalidDocument)?;
    if metadata.len() == 0 || metadata.len() > MAX_OUTPUT_BYTES {
        return Err(ConvertError::PayloadTooLarge);
    }
    let pdf = fs::read(output)
        .await
        .map_err(|_| ConvertError::Unavailable)?;
    if !pdf.starts_with(b"%PDF-") {
        return Err(ConvertError::InvalidDocument);
    }

    let mut response = Response::new(Body::from(pdf));
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

impl OfficeFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Doc => "doc",
            Self::Docx => "docx",
            Self::Ppt => "ppt",
            Self::Pptx => "pptx",
            Self::Xls => "xls",
            Self::Xlsx => "xlsx",
            Self::Rtf => "rtf",
            Self::Csv => "csv",
        }
    }
}

#[derive(Debug)]
enum ConvertError {
    UnsupportedFormat,
    InvalidDocument,
    PayloadTooLarge,
    TimedOut,
    Unavailable,
}

impl IntoResponse for ConvertError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::UnsupportedFormat => StatusCode::UNSUPPORTED_MEDIA_TYPE,
            Self::InvalidDocument => StatusCode::UNPROCESSABLE_ENTITY,
            Self::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::TimedOut => StatusCode::GATEWAY_TIMEOUT,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        };
        (status, "Document preview is unavailable.").into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::OfficeFormat;

    #[test]
    fn conversion_allowlist_accepts_only_supported_office_formats() {
        for format in ["doc", "docx", "ppt", "pptx", "xls", "xlsx", "rtf", "csv"] {
            assert!(OfficeFormat::parse(format).is_some(), "{format}");
        }
        for format in ["", "pdf", "docm", "pptm", "xlsm", "html", "exe"] {
            assert!(OfficeFormat::parse(format).is_none(), "{format}");
        }
    }
}
