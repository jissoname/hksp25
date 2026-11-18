# Apply / refresh HKSP collection API rules for staff admin ACL.
# Requires PocketBase _superusers creds in repo-root .env (PB_ADMIN_*).
# Idempotent: only patches list/view/create/update/delete rules.
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

function Invoke-Pb([string]$Method, [string]$Path, $Body = $null, $Token = $null) {
  $headers = @{}
  if ($Token) { $headers.Authorization = $Token }
  $params = @{
    Method      = $Method
    Uri         = "$PB$Path"
    Headers     = $headers
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

$Staff = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true'
$Admin = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
$JudgeOrAdmin = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "judge")'
$AdminJudgeService = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "judge" || @request.auth.role = "service")'
$AdminOrService = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "service")'
# Club workspace: any active member of the upload's club may list/view/update/delete
# (not only the original uploader). Owner alone is too strict for shared 評選 folders.
$ClubMateUpload = '@request.auth.collectionName = "hksp_students" && (student = @request.auth.id || (@collection.hksp_memberships.student ?= @request.auth.id && @collection.hksp_memberships.club ?= club && @collection.hksp_memberships.status = "active"))'
# Keep in sync with scripts/pb-setup-hksp.ps1 and docs/hksp-admin-acl.md
# Note: do not use @request.data.birth_ymd / @request.query.birth here — this PB
# build rejects those operands on hksp_students auth rules.
$Acl = @{
  hksp_staff = @{
    listRule   = $Staff
    viewRule   = "id = @request.auth.id || ($Staff && (@request.auth.role = `"admin`" || @request.auth.role = `"service`"))"
    # 業務超管可新增評審／服務帳；首筆 admin 仍須由 A 層 seed。
    # 限制 body.role，避免前台 admin 自我複製更高權限帳。
    createRule = "$Admin && (@request.body.role = `"judge`" || @request.body.role = `"service`")"
    updateRule = "id = @request.auth.id || ($Admin)"
    deleteRule = $null
  }
  hksp_students = @{
    listRule   = "id = @request.auth.id || ($Staff)"
    viewRule   = "id = @request.auth.id || ($Staff)"
    createRule = ''
    updateRule = "id = @request.auth.id || ($Admin)"
    # Admin hard-delete frees student_id for re-register; self-delete after login.
    deleteRule = "$Admin || id = @request.auth.id"
  }
  hksp_activities = @{
    listRule   = "active = true || ($Staff)"
    viewRule   = "active = true || ($Staff)"
    createRule = $Admin
    updateRule = $Admin
    deleteRule = $Admin
  }
  hksp_clubs = @{
    listRule   = "active = true || ($Staff)"
    viewRule   = "active = true || ($Staff)"
    createRule = $Admin
    updateRule = $Admin
    deleteRule = $Admin
  }
  hksp_memberships = @{
    listRule   = "$Staff || (@request.auth.collectionName = `"hksp_students`" && student = @request.auth.id)"
    viewRule   = "$Staff || (@request.auth.collectionName = `"hksp_students`" && student = @request.auth.id)"
    createRule = "@request.auth.collectionName = `"hksp_students`" && student = @request.auth.id || ($Admin)"
    updateRule = $Admin
    deleteRule = $Admin
  }
  hksp_folders = @{
    listRule   = '@request.auth.id != ""'
    viewRule   = '@request.auth.id != ""'
    createRule = "$Admin || @request.auth.collectionName = `"hksp_students`""
    updateRule = "$Admin || @request.auth.collectionName = `"hksp_students`""
    deleteRule = "$Admin || @request.auth.collectionName = `"hksp_students`""
  }
  hksp_uploads = @{
    listRule   = "$Staff || ($ClubMateUpload)"
    viewRule   = "$Staff || ($ClubMateUpload)"
    createRule = "@request.auth.collectionName = `"hksp_students`" && student = @request.auth.id || ($Admin)"
    updateRule = "($ClubMateUpload) || ($Staff)"
    deleteRule = "$Admin || ($ClubMateUpload)"
  }
  hksp_scores = @{
    listRule   = $AdminJudgeService
    viewRule   = $Staff
    createRule = $JudgeOrAdmin
    updateRule = $JudgeOrAdmin
    deleteRule = $Admin
  }
  hksp_audit_events = @{
    listRule   = $AdminOrService
    viewRule   = $AdminOrService
    createRule = '@request.auth.id != ""'
    updateRule = $null
    deleteRule = $null
  }
}

$cols = Invoke-Pb Get '/api/collections?perPage=200' $null $Token
$byName = @{}
foreach ($c in $cols.items) { $byName[$c.name] = $c }

$updated = 0
$failed = @()
$missing = @()
foreach ($name in ($Acl.Keys | Sort-Object)) {
  if (-not $byName.ContainsKey($name)) {
    $missing += $name
    Write-Host "MISSING $name"
    continue
  }
  $id = $byName[$name].id
  $body = $Acl[$name]
  try {
    Invoke-Pb Patch "/api/collections/$id" $body $Token | Out-Null
    Write-Host "ACL_OK $name"
    $updated++
  } catch {
    $failed += $name
    $errText = $_.Exception.Message
    try {
      $resp = $_.ErrorDetails.Message
      if ($resp) { $errText = $resp }
    } catch { }
    Write-Host "ACL_FAIL $name : $errText"
  }
}

Write-Host ''
Write-Host "UPDATED=$updated"
if ($missing.Count -gt 0) {
  Write-Host ("MISSING=" + ($missing -join ','))
}
if ($failed.Count -gt 0) {
  Write-Host ("FAILED=" + ($failed -join ','))
  throw 'Some ACL patches failed; see ACL_FAIL lines above'
}
if ($missing.Count -gt 0) {
  throw 'Some collections missing; run pb-setup-hksp-rest.ps1 first'
}
Write-Host 'DONE admin ACL applied'
