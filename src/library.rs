use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, NaiveDate, NaiveTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::FromRow;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    auth::AuthenticatedUser,
    drive::{self, DriveError},
    health::AppState,
    storage::FilesystemUsage,
};

const DEFAULT_PAGE_SIZE: u16 = 60;
const MAX_PAGE_SIZE: u16 = 120;
const MAX_OFFSET: u32 = 1_000_000;
const MAX_ALBUM_FILES: usize = 100;

#[derive(Debug, Error)]
enum LibraryError {
    #[error("invalid request")]
    BadRequest,
    #[error("not found")]
    NotFound,
    #[error("name conflicts with an existing album")]
    Conflict,
    #[error("CSRF validation failed")]
    Csrf,
    #[error("permission denied")]
    Forbidden,
    #[error("database operation failed")]
    Database(#[source] sqlx::Error),
}

impl IntoResponse for LibraryError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            Self::BadRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
            Self::NotFound => (StatusCode::NOT_FOUND, "not_found"),
            Self::Conflict => (StatusCode::CONFLICT, "conflict"),
            Self::Csrf => (StatusCode::FORBIDDEN, "csrf_failed"),
            Self::Forbidden => (StatusCode::FORBIDDEN, "forbidden"),
            Self::Database(error) => {
                tracing::error!(error = %error, "library database operation failed");
                (StatusCode::SERVICE_UNAVAILABLE, "service_unavailable")
            }
        };
        no_store((status, Json(json!({ "error": message }))))
    }
}

fn no_store<T: IntoResponse>(response: T) -> Response {
    let mut response = response.into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, "no-store".parse().expect("static header"));
    response
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/drive/search", get(search_drive))
        .route("/api/entries/{id}/details", get(entry_details))
        .route("/api/photos", get(list_photos))
        .route("/api/faces/{cluster_id}/media", get(face_media))
        .route("/api/albums", get(list_albums).post(create_album))
        .route(
            "/api/albums/{id}",
            get(get_album).patch(rename_album).delete(delete_album),
        )
        .route(
            "/api/albums/{id}/items",
            get(list_album_items).post(add_album_items),
        )
        .route("/api/albums/{id}/items/remove", post(remove_album_items))
        .route("/api/storage", get(account_storage))
        .route("/api/admin/storage", get(server_storage))
        .layer(DefaultBodyLimit::max(64 * 1024))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchQuery {
    q: Option<String>,
    category: Option<String>,
    mime: Option<String>,
    min_size: Option<i64>,
    max_size: Option<i64>,
    created_from: Option<String>,
    created_to: Option<String>,
    modified_from: Option<String>,
    modified_to: Option<String>,
    folder_id: Option<Uuid>,
    limit: Option<u16>,
    offset: Option<u32>,
    sort_by: Option<String>,
    order: Option<String>,
}

#[derive(Serialize, FromRow)]
struct IndexedEntry {
    id: Uuid,
    parent_id: Option<Uuid>,
    kind: String,
    name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    deleted_at: Option<DateTime<Utc>>,
    size_bytes: Option<i64>,
    mime_detected: Option<String>,
    category: Option<String>,
    folder_bytes: Option<i64>,
    folder_file_count: Option<i64>,
    folder_subfolder_count: Option<i64>,
}

#[derive(Serialize)]
struct EntryPage {
    entries: Vec<IndexedEntry>,
    limit: u16,
    next_offset: Option<u32>,
}

struct SearchBounds {
    term: String,
    category: Option<String>,
    mime_prefix: Option<String>,
    min_size: Option<i64>,
    max_size: Option<i64>,
    created_from: Option<DateTime<Utc>>,
    created_to: Option<DateTime<Utc>>,
    modified_from: Option<DateTime<Utc>>,
    modified_to: Option<DateTime<Utc>>,
    folder_id: Option<Uuid>,
    sort_column: &'static str,
    direction: &'static str,
    limit: u16,
    offset: u32,
}

fn compile_search(query: &SearchQuery) -> Result<SearchBounds, LibraryError> {
    let term = query.q.as_deref().unwrap_or("").trim();
    if term.chars().count() > 255 {
        return Err(LibraryError::BadRequest);
    }
    let category = match query.category.as_deref() {
        None => None,
        Some(value) => Some(normalize_category(value)?.to_owned()),
    };
    let mime_prefix = match query.mime.as_deref() {
        None => None,
        Some(value) => Some(normalize_mime_prefix(value)?),
    };
    if query.min_size.is_some_and(|size| size < 0) || query.max_size.is_some_and(|size| size < 0) {
        return Err(LibraryError::BadRequest);
    }
    if let (Some(min_size), Some(max_size)) = (query.min_size, query.max_size)
        && min_size > max_size
    {
        return Err(LibraryError::BadRequest);
    }
    let created_from = optional_instant(query.created_from.as_deref(), false)?;
    let created_to = optional_instant(query.created_to.as_deref(), true)?;
    let modified_from = optional_instant(query.modified_from.as_deref(), false)?;
    let modified_to = optional_instant(query.modified_to.as_deref(), true)?;
    if term.is_empty()
        && category.is_none()
        && mime_prefix.is_none()
        && query.min_size.is_none()
        && query.max_size.is_none()
        && created_from.is_none()
        && created_to.is_none()
        && modified_from.is_none()
        && modified_to.is_none()
        && query.folder_id.is_none()
    {
        return Err(LibraryError::BadRequest);
    }
    let (sort_column, direction) = search_sort(query.sort_by.as_deref(), query.order.as_deref())?;
    Ok(SearchBounds {
        term: term.to_lowercase(),
        category,
        mime_prefix,
        min_size: query.min_size,
        max_size: query.max_size,
        created_from,
        created_to,
        modified_from,
        modified_to,
        folder_id: query.folder_id,
        sort_column,
        direction,
        limit: page_limit(query.limit)?,
        offset: page_offset(query.offset)?,
    })
}

