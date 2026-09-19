use sqlx::PgPool;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct PortalUser {
    pub id: String,
    pub username: String,
    pub role: String,
    pub enabled: bool,
    /// `quota IS NULL OR used < quota`, computed in SQL to avoid NUMERIC decoding.
    pub within_quota: bool,
}

pub async fn find_by_id(pool: &PgPool, id: &str) -> Result<Option<PortalUser>, sqlx::Error> {
    let Ok(id) = Uuid::parse_str(id.trim()) else {
        return Ok(None);
    };
    sqlx::query_as::<_, PortalUser>(
        r#"
        SELECT
          id::text AS id,
          username,
          role,
          enabled,
          (quota IS NULL OR used < quota) AS within_quota
        FROM portal_users
        WHERE id = $1
        "#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}
