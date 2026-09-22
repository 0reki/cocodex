//! One ChatGPT account logs in once per platform — Windows and Linux are the
//! only two — with one row each, and every client resolves to the login that
//! serves it. A login stored as `darwin` before macOS clients moved onto the
//! Linux identity still serves them.

mod common;

use cocodex_proxy::db;
use cocodex_proxy::db::accounts::UpsertInput;

fn login(platform: &'static str, token: &str) -> UpsertInput {
    UpsertInput {
        email: "shared@example.com".into(),
        account_id: "acct-shared".into(),
        status: None,
        platform: Some(platform),
        id_token: "id".into(),
        access_token: token.into(),
        refresh_token: format!("refresh-{token}"),
    }
}

#[tokio::test]
async fn one_account_holds_a_login_per_platform() {
    let db = common::test_db().await;

    for (platform, token) in [("windows", "win-token"), ("linux", "linux-token")] {
        db::accounts::upsert(&db.pool, login(platform, token))
            .await
            .unwrap();
    }

    // Two coexisting rows, same account_id, one per platform.
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM openai_accounts WHERE account_id = 'acct-shared'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(rows, 2);

    // Each platform resolves to its own token, and a macOS client asks for
    // the Linux one.
    for (platform, token) in [
        ("windows", "win-token"),
        ("linux", "linux-token"),
        ("darwin", "linux-token"),
    ] {
        let row = db::accounts::resolve_for_platform(&db.pool, "acct-shared", platform)
            .await
            .unwrap()
            .expect("login exists for platform");
        assert_eq!(row.access_token, token);
    }

    // Re-logging one platform updates that row, not the others.
    db::accounts::upsert(&db.pool, login("linux", "linux-token-2"))
        .await
        .unwrap();
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM openai_accounts WHERE account_id = 'acct-shared'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(rows, 2);
    let linux = db::accounts::resolve_for_platform(&db.pool, "acct-shared", "linux")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(linux.access_token, "linux-token-2");
}

/// A login made before the two-platform scheme is stored as `darwin`; it
/// reads back as a Linux login and serves the clients that ask for one.
#[tokio::test]
async fn a_legacy_darwin_login_serves_linux() {
    let db = common::test_db().await;
    sqlx::query(
        "INSERT INTO openai_accounts (email, account_id, status, platform, id_token, \
         access_token, refresh_token) \
         VALUES ('legacy@example.com', 'acct-legacy', 'active', 'darwin', 'id', \
         'darwin-token', 'refresh-darwin')",
    )
    .execute(&db.pool)
    .await
    .unwrap();

    for platform in ["linux", "darwin"] {
        let row = db::accounts::resolve_for_platform(&db.pool, "acct-legacy", platform)
            .await
            .unwrap()
            .expect("the legacy login serves this client");
        assert_eq!(row.access_token, "darwin-token");
        assert_eq!(row.platform(), "linux");
    }

    // It is not a Windows login, though.
    assert!(
        db::accounts::resolve_for_platform(&db.pool, "acct-legacy", "windows")
            .await
            .unwrap()
            .is_none()
    );
}
