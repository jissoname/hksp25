# List hksp_students (superuser). Does not print secrets.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pb-list-students.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw "Missing .env at $envFile" }

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_.Split('=', 2)
  Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim().Trim('"').Trim("'")
}

$PB = ($env:PB_URL).TrimEnd('/')
if (-not $PB) { throw 'PB_URL missing' }

function Invoke-Pb([string]$Method, [string]$Path, $Body = $null, $Token = $null) {
  $headers = @{}
  if ($Token) { $headers.Authorization = $Token }
  $params = @{ Method = $Method; Uri = "$PB$Path"; Headers = $headers }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  return Invoke-RestMethod @params
}

$Token = $env:PB_ADMIN_TOKEN
if (-not $Token) {
  if (-not $env:PB_ADMIN_EMAIL -or -not $env:PB_ADMIN_PASSWORD) {
    throw 'Fill PB_ADMIN_TOKEN or PB_ADMIN_EMAIL + PB_ADMIN_PASSWORD in .env first'
  }
  $auth = Invoke-Pb Post '/api/collections/_superusers/auth-with-password' @{
    identity = $env:PB_ADMIN_EMAIL
    password = $env:PB_ADMIN_PASSWORD
  }
  $Token = $auth.token
}

$page = 1
$all = @()
do {
  $res = Invoke-Pb Get "/api/collections/hksp_students/records?page=$page&perPage=200&sort=student_id" $null $Token
  $all += $res.items
  $page++
} while ($page -le [int]$res.totalPages)

$normal = @()
$soft = @()
foreach ($row in $all) {
  $sid = [string]$row.student_id
  $em = [string]$row.email
  $isSoft =
    ($sid -match '^W[a-zA-Z0-9]+$') -or
    ($sid -match '__WRR__') -or
    ($em -match '^w\d') -or
    ($em -match '^wrr\.') -or
    ($em -match '^deleted\+')
  $line = [pscustomobject]@{
    student_id = $sid
    email      = $em
    active     = $row.active
    id         = $row.id
  }
  if ($isSoft) { $soft += $line } else { $normal += $line }
}

Write-Host ("TOTAL=" + $all.Count)
Write-Host ("NORMAL=" + $normal.Count)
Write-Host ("SOFT_TOMBSTONE=" + $soft.Count)
Write-Host ''
Write-Host '=== 一般學號（看起來仍可登入／佔用） ==='
if ($normal.Count -eq 0) {
  Write-Host '(無)'
} else {
  $normal | Sort-Object student_id | ForEach-Object {
    Write-Host ("{0}`tactive={1}`temail={2}" -f $_.student_id, $_.active, $_.email)
  }
}
Write-Host ''
Write-Host '=== 軟刪殘留（學號已改名，可能仍佔 Email） ==='
if ($soft.Count -eq 0) {
  Write-Host '(無)'
} else {
  $soft | Sort-Object student_id | ForEach-Object {
    Write-Host ("{0}`tactive={1}`temail={2}" -f $_.student_id, $_.active, $_.email)
  }
}
