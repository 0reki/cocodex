//! Quota profiles: what users may consume, managed by admins.

use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, put};
use axum::{Json, Router};
use serde_json::{Map, Value, json};

use super::{Body, Db, fail, internal};
use crate::AppState;
use crate::db;
use crate::db::profiles::{DeleteOutcome, ProfileChanges, QuotaProfile, UserQuotaSettings};

/// The keys a user's overrides may carry, as the console names them.
const OVERRIDE_KEYS: [&str; 4] = [
    "weeklySharePercent",
    "deepResearchLimit",
    "imageGenLimit",
    "proMessageLimit",
];

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/quota-profiles", get(list).post(create))
        .route("/api/quota-profiles/{id}", put(update).delete(remove))
        .route("/api/users/{id}/quota-profile", put(set_user_profile))
}

pub fn public_profile(profile: &QuotaProfile) -> Value {
    json!({
        "id": profile.id,
        "name": profile.name,
        "isDefault": profile.is_default,
        "weeklySharePercent": profile.weekly_share_percent,
        "deepResearchLimit": profile.deep_research_limit,
        "imageGenLimit": profile.image_gen_limit,
        "proMessageLimit": profile.pro_message_limit,
        "userCount": profile.user_count,
        "createdAt": db::iso(profile.created_at),
        "updatedAt": db::iso(profile.updated_at),
    })
}

/// A user's quota settings for the user list.
pub fn public_user_quota(settings: &UserQuotaSettings) -> Value {
    json!({
        "profileId": settings.profile_id,
        "profileName": settings.profile_name,
        "overrides": settings.overrides,
        "effective": {
            "weeklySharePercent": settings.weekly_share_percent,
            "deepResearchLimit": settings.deep_research_limit,
            "imageGenLimit": settings.image_gen_limit,
            "proMessageLimit": settings.pro_message_limit,
        },
    })
}

fn share_percent(value: &Value) -> Result<f64, Response> {
    value
        .as_f64()
        .filter(|percent| (0.0..=100.0).contains(percent))
        .ok_or_else(|| {
            fail(
                StatusCode::BAD_REQUEST,
                "weeklySharePercent must be a number from 0 to 100",
            )
        })
}

/// A feature limit: a non-negative whole number, or `null` for none.
fn limit(key: &str, value: &Value) -> Result<Option<i32>, Response> {
    match value {
        Value::Null => Ok(None),
        value => value
            .as_i64()
            .and_then(|n| i32::try_from(n).ok())
            .filter(|n| *n >= 0)
            .map(Some)
            .ok_or_else(|| {
                fail(
                    StatusCode::BAD_REQUEST,
                    format!("{key} must be a non-negative integer or null"),
                )
            }),
    }
}

fn changes(body: &Body) -> Result<ProfileChanges, Response> {
    let fields = &body.0;
    let name = match fields.get("name") {
        None => None,
        Some(Value::String(name)) if !name.trim().is_empty() => Some(name.trim().to_string()),
        Some(_) => {
            return Err(fail(
                StatusCode::BAD_REQUEST,
                "name must be a non-empty string",
            ));
        }
    };
    Ok(ProfileChanges {
        name,
        weekly_share_percent: fields
            .get("weeklySharePercent")
            .map(share_percent)
            .transpose()?,
        deep_research_limit: fields
            .get("deepResearchLimit")
            .map(|value| limit("deepResearchLimit", value))
            .transpose()?,
        image_gen_limit: fields
            .get("imageGenLimit")
            .map(|value| limit("imageGenLimit", value))
            .transpose()?,
        pro_message_limit: fields
            .get("proMessageLimit")
            .map(|value| limit("proMessageLimit", value))
            .transpose()?,
    })
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .is_some_and(|db| db.code().as_deref() == Some("23505"))
}

async fn list(Db(ready): Db) -> Response {
    match db::profiles::list(&ready.db).await {
        Ok(profiles) => Json(json!({
            "items": profiles.iter().map(public_profile).collect::<Vec<_>>(),
        }))
        .into_response(),
        Err(error) => internal(error),
    }
}

async fn respond_with(ready: &crate::runtime::Ready, id: &str) -> Response {
    match db::profiles::get(&ready.db, id).await {
        Ok(Some(profile)) => {
            Json(json!({ "ok": true, "profile": public_profile(&profile) })).into_response()
        }
        Ok(None) => fail(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) => internal(error),
    }
}

