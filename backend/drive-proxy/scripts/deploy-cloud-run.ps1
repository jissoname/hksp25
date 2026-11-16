#Requires -Version 5.1
<#
  Deploy HKSP Drive Proxy to Google Cloud Run (always-on without your PC).

  Prerequisites:
    - gcloud CLI installed and logged in
    - Billing enabled on the GCP project
    - backend/drive-proxy/.env already filled

  Usage:
    powershell -File scripts/deploy-cloud-run.ps1
    powershell -File scripts/deploy-cloud-run.ps1 -ProjectId keson789 -Region asia-east1
#>
param(
  [string]$ProjectId = "",
  [string]$Region = "asia-east1",
  [string]$ServiceName = "hksp-drive-proxy"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path $PSScriptRoot -Parent
$envFile = Join-Path $Root ".env"

function Read-DotEnv([string]$path) {
  $map = @{}
  Get-Content $path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $i = $line.IndexOf("=")
    if ($i -gt 0) { $map[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() }
  }
  return $map
}

if (-not (Test-Path $envFile)) { throw "Missing $envFile — put Google/PB secrets there first." }
$vars = Read-DotEnv $envFile

if (-not $ProjectId) {
  $ProjectId = (gcloud config get-value project 2>$null).Trim()
}
if (-not $ProjectId -or $ProjectId -eq "(unset)") {
  throw "Set GCP project: gcloud config set project YOUR_PROJECT_ID"
}

Write-Host "Project=$ProjectId Region=$Region Service=$ServiceName"

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com --project $ProjectId | Out-Null

$required = @(
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_HOLDER_EMAIL",
  "DRIVE_ROOT_FOLDER_ID",
  "PB_URL"
)
foreach ($k in $required) {
  if (-not $vars.ContainsKey($k) -or -not $vars[$k]) { throw "Missing $k in .env" }
}

# Cloud Run will set PORT=8080. PUBLIC_BASE_URL is patched after first deploy if empty.
$envPairs = @(
  "DRIVE_ENABLED=true",
  "HOST=0.0.0.0",
  "PB_URL=$($vars.PB_URL)",
  "GOOGLE_CLIENT_ID=$($vars.GOOGLE_CLIENT_ID)",
  "GOOGLE_CLIENT_SECRET=$($vars.GOOGLE_CLIENT_SECRET)",
  "GOOGLE_REFRESH_TOKEN=$($vars.GOOGLE_REFRESH_TOKEN)",
  "GOOGLE_HOLDER_EMAIL=$($vars.GOOGLE_HOLDER_EMAIL)",
  "DRIVE_ROOT_FOLDER_ID=$($vars.DRIVE_ROOT_FOLDER_ID)"
)
if ($vars.ContainsKey("PB_SERVICE_EMAIL") -and $vars.PB_SERVICE_EMAIL) {
  $envPairs += "PB_SERVICE_EMAIL=$($vars.PB_SERVICE_EMAIL)"
}
if ($vars.ContainsKey("PB_SERVICE_PASSWORD") -and $vars.PB_SERVICE_PASSWORD) {
  $envPairs += "PB_SERVICE_PASSWORD=$($vars.PB_SERVICE_PASSWORD)"
}
if ($vars.ContainsKey("PUBLIC_BASE_URL") -and $vars.PUBLIC_BASE_URL) {
  $envPairs += "PUBLIC_BASE_URL=$($vars.PUBLIC_BASE_URL)"
}

$setEnv = ($envPairs -join ",")

Write-Host "Deploying (source build)... this may take a few minutes"
gcloud run deploy $ServiceName `
  --project $ProjectId `
  --region $Region `
  --source $Root `
  --allow-unauthenticated `
  --memory 512Mi `
  --cpu 1 `
  --timeout 300 `
  --max-instances 3 `
  --set-env-vars $setEnv

$url = (gcloud run services describe $ServiceName --project $ProjectId --region $Region --format="value(status.url)").Trim()
Write-Host ""
Write-Host "SERVICE_URL=$url"

# Patch PUBLIC_BASE_URL to the real Cloud Run URL
gcloud run services update $ServiceName `
  --project $ProjectId `
  --region $Region `
  --update-env-vars "PUBLIC_BASE_URL=$url" | Out-Null

Write-Host ""
Write-Host "Health check:"
curl.exe -sS "$url/health"
Write-Host ""
Write-Host ""
Write-Host "Next: set pb-config.js driveProxyUrl to:"
Write-Host "  $url"
Write-Host "And PocketBase hksp_drive_config.proxy_base_url to the same URL."
