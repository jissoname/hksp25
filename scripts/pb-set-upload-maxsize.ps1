# Set hksp_uploads.file.maxSize (default 100 GiB). Uses .env PB_ADMIN_*.
param(
  [long]$MaxSizeBytes = 107374182400
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$') {
      $k = $Matches[1]; $v = $Matches[2].Trim().Trim('"').Trim("'")
      if (-not [string]::IsNullOrWhiteSpace($k) -and -not (Test-Path "Env:$k")) {
        Set-Item -Path "Env:$k" -Value $v
      }
    }
  }
}

$base = ($env:PB_URL -replace '/$', '')
if (-not $base) { $base = 'https://db.keson.pro' }
$email = $env:PB_ADMIN_EMAIL
$pass = $env:PB_ADMIN_PASSWORD
if (-not $email -or -not $pass) { throw 'Missing PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD' }

$auth = Invoke-RestMethod -Method Post -Uri "$base/api/collections/_superusers/auth-with-password" `
  -ContentType 'application/json' `
  -Body (@{ identity = $email; password = $pass } | ConvertTo-Json)
$token = $auth.token
$headers = @{ Authorization = $token }

$col = Invoke-RestMethod -Method Get -Uri "$base/api/collections/hksp_uploads" -Headers $headers
$fileField = @($col.fields | Where-Object { $_.name -eq 'file' -and $_.type -eq 'file' })[0]
if (-not $fileField) { throw 'hksp_uploads.file field not found' }

$before = [long]$fileField.maxSize
$fileField.maxSize = $MaxSizeBytes
$payload = @{
  fields = $col.fields
}
$body = $payload | ConvertTo-Json -Depth 30
$updated = Invoke-RestMethod -Method Patch -Uri "$base/api/collections/hksp_uploads" `
  -Headers $headers -ContentType 'application/json; charset=utf-8' -Body $body
$afterField = @($updated.fields | Where-Object { $_.name -eq 'file' })[0]
Write-Output ("UPLOAD_MAXSIZE before={0} after={1} requested={2}" -f $before, [long]$afterField.maxSize, $MaxSizeBytes)
