//! Which portal user each ChatGPT conversation and project belongs to.

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

/// What is bound: each lives in its own table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Conversation,
    Project,
}

impl Kind {
    /// The table and its id column.
    fn table(self) -> (&'static str, &'static str) {
        match self {
            Kind::Conversation => ("conversation_owners", "conversation_id"),
            Kind::Project => ("project_owners", "project_id"),
        }
    }
}

fn owner_uuid(owner: &str) -> Option<Uuid> {
    Uuid::parse_str(owner.trim()).ok()
}

/// Binds `conversation_id` (a conversation or project, by `kind`) to `owner`
/// unless it is already bound, and says whose it is afterwards.
pub async fn bind(
    pool: &PgPool,
    kind: Kind,
    conversation_id: &str,
    owner: &str,
    account_id: &str,
) -> Result<Ownership, sqlx::Error> {
    let Some(owner) = owner_uuid(owner) else {
        return Ok(Ownership::Other);
    };
    let (table, column) = kind.table();
    let bound: Option<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        r#"
        WITH inserted AS (
          INSERT INTO {table} ({column}, owner_user_id, account_id)
          VALUES ($1, $2, $3)
          ON CONFLICT ({column}) DO NOTHING
          RETURNING owner_user_id
        )
        SELECT owner_user_id FROM inserted
        UNION ALL
        SELECT owner_user_id FROM {table} WHERE {column} = $1
        LIMIT 1
        "#
    )))
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
            match ownership(pool, kind, conversation_id, &owner.to_string()).await? {
                Ownership::Own => Ownership::Own,
                _ => Ownership::Other,
            },
        ),
    }
}

pub async fn ownership(
    pool: &PgPool,
    kind: Kind,
    conversation_id: &str,
    owner: &str,
) -> Result<Ownership, sqlx::Error> {
    let (table, column) = kind.table();
    let bound: Option<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT owner_user_id FROM {table} WHERE {column} = $1"
    )))
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(match bound {
        None => Ownership::Unknown,
        Some(bound) if Some(bound) == owner_uuid(owner) => Ownership::Own,
        Some(_) => Ownership::Other,
    })
}

/// Every conversation (or project) bound to `owner`.
pub async fn owned(pool: &PgPool, kind: Kind, owner: &str) -> Result<HashSet<String>, sqlx::Error> {
    let Some(owner) = owner_uuid(owner) else {
        return Ok(HashSet::new());
    };
    let (table, column) = kind.table();
    let ids: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!(
        "SELECT {column} FROM {table} WHERE owner_user_id = $1"
    )))
    .bind(owner)
    .fetch_all(pool)
    .await?;
    Ok(ids.into_iter().collect())
}