fn normalize_category(value: &str) -> Result<&'static str, LibraryError> {
    match value {
        "folder" | "image" | "video" | "audio" | "document" | "archive" | "other" => {
            Ok(match value {
                "folder" => "folder",
                "image" => "image",
                "video" => "video",
                "audio" => "audio",
                "document" => "document",
                "archive" => "archive",
                _ => "other",
            })
        }
        _ => Err(LibraryError::BadRequest),
    }
}

fn normalize_mime_prefix(value: &str) -> Result<String, LibraryError> {
    let value = value.trim().to_ascii_lowercase();
    if value.len() > 128
        || value.matches('/').count() != 1
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "/.+-*".contains(character))
    {
        return Err(LibraryError::BadRequest);
    }
    let prefix = value.trim_end_matches('*').trim_end_matches('/');
    if prefix.is_empty() || !prefix.contains('/') && value.starts_with('/') {
        return Err(LibraryError::BadRequest);
    }
    Ok(prefix.to_owned())
}

fn optional_instant(
    value: Option<&str>,
    end_of_day: bool,
) -> Result<Option<DateTime<Utc>>, LibraryError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| parse_instant(value, end_of_day))
        .transpose()
}

fn parse_instant(value: &str, end_of_day: bool) -> Result<DateTime<Utc>, LibraryError> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }
    let date =
        NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| LibraryError::BadRequest)?;
    let time = if end_of_day {
        NaiveTime::from_hms_opt(23, 59, 59).expect("valid time")
    } else {
        NaiveTime::MIN
    };
    Ok(date.and_time(time).and_utc())
}

fn search_sort(
    sort_by: Option<&str>,
    order: Option<&str>,
) -> Result<(&'static str, &'static str), LibraryError> {
    let column = match sort_by.unwrap_or("name") {
        "name" => "idx.name_normalized",
        "created_at" => "idx.created_at",
        "updated_at" => "idx.updated_at",
        "size" => "idx.size_bytes",
        _ => return Err(LibraryError::BadRequest),
    };
    let direction = match order.unwrap_or("asc") {
        "asc" => "ASC",
        "desc" => "DESC",
        _ => return Err(LibraryError::BadRequest),
    };
    Ok((column, direction))
}

fn page_limit(limit: Option<u16>) -> Result<u16, LibraryError> {
    let limit = limit.unwrap_or(DEFAULT_PAGE_SIZE);
    if limit == 0 || limit > MAX_PAGE_SIZE {
        return Err(LibraryError::BadRequest);
    }
    Ok(limit)
}

fn page_offset(offset: Option<u32>) -> Result<u32, LibraryError> {
    let offset = offset.unwrap_or(0);
    if offset > MAX_OFFSET {
        return Err(LibraryError::BadRequest);
    }
    Ok(offset)
}

