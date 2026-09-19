//! One ChatGPT account logs in once per platform: same account_id, one row
//! per platform, and each platform resolves to its own login.

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

    for (platform, token) in [
        ("windows", "win-token"),
        ("linux", "linux-token"),
        ("darwin", "darwin-token"),
    ] {
        db::accounts::upsert(&db.pool, login(platform, token))
            .await
            .unwrap();
    }

    // Three coexisting rows, same account_id, one per platform.
    let rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM openai_accounts WHERE account_id = 'acct-shared'")
            .fetch_one(&db.pool)
            .await
            .unwrap();
    assert_eq!(rows, 3);

    // Each platform resolves to its own token.
    for (platform, token) in [
        ("windows", "win-token"),
        ("linux", "linux-token"),
        ("darwin", "darwin-token"),
    ] {
        let row = db::accounts::resolve_for_platform(&db.pool, "acct-shared", platform)
            .await
            .unwrap()
            .expect("login exists for platform");
        assert_eq!(row.platform(), platform);
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
    assert_eq!(rows, 3);
    let linux = db::accounts::resolve_for_platform(&db.pool, "acct-shared", "linux")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(linux.access_token, "linux-token-2");
}
