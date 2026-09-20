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
# Writes ~/.codex/config.toml and persists refresh/revoke env vars in the
# PowerShell profile. Codex does not read those OAuth URLs from config.toml.
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

if (-not (Test-Path $PROFILE)) {
    New-Item -ItemType File -Force -Path $PROFILE | Out-Null
}

$profileText = Get-Content -LiteralPath $PROFILE -Raw
if ($null -eq $profileText) { $profileText = "" }
$pattern = "(?s)$([regex]::Escape($Begin)).*?$([regex]::Escape($End))\r?\n?"
$profileText = [regex]::Replace($profileText, $pattern, "")
$block = @"
$Begin
# Managed by the CoCodex install script. Delete this block to undo.
`$env:CODEX_REFRESH_TOKEN_URL_OVERRIDE = "$RefreshUrl"
`$env:CODEX_REVOKE_TOKEN_URL_OVERRIDE = "$RevokeUrl"
$End

"@
Set-Content -LiteralPath $PROFILE -Value ($profileText.TrimEnd() + "`n" + $block) -Encoding utf8

$env:CODEX_REFRESH_TOKEN_URL_OVERRIDE = $RefreshUrl
$env:CODEX_REVOKE_TOKEN_URL_OVERRIDE = $RevokeUrl

Write-Host "Wrote $Toml"
Write-Host "  openai_base_url  = $OpenAiBaseUrl"
Write-Host "  chatgpt_base_url = $ChatGptBaseUrl"
Write-Host "Hooked $PROFILE (open a new PowerShell, or re-run this session after `. `$PROFILE`)"
Write-Host ""
Write-Host "Login with:"
Write-Host "  codex login --device-auth --experimental_issuer $GatewayUrl"

if ($Login) {
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if (-not $codex) {
        Write-Error "codex is not on PATH; skip -Login"
    }
    & codex login --device-auth --experimental_issuer $GatewayUrl
    exit $LASTEXITCODE
}