async fn search_drive(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<SearchQuery>,
) -> Result<Response, LibraryError> {
    let bounds = compile_search(&query)?;
    if let Some(folder_id) = bounds.folder_id {
        drive::ensure_active_entry(&state, user.id, folder_id, true)
            .await
            .map_err(library_from_drive)?;
    }
    let sql = format!(
        "SELECT e.id, e.parent_id, e.kind, e.name, e.created_at, e.updated_at, e.deleted_at, \
                idx.size_bytes, idx.mime_type AS mime_detected, idx.category, \
                stats.total_bytes AS folder_bytes, stats.file_count AS folder_file_count, \
                stats.subfolder_count AS folder_subfolder_count \
           FROM entry_index AS idx \
           JOIN drive_entries AS e ON e.id = idx.entry_id \
           LEFT JOIN folder_stats AS stats ON stats.folder_id = e.id \
          WHERE idx.owner_id = $1 AND idx.deleted_at IS NULL AND NOT idx.buried \
            AND ($2 = '' OR position($2 in idx.name_normalized) > 0) \
            AND ($3::text IS NULL OR idx.category = $3) \
            AND ($4::text IS NULL OR idx.mime_type = $4 OR idx.mime_type LIKE $4 || '/%' OR idx.mime_type LIKE $4 || '%') \
            AND ($5::bigint IS NULL OR idx.size_bytes >= $5) \
            AND ($6::bigint IS NULL OR idx.size_bytes <= $6) \
            AND ($7::timestamptz IS NULL OR idx.created_at >= $7) \
            AND ($8::timestamptz IS NULL OR idx.created_at <= $8) \
            AND ($9::timestamptz IS NULL OR idx.updated_at >= $9) \
            AND ($10::timestamptz IS NULL OR idx.updated_at <= $10) \
            AND ($11::uuid IS NULL OR idx.entry_id IN ( \
                WITH RECURSIVE subtree AS ( \
                    SELECT id FROM drive_entries \
                     WHERE parent_id = $11 AND owner_id = $1 AND deleted_at IS NULL \
                    UNION ALL \
                    SELECT child.id FROM drive_entries AS child \
                    JOIN subtree ON child.parent_id = subtree.id \
                     WHERE child.owner_id = $1 AND child.deleted_at IS NULL \
                ) SELECT id FROM subtree \
            )) \
          ORDER BY {sort} {direction}, idx.entry_id ASC \
          LIMIT $12 OFFSET $13",
        sort = bounds.sort_column,
        direction = bounds.direction
    );
    let mut entries = sqlx::query_as::<_, IndexedEntry>(&sql)
        .bind(user.id)
        .bind(&bounds.term)
        .bind(&bounds.category)
        .bind(&bounds.mime_prefix)
        .bind(bounds.min_size)
        .bind(bounds.max_size)
        .bind(bounds.created_from)
        .bind(bounds.created_to)
        .bind(bounds.modified_from)
        .bind(bounds.modified_to)
        .bind(bounds.folder_id)
        .bind(i64::from(bounds.limit) + 1)
        .bind(i64::from(bounds.offset))
        .fetch_all(&state.pool)
        .await
        .map_err(LibraryError::Database)?;
    let has_more = entries.len() > usize::from(bounds.limit);
    entries.truncate(usize::from(bounds.limit));
    Ok(no_store(Json(EntryPage {
        entries,
        limit: bounds.limit,
        next_offset: has_more.then_some(bounds.offset + u32::from(bounds.limit)),
    })))
}

#[derive(Serialize)]
struct EntryDetails {
    id: Uuid,
    parent_id: Option<Uuid>,
    kind: String,
    name: String,
    mime_type: Option<String>,
    category: String,
    size_bytes: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    location: String,
    breadcrumbs: Vec<Breadcrumb>,
    media: Value,
    folder: Option<FolderAnalytics>,
}

#[derive(Serialize, FromRow)]
struct Breadcrumb {
    id: Uuid,
    name: String,
}

#[derive(Serialize)]
struct FolderAnalytics {
    total_bytes: i64,
    file_count: i64,
    subfolder_count: i64,
    by_category: Value,
}

#[derive(FromRow)]
struct DetailRow {
    id: Uuid,
    parent_id: Option<Uuid>,
    kind: String,
    name: String,
    mime_type: Option<String>,
    category: String,
    size_bytes: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    media: Value,
}

