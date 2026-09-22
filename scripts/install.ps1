# Point the official Codex CLI at a CoCodex subscription gateway.
#
# The gateway serves this file with its own URL baked in, so the usual way to
# run it is:
#
#   irm https://<gateway>/install.ps1 | iex
#
# From a checkout the gateway URL is the first argument instead:
#
#   ./scripts/install.ps1 http://127.0.0.1:53141
#
# Writes ~/.codex/config.toml and persists the login issuer and refresh/revoke
# overrides as user environment variables. Codex does not read those OAuth
# URLs from config.toml. User-level variables (rather than the PowerShell
# profile) also reach the Codex desktop app started from the Start menu, so
# its "Sign in with ChatGPT" button logs in against the gateway through the
# browser, no device code needed.
param(
    [Parameter(Position = 0)]
    [string]$GatewayUrl,

    [switch]$Login,
    [switch]$Help
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Replaced by the gateway when it serves this script over HTTP; empty here.
$GatewayUrlDefault = ""

if ([string]::IsNullOrWhiteSpace($GatewayUrl)) {
    $GatewayUrl = $GatewayUrlDefault
}

function Show-Usage {
    @"
Usage: install.ps1 [gateway-url] [-Login]

  gateway-url   CoCodex gateway origin, e.g. http://127.0.0.1:53141
                Optional when the script was downloaded from a gateway.
  -Login        After writing config, run Codex device-code login
"@
}

if ($Help -or [string]::IsNullOrWhiteSpace($GatewayUrl)) {
    Show-Usage
    if ($Help) { exit 0 }
    exit 2
}

if ($GatewayUrl -notmatch '^https?://') {
    Write-Error "gateway-url must start with http:// or https://"
}

$GatewayUrl = $GatewayUrl.TrimEnd("/")
$OpenAiBaseUrl = "$GatewayUrl/backend-api/codex"
$ChatGptBaseUrl = "$GatewayUrl/backend-api"
$RefreshUrl = "$GatewayUrl/oauth/token"
$RevokeUrl = "$GatewayUrl/oauth/revoke"
# Codex appends /oauth/authorize, /oauth/token and the device-code paths.
$LoginIssuer = $GatewayUrl

$CodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
$Toml = Join-Path $CodexHome "config.toml"
$Begin = "# >>> cocodex-gateway >>>"
$End = "# <<< cocodex-gateway <<<"

New-Item -ItemType Directory -Force -Path $CodexHome | Out-Null

$existing = @()
if (Test-Path $Toml) {
    $existing = Get-Content -LiteralPath $Toml | Where-Object {
        $_ -notmatch '^openai_base_url\s*=' -and $_ -notmatch '^chatgpt_base_url\s*='
    }
}
@(
    "openai_base_url = `"$OpenAiBaseUrl`""
    "chatgpt_base_url = `"$ChatGptBaseUrl`""
    ""
) + $existing | Set-Content -LiteralPath $Toml -Encoding utf8

$GatewayEnv = [ordered]@{
    CODEX_APP_SERVER_LOGIN_ISSUER    = $LoginIssuer
    CODEX_REFRESH_TOKEN_URL_OVERRIDE = $RefreshUrl
    CODEX_REVOKE_TOKEN_URL_OVERRIDE  = $RevokeUrl
}
# The User scope lands in HKCU\Environment and is broadcast to Explorer, so
# apps launched from now on (including the MSIX desktop app) inherit it.
foreach ($name in $GatewayEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $GatewayEnv[$name], "User")
    Set-Item -Path "Env:$name" -Value $GatewayEnv[$name]
}

# Earlier versions of this script set the overrides in the PowerShell
# profile; the user variables above replace that block.
if (Test-Path -LiteralPath $PROFILE) {
    $profileText = Get-Content -LiteralPath $PROFILE -Raw
    if ($profileText -and $profileText.Contains($Begin)) {
        $pattern = "(?s)$([regex]::Escape($Begin)).*?$([regex]::Escape($End))\r?\n?"
        Set-Content -LiteralPath $PROFILE -Value ([regex]::Replace($profileText, $pattern, "").TrimEnd()) -Encoding utf8
        Write-Host "Removed the old CoCodex block from $PROFILE"
    }
}

Write-Host "Wrote $Toml"
Write-Host "  openai_base_url  = $OpenAiBaseUrl"
Write-Host "  chatgpt_base_url = $ChatGptBaseUrl"
foreach ($name in $GatewayEnv.Keys) {
    Write-Host "Set user env $name = $($GatewayEnv[$name])"
}
Write-Host "Open a new terminal to pick them up."
Write-Host ""
Write-Host "Codex desktop app:"
Write-Host "  quit it completely (including the tray icon), reopen it, then click `"Sign in with ChatGPT`"."
Write-Host ""
Write-Host "Codex CLI login (the CLI's browser login ignores a custom issuer):"
Write-Host "  codex login --device-auth --experimental_issuer $GatewayUrl"

if ($Login) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codex) {
        Write-Error "codex is not on PATH; skip -Login"
    }
    & codex login --device-auth --experimental_issuer $GatewayUrl
    exit $LASTEXITCODE
}
