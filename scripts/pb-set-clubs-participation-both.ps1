# Set all active clubs' meta_json.participation = "both" (評選＋特色皆可上傳).
# Requires PocketBase _superusers creds in repo-root .env (PB_ADMIN_*).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw "Missing .env" }

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_.Split('=', 2)
  Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
}

$PB = ($env:PB_URL).TrimEnd('/')
$activityId = if ($env:PB_ACTIVITY_ID) { $env:PB_ACTIVITY_ID } else { '115-1-club-evaluation' }
$colClubs = if ($env:PB_COL_CLUBS) { $env:PB_COL_CLUBS } else { 'hksp_clubs' }
$colActs = if ($env:PB_COL_ACTIVITIES) { $env:PB_COL_ACTIVITIES } else { 'hksp_activities' }

function Invoke-Pb([string]$Method, [string]$Path, $Body = $null, $Token = $null) {
  $headers = @{}
  if ($Token) { $headers.Authorization = $Token }
  $params = @{ Method = $Method; Uri = "$PB$Path"; Headers = $headers }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json; charset=utf-8'
    $json = $Body | ConvertTo-Json -Depth 10 -Compress
    $params.Body = [System.Text.Encoding]::UTF8.GetBytes($json)
  }
  return Invoke-RestMethod @params
}

$Token = $env:PB_ADMIN_TOKEN
if (-not $Token) {
  if (-not $env:PB_ADMIN_EMAIL -or -not $env:PB_ADMIN_PASSWORD) {
    throw 'Fill PB_ADMIN_TOKEN or PB_ADMIN_EMAIL + PB_ADMIN_PASSWORD in .env first'
  }
  $admin = Invoke-Pb Post '/api/collections/_superusers/auth-with-password' @{
    identity = $env:PB_ADMIN_EMAIL
    password = $env:PB_ADMIN_PASSWORD
  }
  $Token = $admin.token
}

$filter = [uri]::EscapeDataString("activity_id=`"$activityId`"")
$actRes = Invoke-Pb Get "/api/collections/$colActs/records?filter=$filter&perPage=1" $null $Token
if ($actRes.totalItems -lt 1) { throw "Activity $activityId missing" }
$activity = $actRes.items[0]

$page = 1
$updated = 0
$already = 0
$total = 0
do {
  $clubFilter = [uri]::EscapeDataString("activity=`"$($activity.id)`" && active=true")
  $res = Invoke-Pb Get "/api/collections/$colClubs/records?filter=$clubFilter&perPage=100&page=$page" $null $Token
  $total = [int]$res.totalItems
  foreach ($club in @($res.items)) {
    $meta = @{}
    if ($club.meta_json -is [hashtable]) {
      $meta = @{} + $club.meta_json
    } elseif ($club.meta_json -is [pscustomobject]) {
      $club.meta_json.PSObject.Properties | ForEach-Object { $meta[$_.Name] = $_.Value }
    }
    $cur = [string]$meta.participation
    if ($cur.Trim().ToLower() -eq 'both') {
      $already += 1
      continue
    }
    $meta.participation = 'both'
    Invoke-Pb Patch "/api/collections/$colClubs/records/$($club.id)" @{ meta_json = $meta } $Token | Out-Null
    $updated += 1
    Write-Host ("SET both  {0}  {1}" -f $club.permanent_club_id, $club.name)
  }
  $page += 1
} while (($page - 1) * 100 -lt $total)

Write-Host ("DONE activity={0} totalActive={1} updated={2} alreadyBoth={3}" -f $activityId, $total, $updated, $already)