async fn entry_details(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Response, LibraryError> {
    drive::ensure_active_entry(&state, user.id, id, false)
        .await
        .map_err(library_from_drive)?;
    let row = sqlx::query_as::<_, DetailRow>(
        "SELECT idx.entry_id AS id, idx.parent_id, idx.kind, idx.name, idx.mime_type, idx.category, \
                idx.size_bytes, idx.created_at, idx.updated_at, idx.media \
           FROM entry_index AS idx \
          WHERE idx.entry_id = $1 AND idx.owner_id = $2 AND idx.deleted_at IS NULL AND NOT idx.buried",
    )
    .bind(id)
    .bind(user.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(LibraryError::Database)?
    .ok_or(LibraryError::NotFound)?;

    let breadcrumbs = breadcrumbs(&state, user.id, id).await?;
    let location = breadcrumbs
        .iter()
        .map(|crumb| crumb.name.as_str())
        .collect::<Vec<_>>()
        .join(" / ");
    let folder = if row.kind == "folder" {
        sqlx::query("SELECT refresh_folder_stats($1, $2, FALSE)")
            .bind(user.id)
            .bind(id)
            .execute(&state.pool)
            .await
            .map_err(LibraryError::Database)?;
        let stats = sqlx::query_as::<_, (i64, i64, i64, Value)>(
            "SELECT total_bytes, file_count, subfolder_count, by_category \
               FROM folder_stats WHERE folder_id = $1 AND owner_id = $2",
        )
        .bind(id)
        .bind(user.id)
        .fetch_optional(&state.pool)
        .await
        .map_err(LibraryError::Database)?;
        stats.map(
            |(total_bytes, file_count, subfolder_count, by_category)| FolderAnalytics {
                total_bytes,
                file_count,
                subfolder_count,
                by_category,
            },
        )
    } else {
        None
    };

    Ok(no_store(Json(EntryDetails {
        id: row.id,
        parent_id: row.parent_id,
        kind: row.kind,
        name: row.name,
        mime_type: row.mime_type,
        category: row.category,
        size_bytes: row.size_bytes,
        created_at: row.created_at,
        updated_at: row.updated_at,
        location,
        breadcrumbs,
        media: row.media,
        folder,
    })))
}

async fn breadcrumbs(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
) -> Result<Vec<Breadcrumb>, LibraryError> {
    let mut chain = sqlx::query_as::<_, Breadcrumb>(
        "WITH RECURSIVE chain AS ( \
             SELECT id, parent_id, name, 0 AS depth \
               FROM drive_entries WHERE id = $1 AND owner_id = $2 \
             UNION ALL \
             SELECT parent.id, parent.parent_id, parent.name, chain.depth + 1 \
               FROM drive_entries AS parent \
               JOIN chain ON parent.id = chain.parent_id \
              WHERE parent.owner_id = $2 \
         ) \
         SELECT id, name FROM chain ORDER BY depth DESC",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_all(&state.pool)
    .await
    .map_err(LibraryError::Database)?;
    chain.insert(
        0,
        Breadcrumb {
            id: Uuid::nil(),
            name: "My Drive".to_owned(),
        },
    );
    Ok(chain)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PhotoQuery {
    limit: Option<u16>,
    cursor: Option<String>,
}

#[derive(Serialize)]
struct PhotoPage {
    items: Vec<MediaItem>,
    limit: u16,
    next_cursor: Option<String>,
}

#[derive(Serialize, FromRow)]
struct MediaItem {
    id: Uuid,
    name: String,
    mime_type: Option<String>,
    category: String,
    size_bytes: i64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    media: Value,
}

async fn face_media(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(cluster_id): Path<Uuid>,
    Query(query): Query<AlbumItemQuery>,
) -> Result<Response, LibraryError> {
    let owned: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM face_clusters WHERE id = $1 AND owner_id = $2)",
    )
    .bind(cluster_id)
    .bind(user.id)
    .fetch_one(&state.pool)
    .await
    .map_err(LibraryError::Database)?;
    if !owned {
        return Err(LibraryError::NotFound);
    }
    let limit = page_limit(query.limit)?;
    let offset = page_offset(query.offset)?;
    let (items, has_more) = list_cluster_media(&state, user.id, cluster_id, limit, offset)
        .await
        .map_err(LibraryError::Database)?;
    Ok(no_store(Json(AlbumItemPage {
        items,
        limit,
        next_offset: has_more.then_some(offset + u32::from(limit)),
    })))
}

async fn list_cluster_media(
    state: &AppState,
    owner_id: Uuid,
    cluster_id: Uuid,
    limit: u16,
    offset: u32,
) -> Result<(Vec<MediaItem>, bool), sqlx::Error> {
    let mut items = sqlx::query_as::<_, MediaItem>(
        "SELECT DISTINCT entry.id, entry.name, idx.mime_type, idx.category, idx.size_bytes, \
                entry.created_at, entry.updated_at, idx.media \
           FROM face_observations AS observation \
           JOIN file_versions AS version ON version.id = observation.file_version_id \
           JOIN files AS file ON file.id = version.file_id AND file.current_version_id = version.id \
           JOIN drive_entries AS entry ON entry.id = file.id \
           JOIN entry_index AS idx ON idx.entry_id = entry.id \
          WHERE observation.cluster_id = $1 AND entry.owner_id = $2 \
            AND idx.deleted_at IS NULL AND NOT idx.buried \
          ORDER BY entry.created_at DESC, entry.id DESC \
          LIMIT $3 OFFSET $4",
    )
    .bind(cluster_id)
    .bind(owner_id)
    .bind(i64::from(limit) + 1)
    .bind(i64::from(offset))
    .fetch_all(&state.pool)
    .await?;
    let has_more = items.len() > usize::from(limit);
    items.truncate(usize::from(limit));
    Ok((items, has_more))
}

async fn list_photos(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Query(query): Query<PhotoQuery>,
) -> Result<Response, LibraryError> {
    let limit = page_limit(query.limit)?;
    let cursor = query.cursor.as_deref().map(parse_cursor).transpose()?;
    let (before_created, before_id) = cursor.unzip();
    let mut items = sqlx::query_as::<_, MediaItem>(
        "SELECT idx.entry_id AS id, idx.name, idx.mime_type, idx.category, idx.size_bytes, \
                idx.created_at, idx.updated_at, idx.media \
           FROM entry_index AS idx \
          WHERE idx.owner_id = $1 AND idx.deleted_at IS NULL AND NOT idx.buried \
            AND idx.category IN ('image', 'video') \
            AND ($2::timestamptz IS NULL OR idx.created_at < $2 \
                 OR (idx.created_at = $2 AND idx.entry_id < $3)) \
          ORDER BY idx.created_at DESC, idx.entry_id DESC \
          LIMIT $4",
    )
    .bind(user.id)
    .bind(before_created)
    .bind(before_id)
    .bind(i64::from(limit) + 1)
    .fetch_all(&state.pool)
    .await
    .map_err(LibraryError::Database)?;
    let has_more = items.len() > usize::from(limit);
    items.truncate(usize::from(limit));
    let next_cursor = if has_more {
        items
            .last()
            .map(|item| encode_cursor(item.created_at, item.id))
    } else {
        None
    };
    Ok(no_store(Json(PhotoPage {
        items,
        limit,
        next_cursor,
    })))
}

fn encode_cursor(created_at: DateTime<Utc>, id: Uuid) -> String {
    format!("{}|{id}", created_at.to_rfc3339())
}

fn parse_cursor(value: &str) -> Result<(DateTime<Utc>, Uuid), LibraryError> {
    let (stamp, id) = value.rsplit_once('|').ok_or(LibraryError::BadRequest)?;
    let created_at = DateTime::parse_from_rfc3339(stamp)
        .map_err(|_| LibraryError::BadRequest)?
        .with_timezone(&Utc);
    let id = Uuid::parse_str(id).map_err(|_| LibraryError::BadRequest)?;
    Ok((created_at, id))
}

#[derive(Serialize, FromRow)]
struct AlbumSummary {
    id: Uuid,
    name: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    item_count: i64,
    cover_file_id: Option<Uuid>,
}

#[derive(Serialize)]
struct AlbumList {
    albums: Vec<AlbumSummary>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AlbumNameBody {
    name: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AlbumItemsBody {
    file_ids: Vec<Uuid>,
}

async fn list_albums(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Response, LibraryError> {
    let albums = sqlx::query_as::<_, AlbumSummary>(
        "SELECT album.id, album.name, album.created_at, album.updated_at, \
                COUNT(item.file_id) FILTER (WHERE idx.entry_id IS NOT NULL)::BIGINT AS item_count, \
                (SELECT cover.file_id \
                   FROM album_items AS cover \
                   JOIN entry_index AS cover_index ON cover_index.entry_id = cover.file_id \
                  WHERE cover.album_id = album.id \
                    AND cover_index.deleted_at IS NULL AND NOT cover_index.buried \
                  ORDER BY cover.added_at DESC, cover.file_id DESC \
                  LIMIT 1) AS cover_file_id \
           FROM albums AS album \
           LEFT JOIN album_items AS item ON item.album_id = album.id \
           LEFT JOIN entry_index AS idx ON idx.entry_id = item.file_id \
                AND idx.deleted_at IS NULL AND NOT idx.buried \
          WHERE album.owner_id = $1 \
          GROUP BY album.id \
          ORDER BY album.updated_at DESC, album.id DESC",
    )
    .bind(user.id)
    .fetch_all(&state.pool)
    .await
    .map_err(LibraryError::Database)?;
    Ok(no_store(Json(AlbumList { albums })))
}

async fn create_album(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Json(body): Json<AlbumNameBody>,
) -> Result<Response, LibraryError> {
    require_csrf(&headers, &user, &state)?;
    let name = normalize_album_name(&body.name)?;
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO albums (id, owner_id, name) VALUES ($1, $2, $3)")
        .bind(id)
        .bind(user.id)
        .bind(&name)
        .execute(&state.pool)
        .await
        .map_err(map_album_error)?;
    let album = fetch_album(&state, user.id, id).await?;
    Ok(no_store((StatusCode::CREATED, Json(album))))
}

async fn get_album(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
) -> Result<Response, LibraryError> {
    Ok(no_store(Json(fetch_album(&state, user.id, id).await?)))
}

async fn rename_album(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<AlbumNameBody>,
) -> Result<Response, LibraryError> {
    require_csrf(&headers, &user, &state)?;
    let name = normalize_album_name(&body.name)?;
    let updated = sqlx::query(
        "UPDATE albums SET name = $1, updated_at = now() WHERE id = $2 AND owner_id = $3",
    )
    .bind(name)
    .bind(id)
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(map_album_error)?;
    if updated.rows_affected() != 1 {
        return Err(LibraryError::NotFound);
    }
    Ok(no_store(Json(fetch_album(&state, user.id, id).await?)))
}

async fn delete_album(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, LibraryError> {
    require_csrf(&headers, &user, &state)?;
    let deleted = sqlx::query("DELETE FROM albums WHERE id = $1 AND owner_id = $2")
        .bind(id)
        .bind(user.id)
        .execute(&state.pool)
        .await
        .map_err(LibraryError::Database)?;
    if deleted.rows_affected() != 1 {
        return Err(LibraryError::NotFound);
    }
    Ok(no_store(StatusCode::NO_CONTENT))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AlbumItemQuery {
    limit: Option<u16>,
    offset: Option<u32>,
}

#[derive(Serialize)]
struct AlbumItemPage {
    items: Vec<MediaItem>,
    limit: u16,
    next_offset: Option<u32>,
}

async fn list_album_items(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    Path(id): Path<Uuid>,
    Query(query): Query<AlbumItemQuery>,
) -> Result<Response, LibraryError> {
    ensure_album(&state, user.id, id).await?;
    let limit = page_limit(query.limit)?;
    let offset = page_offset(query.offset)?;
    let mut items = sqlx::query_as::<_, MediaItem>(
        "SELECT entry.id, entry.name, idx.mime_type, idx.category, idx.size_bytes, \
                entry.created_at, entry.updated_at, idx.media \
           FROM album_items AS item \
           JOIN entry_index AS idx ON idx.entry_id = item.file_id \
           JOIN drive_entries AS entry ON entry.id = item.file_id \
          WHERE item.album_id = $1 AND idx.owner_id = $2 \
            AND idx.deleted_at IS NULL AND NOT idx.buried \
          ORDER BY item.added_at DESC, entry.id DESC \
          LIMIT $3 OFFSET $4",
    )
    .bind(id)
    .bind(user.id)
    .bind(i64::from(limit) + 1)
    .bind(i64::from(offset))
    .fetch_all(&state.pool)
    .await
    .map_err(LibraryError::Database)?;
    let has_more = items.len() > usize::from(limit);
    items.truncate(usize::from(limit));
    Ok(no_store(Json(AlbumItemPage {
        items,
        limit,
        next_offset: has_more.then_some(offset + u32::from(limit)),
    })))
}

async fn add_album_items(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<AlbumItemsBody>,
) -> Result<Response, LibraryError> {
    mutate_album_items(&state, &user, &headers, id, &body.file_ids, true).await
}

async fn remove_album_items(
    State(state): State<AppState>,
    user: AuthenticatedUser,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(body): Json<AlbumItemsBody>,
) -> Result<Response, LibraryError> {
    mutate_album_items(&state, &user, &headers, id, &body.file_ids, false).await
}

async fn mutate_album_items(
    state: &AppState,
    user: &AuthenticatedUser,
    headers: &HeaderMap,
    album_id: Uuid,
    file_ids: &[Uuid],
    add: bool,
) -> Result<Response, LibraryError> {
    require_csrf(headers, user, state)?;
    if file_ids.is_empty() || file_ids.len() > MAX_ALBUM_FILES {
        return Err(LibraryError::BadRequest);
    }
    let mut unique = file_ids.to_vec();
    unique.sort();
    unique.dedup();
    ensure_album(state, user.id, album_id).await?;
    if add {
        let eligible: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM entry_index \
              WHERE owner_id = $1 AND entry_id = ANY($2) AND kind = 'file' \
                AND category IN ('image', 'video') AND deleted_at IS NULL AND NOT buried",
        )
        .bind(user.id)
        .bind(&unique)
        .fetch_one(&state.pool)
        .await
        .map_err(LibraryError::Database)?;
        if eligible != i64::try_from(unique.len()).unwrap_or(i64::MAX) {
            return Err(LibraryError::BadRequest);
        }
        sqlx::query(
            "INSERT INTO album_items (album_id, file_id) \
             SELECT $1, file_id FROM unnest($2::uuid[]) AS file_id \
             ON CONFLICT DO NOTHING",
        )
        .bind(album_id)
        .bind(&unique)
        .execute(&state.pool)
        .await
        .map_err(LibraryError::Database)?;
    } else {
        sqlx::query("DELETE FROM album_items WHERE album_id = $1 AND file_id = ANY($2)")
            .bind(album_id)
            .bind(&unique)
            .execute(&state.pool)
            .await
            .map_err(LibraryError::Database)?;
    }
    sqlx::query("UPDATE albums SET updated_at = now() WHERE id = $1 AND owner_id = $2")
        .bind(album_id)
        .bind(user.id)
        .execute(&state.pool)
        .await
        .map_err(LibraryError::Database)?;
    Ok(no_store(Json(
        json!({ "album_id": album_id, "count": unique.len() }),
    )))
}

async fn ensure_album(state: &AppState, owner_id: Uuid, id: Uuid) -> Result<(), LibraryError> {
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM albums WHERE id = $1 AND owner_id = $2)")
            .bind(id)
            .bind(owner_id)
            .fetch_one(&state.pool)
            .await
            .map_err(LibraryError::Database)?;
    if exists {
        Ok(())
    } else {
        Err(LibraryError::NotFound)
    }
}

async fn fetch_album(
    state: &AppState,
    owner_id: Uuid,
    id: Uuid,
) -> Result<AlbumSummary, LibraryError> {
    sqlx::query_as::<_, AlbumSummary>(
        "SELECT album.id, album.name, album.created_at, album.updated_at, \
                COUNT(item.file_id) FILTER (WHERE idx.entry_id IS NOT NULL)::BIGINT AS item_count, \
                (SELECT cover.file_id \
                   FROM album_items AS cover \
                   JOIN entry_index AS cover_index ON cover_index.entry_id = cover.file_id \
                  WHERE cover.album_id = album.id \
                    AND cover_index.deleted_at IS NULL AND NOT cover_index.buried \
                  ORDER BY cover.added_at DESC, cover.file_id DESC \
                  LIMIT 1) AS cover_file_id \
           FROM albums AS album \
           LEFT JOIN album_items AS item ON item.album_id = album.id \
           LEFT JOIN entry_index AS idx ON idx.entry_id = item.file_id \
                AND idx.deleted_at IS NULL AND NOT idx.buried \
          WHERE album.id = $1 AND album.owner_id = $2 \
          GROUP BY album.id",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(LibraryError::Database)?
    .ok_or(LibraryError::NotFound)
}

fn normalize_album_name(value: &str) -> Result<String, LibraryError> {
    let name = value.trim();
    let length = name.chars().count();
    if length == 0 || length > 120 || name.chars().any(|character| character.is_control()) {
        return Err(LibraryError::BadRequest);
    }
    Ok(name.to_owned())
}

fn map_album_error(error: sqlx::Error) -> LibraryError {
    match &error {
        sqlx::Error::Database(database_error)
            if database_error.code().as_deref() == Some("23505") =>
        {
            LibraryError::Conflict
        }
        _ => LibraryError::Database(error),
    }
}

#[derive(Serialize)]
struct AccountStorage {
    quota_bytes: Option<i64>,
    used_bytes: i64,
    reserved_bytes: i64,
    available_bytes: Option<i64>,
    percent_used: Option<f64>,
    unlimited: bool,
    by_category: Vec<CategoryUsage>,
}

#[derive(Serialize, FromRow)]
struct CategoryUsage {
    category: String,
    file_count: i64,
    size_bytes: i64,
}

#[derive(FromRow)]
struct UsageRow {
    quota_bytes: Option<i64>,
    used_bytes: i64,
    reserved_bytes: i64,
}

async fn account_storage(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Response, LibraryError> {
    let usage = usage_for(&state, user.id).await?;
    let quota_bytes = if user.role == "member" {
        usage.quota_bytes
    } else {
        i64::try_from(state.transfer_settings.owner_quota_bytes).ok()
    };
    let categories = categories_for(&state, Some(user.id)).await?;
    Ok(no_store(Json(storage_summary(
        quota_bytes,
        usage.used_bytes,
        usage.reserved_bytes,
        categories,
    ))))
}

fn storage_summary(
    quota_bytes: Option<i64>,
    used_bytes: i64,
    reserved_bytes: i64,
    by_category: Vec<CategoryUsage>,
) -> AccountStorage {
    let committed = used_bytes.saturating_add(reserved_bytes);
    let (available_bytes, percent_used, unlimited) = match quota_bytes {
        Some(quota) if quota > 0 => {
            let available = quota.saturating_sub(committed);
            let percent = (committed as f64) * 100.0 / (quota as f64);
            (Some(available), Some(percent), false)
        }
        _ => (None, None, true),
    };
    AccountStorage {
        quota_bytes,
        used_bytes,
        reserved_bytes,
        available_bytes,
        percent_used,
        unlimited,
        by_category,
    }
}

async fn usage_for(state: &AppState, owner_id: Uuid) -> Result<UsageRow, LibraryError> {
    sqlx::query_as::<_, UsageRow>(
        "SELECT account.quota_bytes, \
            (SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
               FROM drive_entries AS entry \
               JOIN files AS file ON file.id = entry.id \
               JOIN file_versions AS version ON version.id = file.current_version_id \
               JOIN storage_objects AS object ON object.id = version.storage_object_id \
                    AND object.state = 'ready' \
              WHERE entry.owner_id = account.id) AS used_bytes, \
            (SELECT COALESCE(SUM(expected_size), 0)::BIGINT \
               FROM upload_sessions \
              WHERE owner_id = account.id \
                AND (state = 'finalizing' OR (state = 'active' AND expires_at > now()))) \
                AS reserved_bytes \
           FROM users AS account \
          WHERE account.id = $1",
    )
    .bind(owner_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(LibraryError::Database)?
    .ok_or(LibraryError::NotFound)
}

async fn categories_for(
    state: &AppState,
    owner_id: Option<Uuid>,
) -> Result<Vec<CategoryUsage>, LibraryError> {
    sqlx::query_as::<_, CategoryUsage>(
        "SELECT category, COUNT(*)::BIGINT AS file_count, COALESCE(SUM(size_bytes), 0)::BIGINT AS size_bytes \
           FROM entry_index \
          WHERE kind = 'file' AND deleted_at IS NULL AND NOT buried \
            AND ($1::uuid IS NULL OR owner_id = $1) \
          GROUP BY category \
          ORDER BY size_bytes DESC, category ASC",
    )
    .bind(owner_id)
    .fetch_all(&state.pool)
    .await
    .map_err(LibraryError::Database)
}

#[derive(Serialize)]
struct ServerStorage {
    ssd: Option<VolumeStatus>,
    hdd: Option<VolumeStatus>,
    same_volume: bool,
    system_used_bytes: u64,
    library_bytes: i64,
    by_category: Vec<CategoryUsage>,
    users: Vec<UserStorage>,
}

#[derive(Serialize)]
struct VolumeStatus {
    total_bytes: u64,
    used_bytes: u64,
    free_bytes: u64,
    percent_used: f64,
}

#[derive(Serialize)]
struct UserStorage {
    id: Uuid,
    email: String,
    role: String,
    quota_bytes: Option<i64>,
    used_bytes: i64,
    percent_of_library: f64,
    percent_of_hdd: Option<f64>,
}

#[derive(FromRow)]
struct UserUsageRow {
    id: Uuid,
    email: String,
    role: String,
    quota_bytes: Option<i64>,
    used_bytes: i64,
}

async fn server_storage(
    State(state): State<AppState>,
    user: AuthenticatedUser,
) -> Result<Response, LibraryError> {
    if !matches!(user.role.as_str(), "owner" | "admin") {
        return Err(LibraryError::Forbidden);
    }
    let hdd = volume_from(state.storage.filesystem_usage());
    let ssd = state
        .media_preview
        .as_ref()
        .map(|preview| volume_from(preview.filesystem_usage()));
    let same_volume = match (&hdd, &ssd) {
        (Some(hdd), Some(Some(ssd))) => {
            hdd.total_bytes == ssd.total_bytes && hdd.free_bytes == ssd.free_bytes
        }
        _ => false,
    };
    let system_used_bytes = match (&hdd, &ssd, same_volume) {
        (Some(hdd), Some(Some(ssd)), false) => hdd.used_bytes.saturating_add(ssd.used_bytes),
        (Some(hdd), _, _) => hdd.used_bytes,
        (None, Some(Some(ssd)), _) => ssd.used_bytes,
        _ => 0,
    };
    let rows = sqlx::query_as::<_, UserUsageRow>(
        "SELECT account.id, account.email, account.role, account.quota_bytes, \
            (SELECT COALESCE(SUM(version.size_bytes), 0)::BIGINT \
               FROM drive_entries AS entry \
               JOIN files AS file ON file.id = entry.id \
               JOIN file_versions AS version ON version.id = file.current_version_id \
               JOIN storage_objects AS object ON object.id = version.storage_object_id \
                    AND object.state = 'ready' \
              WHERE entry.owner_id = account.id) AS used_bytes \
           FROM users AS account \
          ORDER BY used_bytes DESC, account.email ASC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(LibraryError::Database)?;
    let library_bytes = rows.iter().map(|row| row.used_bytes.max(0)).sum::<i64>();
    let hdd_total = hdd.as_ref().map(|volume| volume.total_bytes);
    let users = rows
        .into_iter()
        .map(|row| UserStorage {
            percent_of_library: percent_of(
                row.used_bytes.max(0) as u64,
                library_bytes.max(0) as u64,
            ),
            percent_of_hdd: hdd_total.map(|total| percent_of(row.used_bytes.max(0) as u64, total)),
            id: row.id,
            email: row.email,
            role: row.role,
            quota_bytes: row.quota_bytes,
            used_bytes: row.used_bytes,
        })
        .collect();
    Ok(no_store(Json(ServerStorage {
        ssd: ssd.flatten(),
        hdd,
        same_volume,
        system_used_bytes,
        library_bytes,
        by_category: categories_for(&state, None).await?,
        users,
    })))
}

fn volume_from(
    usage: Result<FilesystemUsage, crate::storage::StorageError>,
) -> Option<VolumeStatus> {
    match usage {
        Ok(usage) => Some(VolumeStatus {
            total_bytes: usage.total_bytes,
            used_bytes: usage.used_bytes(),
            free_bytes: usage.free_bytes,
            percent_used: percent_of(usage.used_bytes(), usage.total_bytes),
        }),
        Err(error) => {
            tracing::warn!(error = %error, "storage volume usage is unavailable");
            None
        }
    }
}

fn percent_of(part: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        (part as f64) * 100.0 / (total as f64)
    }
}

fn require_csrf(
    headers: &HeaderMap,
    user: &AuthenticatedUser,
    state: &AppState,
) -> Result<(), LibraryError> {
    if drive::require_request_csrf(headers, user, state.auth_settings).is_ok() {
        Ok(())
    } else {
        Err(LibraryError::Csrf)
    }
}

fn library_from_drive(error: DriveError) -> LibraryError {
    match error {
        DriveError::NotFound => LibraryError::NotFound,
        DriveError::BadRequest => LibraryError::BadRequest,
        DriveError::Conflict => LibraryError::Conflict,
        DriveError::Csrf => LibraryError::Csrf,
        DriveError::Database(error) => LibraryError::Database(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_requires_at_least_one_criterion() {
        let query = SearchQuery {
            q: Some("   ".to_owned()),
            category: None,
            mime: None,
            min_size: None,
            max_size: None,
            created_from: None,
            created_to: None,
            modified_from: None,
            modified_to: None,
            folder_id: None,
            limit: None,
            offset: None,
            sort_by: None,
            order: None,
        };
        assert!(compile_search(&query).is_err());
    }

    #[test]
    fn search_accepts_combined_filters() {
        let query = SearchQuery {
            q: Some("holiday".to_owned()),
            category: Some("image".to_owned()),
            mime: Some("image/jpeg".to_owned()),
            min_size: Some(10),
            max_size: Some(5_000_000),
            created_from: Some("2024-01-01".to_owned()),
            created_to: Some("2024-12-31".to_owned()),
            modified_from: None,
            modified_to: None,
            folder_id: None,
            limit: Some(25),
            offset: Some(0),
            sort_by: Some("size".to_owned()),
            order: Some("desc".to_owned()),
        };
        let bounds = compile_search(&query).expect("filters are valid");
        assert_eq!(bounds.term, "holiday");
        assert_eq!(bounds.category.as_deref(), Some("image"));
        assert_eq!(bounds.mime_prefix.as_deref(), Some("image/jpeg"));
        assert_eq!(bounds.sort_column, "idx.size_bytes");
        assert_eq!(bounds.direction, "DESC");
        assert_eq!(bounds.limit, 25);
    }

    #[test]
    fn mime_prefix_rejects_wildcards_inside_the_type() {
        assert!(normalize_mime_prefix("image/%").is_err());
        assert!(normalize_mime_prefix("not a mime").is_err());
        assert_eq!(normalize_mime_prefix("image/*").unwrap(), "image");
    }

    #[test]
    fn photo_cursor_round_trips() {
        let id = Uuid::nil();
        let created_at = DateTime::parse_from_rfc3339("2024-05-01T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let encoded = encode_cursor(created_at, id);
        let (parsed_at, parsed_id) = parse_cursor(&encoded).unwrap();
        assert_eq!(parsed_id, id);
        assert_eq!(parsed_at, created_at);
    }
}
