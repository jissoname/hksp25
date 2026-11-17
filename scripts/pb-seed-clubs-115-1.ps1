# Seed 115-1 club roster into hksp_clubs (idempotent by permanent_club_id).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$jsonFile = Join-Path $PSScriptRoot 'hksp-clubs-115-1.json'
if (-not (Test-Path $envFile)) { throw "Missing .env" }
if (-not (Test-Path $jsonFile)) { throw "Missing $jsonFile" }

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_.Split('=', 2)
  Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
}

$PB = $env:PB_URL.TrimEnd('/')
$activityId = if ($env:PB_ACTIVITY_ID) { $env:PB_ACTIVITY_ID } else { '115-1-club-evaluation' }
$clubs = [System.IO.File]::ReadAllText($jsonFile, [System.Text.Encoding]::UTF8) | ConvertFrom-Json

function Invoke-Pb([string]$Method, [string]$Path, $Body = $null, $Token = $null) {
  $headers = @{}
  if ($Token) { $headers.Authorization = $Token }
  $params = @{ Method = $Method; Uri = "$PB$Path"; Headers = $headers }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json; charset=utf-8'
    $json = $Body | ConvertTo-Json -Depth 8 -Compress
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  return Invoke-RestMethod @params
}

$admin = Invoke-Pb Post '/api/collections/_superusers/auth-with-password' @{
  identity = $env:PB_ADMIN_EMAIL
  password = $env:PB_ADMIN_PASSWORD
}
$T = $admin.token

# Expand category select to official 115-1 labels used by registration UI.
$col = Invoke-Pb Get '/api/collections/hksp_clubs' $null $T
$fields = @($col.fields | ForEach-Object {
  $f = $_ | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  if ($f.name -eq 'category') {
    $f.values = @(
      '全校自治性', '自治綜合性', '康樂性', '學藝性', '服務性', '體能性',
      '自治', '學藝', '體能', '服務', '康樂', '其他'
    )
  }
  $f
})
Invoke-Pb Patch "/api/collections/$($col.id)" @{ fields = $fields } $T | Out-Null
Write-Host 'UPDATED hksp_clubs.category values'

$filter = [uri]::EscapeDataString("activity_id=`"$activityId`"")
$actRes = Invoke-Pb Get "/api/collections/hksp_activities/records?filter=$filter&perPage=1" $null $T
if ($actRes.totalItems -lt 1) { throw "Activity $activityId missing" }
$activity = $actRes.items[0]

$created = 0
$updated = 0
foreach ($c in $clubs) {
  $permanentId = 'HKSP-{0:D3}' -f [int]$c.no
  $name = [string]$c.name
  $category = [string]$c.category
  $cf = [uri]::EscapeDataString("activity=`"$($activity.id)`" && permanent_club_id=`"$permanentId`"")
  $existing = Invoke-Pb Get "/api/collections/hksp_clubs/records?filter=$cf&perPage=1" $null $T
  $payload = @{
    activity = $activity.id
    permanent_club_id = $permanentId
    name = $name
    category = $category
    active = $true
  }
  if ($existing.totalItems -gt 0) {
    $id = $existing.items[0].id
    Invoke-Pb Patch "/api/collections/hksp_clubs/records/$id" $payload $T | Out-Null
    $updated += 1
  } else {
    Invoke-Pb Post '/api/collections/hksp_clubs/records' $payload $T | Out-Null
    $created += 1
  }
}

# Keep DEMO club for tests but mark clearly
$demoFilter = [uri]::EscapeDataString("activity=`"$($activity.id)`" && permanent_club_id=`"DEMO-CLUB-001`"")
$demo = Invoke-Pb Get "/api/collections/hksp_clubs/records?filter=$demoFilter&perPage=1" $null $T
if ($demo.totalItems -gt 0) {
  $did = $demo.items[0].id
  Invoke-Pb Patch "/api/collections/hksp_clubs/records/$did" @{
    name = '示範社團（測試）'
    category = '學藝性'
    active = $true
  } $T | Out-Null
}

$activeFilter = [uri]::EscapeDataString('activity="' + $activity.id + '" && active=true')
$list = Invoke-Pb Get "/api/collections/hksp_clubs/records?perPage=200&filter=$activeFilter" $null $T
Write-Host ("SEED clubs done created={0} updated={1} activeTotal={2}" -f $created, $updated, $list.totalItems)
