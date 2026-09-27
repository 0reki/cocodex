//! Which portal user each ChatGPT conversation belongs to.

use std::collections::HashSet;

use sqlx::PgPool;
use uuid::Uuid;

/// Whose a conversation is, as far as the gateway knows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ownership {
    /// Bound to the asking user.
    Own,
    /// Bound to someone else.
    Other,
    /// Never bound: no request through the gateway has named it.
    Unknown,
}

fn owner_uuid(owner: &str) -> Option<Uuid> {
    Uuid::parse_str(owner.trim()).ok()
}

/// Binds `conversation_id` to `owner` unless it is already bound, and says
/// whose it is afterwards.
pub async fn bind(
    pool: &PgPool,
    conversation_id: &str,
    owner: &str,
    account_id: &str,
) -> Result<Ownership, sqlx::Error> {
    let Some(owner) = owner_uuid(owner) else {
        return Ok(Ownership::Other);
    };
    let bound: Option<Uuid> = sqlx::query_scalar(
        r#"
        WITH inserted AS (
          INSERT INTO conversation_owners (conversation_id, owner_user_id, account_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (conversation_id) DO NOTHING
          RETURNING owner_user_id
        )
        SELECT owner_user_id FROM inserted
        UNION ALL
        SELECT owner_user_id FROM conversation_owners WHERE conversation_id = $1
        LIMIT 1
        "#,
    )
    .bind(conversation_id)
    .bind(owner)
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    match bound {
        Some(bound) if bound == owner => Ok(Ownership::Own),
        Some(_) => Ok(Ownership::Other),
        // Bound by a request that committed after this statement's snapshot.
        None => Ok(
            match ownership(pool, conversation_id, &owner.to_string()).await? {
                Ownership::Own => Ownership::Own,
                _ => Ownership::Other,
            },
        ),
    }
}

pub async fn ownership(
    pool: &PgPool,
    conversation_id: &str,
    owner: &str,
) -> Result<Ownership, sqlx::Error> {
    let bound: Option<Uuid> = sqlx::query_scalar(
        "SELECT owner_user_id FROM conversation_owners WHERE conversation_id = $1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(match bound {
        None => Ownership::Unknown,
        Some(bound) if Some(bound) == owner_uuid(owner) => Ownership::Own,
        Some(_) => Ownership::Other,
    })
}

/// Every conversation bound to `owner`.
pub async fn owned(pool: &PgPool, owner: &str) -> Result<HashSet<String>, sqlx::Error> {
    let Some(owner) = owner_uuid(owner) else {
        return Ok(HashSet::new());
    };
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT conversation_id FROM conversation_owners WHERE owner_user_id = $1",
    )
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(ids.into_iter().collect())
}