async fn create(Db(ready): Db, body: Body) -> Response {
    let changes = match changes(&body) {
        Ok(changes) => changes,
        Err(response) => return response,
    };
    if changes.name.is_none() {
        return fail(StatusCode::BAD_REQUEST, "name is required");
    }
    match db::profiles::create(&ready.db, &changes).await {
        Ok(id) => respond_with(&ready, &id).await,
        Err(error) if is_unique_violation(&error) => {
            fail(StatusCode::CONFLICT, "a profile with this name exists")
        }
        Err(error) => internal(error),
    }
}

async fn update(Db(ready): Db, Path(id): Path<String>, body: Body) -> Response {
    let changes = match changes(&body) {
        Ok(changes) => changes,
        Err(response) => return response,
    };
    match db::profiles::update(&ready.db, &id, &changes).await {
        Ok(true) => {
            // Every user on the profile now has other limits.
            ready.evict_owner("").await;
            respond_with(&ready, &id).await
        }
        Ok(false) => fail(StatusCode::NOT_FOUND, "profile not found"),
        Err(error) if is_unique_violation(&error) => {
            fail(StatusCode::CONFLICT, "a profile with this name exists")
        }
        Err(error) => internal(error),
    }
}

async fn remove(Db(ready): Db, Path(id): Path<String>) -> Response {
    match db::profiles::delete(&ready.db, &id).await {
        Ok(DeleteOutcome::Deleted) => {
            // Its users fall back to the default profile.
            ready.evict_owner("").await;
            Json(json!({ "ok": true })).into_response()
        }
        Ok(DeleteOutcome::NotFound) => fail(StatusCode::NOT_FOUND, "profile not found"),
        Ok(DeleteOutcome::IsDefault) => fail(
            StatusCode::CONFLICT,
            "the default profile cannot be deleted",
        ),
        Err(error) => internal(error),
    }
}

/// `{ profileId: string | null, overrides: { weeklySharePercent?, deepResearchLimit?, imageGenLimit?, proMessageLimit? } }`:
/// `profileId` null puts the user on the default profile; each override key
/// present replaces the profile's value (a null limit means none).
async fn set_user_profile(Db(ready): Db, Path(id): Path<String>, body: Body) -> Response {
    let profile_id = match body.0.get("profileId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if !id.trim().is_empty() => Some(id.trim().to_string()),
        Some(_) => {
            return fail(
                StatusCode::BAD_REQUEST,
                "profileId must be a string or null",
            );
        }
    };
    let mut overrides = Map::new();
    match body.0.get("overrides") {
        None | Some(Value::Null) => {}
        Some(Value::Object(given)) => {
            for (key, value) in given {
                let checked = match key.as_str() {
                    "weeklySharePercent" => share_percent(value).map(Value::from),
                    "deepResearchLimit" | "imageGenLimit" | "proMessageLimit" => {
                        limit(key, value).map(|limit| json!(limit))
                    }
                    _ => {
                        return fail(
                            StatusCode::BAD_REQUEST,
                            format!("unknown override {key}; expected one of {OVERRIDE_KEYS:?}"),
                        );
                    }
                };
                match checked {
                    Ok(value) => {
                        overrides.insert(key.clone(), value);
                    }
                    Err(response) => return response,
                }
            }
        }
        Some(_) => return fail(StatusCode::BAD_REQUEST, "overrides must be an object"),
    }
    match db::profiles::set_user_profile(
        &ready.db,
        &id,
        profile_id.as_deref(),
        &Value::Object(overrides),
    )
    .await
    {
        Ok(true) => {
            ready.evict_owner(&id).await;
            let settings = db::profiles::user_settings(&ready.db).await;
            match settings {
                Ok(settings) => {
                    let quota = settings
                        .iter()
                        .find(|s| s.user_id == id)
                        .map(public_user_quota);
                    Json(json!({ "ok": true, "quota": quota })).into_response()
                }
                Err(error) => internal(error),
            }
        }
        Ok(false) => fail(StatusCode::NOT_FOUND, "user or profile not found"),
        Err(error) => internal(error),
    }
}
