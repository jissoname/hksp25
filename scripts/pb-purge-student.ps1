# Superuser purge of one leftover hksp_students row by student_id / email / username.
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/pb-purge-student.ps1 -StudentId U112P214
param(
  [Parameter(Mandatory = $true)]
  [string]$StudentId
)
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
  $params = @{
    Method  = $Method
    Uri     = "$PB$Path"
    Headers = $headers
  }
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

$normalized = $StudentId.Trim().ToUpperInvariant()
$email = ($normalized.ToLowerInvariant() + '@stu.hksp25.invalid')
Write-Host "TARGET student_id=$normalized email=$email"

$studentsCol = 'hksp_students'
$memCol = 'hksp_memberships'

# Fetch all students (superuser) and match loosely.
$page = 1
$matches = @()
do {
  $res = Invoke-Pb Get "/api/collections/$studentsCol/records?page=$page&perPage=200" $null $Token
  foreach ($row in $res.items) {
    $sid = [string]$row.student_id
    $em = [string]$row.email
    $un = [string]$row.username
    $hit =
      ($sid -and $sid.ToUpperInvariant() -eq $normalized) -or
      ($em -and $em.ToLowerInvariant() -eq $email) -or
      ($un -and $un.ToLowerInvariant() -eq $email) -or
      ($sid -and $sid.ToUpperInvariant().Contains($normalized)) -or
      ($em -and $em.ToLowerInvariant().Contains($normalized.ToLowerInvariant())) -or
      ($un -and $un.ToLowerInvariant().Contains($normalized.ToLowerInvariant()))
    if ($hit) { $matches += $row }
  }
  $page++
} while ($page -le [int]$res.totalPages)

if (-not $matches -or $matches.Count -eq 0) {
  Write-Host "NOT_FOUND: no hksp_students row matched $normalized"
  Write-Host "If register still says account exists, check PocketBase Auth uniqueness / other collections manually."
  exit 0
}

Write-Host ("FOUND=" + $matches.Count)
foreach ($row in $matches) {
  $uid = $row.id
  Write-Host ("ROW id=$uid student_id=$($row.student_id) email=$($row.email) username=$($row.username) active=$($row.active)")

  # Delete memberships for this student (best-effort).
  try {
    $filter = [uri]::EscapeDataString('student="' + $uid + '"')
    $mems = Invoke-Pb Get "/api/collections/$memCol/records?filter=$filter&perPage=200" $null $Token
    foreach ($m in $mems.items) {
      Invoke-Pb Delete "/api/collections/$memCol/records/$($m.id)" $null $Token | Out-Null
      Write-Host "DELETED_MEMBERSHIP $($m.id)"
    }
  } catch {
    Write-Host "MEMBERSHIP_CLEAN_WARN: $($_.Exception.Message)"
  }

  Invoke-Pb Delete "/api/collections/$studentsCol/records/$uid" $null $Token | Out-Null
  Write-Host "DELETED_STUDENT $uid"
}

Write-Host "DONE purge complete for $normalized — try register again."
