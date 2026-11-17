# Create or update HKSP business super-admin (hksp_staff role=admin).
# Requires:
#   PB_ADMIN_*            → PocketBase _superusers (to create the staff record)
#   HKSP_STAFF_ADMIN_*    → the business admin credentials to create
# Does not print passwords.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw "Missing .env at $envFile" }

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_.Split('=', 2)
  Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
}

$PB = ($env:PB_URL).TrimEnd('/')
if (-not $PB) { throw 'PB_URL missing' }

$email = $env:HKSP_STAFF_ADMIN_EMAIL
$password = $env:HKSP_STAFF_ADMIN_PASSWORD
$name = if ($env:HKSP_STAFF_ADMIN_NAME) { $env:HKSP_STAFF_ADMIN_NAME } else { 'HKSP Admin' }

if (-not $email -or -not $password) {
  throw 'Fill HKSP_STAFF_ADMIN_EMAIL and HKSP_STAFF_ADMIN_PASSWORD in .env first'
}
if ($password.Length -lt 8) { throw 'HKSP_STAFF_ADMIN_PASSWORD must be at least 8 characters' }

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

$filter = [uri]::EscapeDataString("email=`"$email`"")
$existing = Invoke-Pb Get "/api/collections/hksp_staff/records?filter=$filter&perPage=1" $null $Token

if ($existing.totalItems -lt 1) {
  $rec = Invoke-Pb Post '/api/collections/hksp_staff/records' @{
    email           = $email
    emailVisibility = $true
    password        = $password
    passwordConfirm = $password
    name            = $name
    role            = 'admin'
    active          = $true
  } $Token
  Write-Host "CREATED staff admin id=$($rec.id)"
} else {
  $id = $existing.items[0].id
  $rec = Invoke-Pb Patch "/api/collections/hksp_staff/records/$id" @{
    password        = $password
    passwordConfirm = $password
    name            = $name
    role            = 'admin'
    active          = $true
  } $Token
  Write-Host "UPDATED staff admin id=$($rec.id)"
}

# Verify login as business admin (not _superusers)
$login = Invoke-Pb Post '/api/collections/hksp_staff/auth-with-password' @{
  identity = $email
  password = $password
}
Write-Host "VERIFIED email=$($login.record.email) role=$($login.record.role) active=$($login.record.active)"
Write-Host 'DONE'
