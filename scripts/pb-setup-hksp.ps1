#Requires -Version 5.1
<#
  Create HKSP (社團評鑑) PocketBase collections.
  Usage: powershell -File scripts/pb-setup-hksp.ps1
  Reads credentials from ../.env
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $Root '.env'

function Read-DotEnv($path) {
  $map = @{}
  Get-Content $path -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $i = $line.IndexOf('=')
    if ($i -gt 0) { $map[$line.Substring(0, $i).Trim()] = $line.Substring($i + 1).Trim() }
  }
  return $map
}

function New-FieldId([string]$prefix) {
  $n = Get-Random -Minimum 100000000 -Maximum 999999999
  return "$prefix$n"
}

function Invoke-Pb {
  param($Method, $Path, $Body, $Headers)
  $uri = "$script:Base$Path"
  $json = if ($null -ne $Body) { $Body | ConvertTo-Json -Depth 30 -Compress } else { $null }
  try {
    if ($null -eq $json) {
      return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers
    }
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $Headers -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) -ContentType 'application/json; charset=utf-8'
  } catch {
    $resp = $_.Exception.Response
    $msg = $_.Exception.Message
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $msg = $reader.ReadToEnd()
    }
    throw "PB $Method $Path failed: $msg"
  }
}

$vars = Read-DotEnv $envPath
$script:Base = $vars['PB_URL'].TrimEnd('/')
$authBody = @{ identity = $vars['PB_ADMIN_EMAIL']; password = $vars['PB_ADMIN_PASSWORD'] }
$auth = Invoke-Pb -Method Post -Path '/api/collections/_superusers/auth-with-password' -Body $authBody -Headers @{}
$H = @{ Authorization = $auth.token }
Write-Host "AUTH_OK $($auth.record.email)"

$existing = Invoke-Pb -Method Get -Path '/api/collections?perPage=200' -Headers $H
$byName = @{}
foreach ($c in $existing.items) { $byName[$c.name] = $c }

function Ensure-Collection($spec) {
  $name = $spec.name
  if ($byName.ContainsKey($name)) {
    Write-Host "EXISTS $name ($($byName[$name].id))"
    return $byName[$name]
  }
  Write-Host "CREATE $name ..."
  $created = Invoke-Pb -Method Post -Path '/api/collections' -Body $spec -Headers $H
  $byName[$name] = $created
  Write-Host "CREATED $name ($($created.id))"
  return $created
}

# --- field helpers ---
function TextField($name, $required = $false, $max = 0, $pattern = '') {
  @{
    id = (New-FieldId 'text')
    name = $name
    type = 'text'
    required = [bool]$required
    system = $false
    hidden = $false
    presentable = $false
    primaryKey = $false
    autogeneratePattern = ''
    min = 0
    max = $max
    pattern = $pattern
  }
}
function BoolField($name, $required = $false) {
  @{ id = (New-FieldId 'bool'); name = $name; type = 'bool'; required = [bool]$required; system = $false; hidden = $false; presentable = $false }
}
function NumberField($name, $required = $false, $onlyInt = $false) {
  @{ id = (New-FieldId 'number'); name = $name; type = 'number'; required = [bool]$required; system = $false; hidden = $false; presentable = $false; onlyInt = [bool]$onlyInt; min = $null; max = $null }
}
function DateField($name, $required = $false) {
  @{ id = (New-FieldId 'date'); name = $name; type = 'date'; required = [bool]$required; system = $false; hidden = $false; presentable = $false; min = ''; max = '' }
}
function JsonField($name, $required = $false) {
  @{ id = (New-FieldId 'json'); name = $name; type = 'json'; required = [bool]$required; system = $false; hidden = $false; presentable = $false; maxSize = 0 }
}
function SelectField($name, $values, $required = $false, $maxSelect = 1) {
  @{ id = (New-FieldId 'select'); name = $name; type = 'select'; required = [bool]$required; system = $false; hidden = $false; presentable = $false; maxSelect = $maxSelect; values = @($values) }
}
function FileField($name, $maxSelect = 1, $maxSize = 52428800) {
  @{
    id = (New-FieldId 'file'); name = $name; type = 'file'; required = $false; system = $false; hidden = $false; presentable = $false
    maxSelect = $maxSelect; maxSize = $maxSize; mimeTypes = @(); thumbs = @(); protected = $false
  }
}
function RelationField($name, $collectionId, $required = $false, $maxSelect = 1, $cascadeDelete = $false) {
  @{
    id = (New-FieldId 'relation'); name = $name; type = 'relation'; required = [bool]$required; system = $false; hidden = $false; presentable = $false
    collectionId = $collectionId; cascadeDelete = [bool]$cascadeDelete; minSelect = 0; maxSelect = $maxSelect
  }
}
function AutoDate($name, $onCreate = $true, $onUpdate = $false) {
  @{ id = (New-FieldId 'autodate'); name = $name; type = 'autodate'; system = $false; hidden = $false; presentable = $false; onCreate = [bool]$onCreate; onUpdate = [bool]$onUpdate }
}

# Auth collections get system email/password fields automatically; we add custom fields only.
$staff = Ensure-Collection @{
  name = 'hksp_staff'
  type = 'auth'
  listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true'
  viewRule = 'id = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "service"))'
  createRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  updateRule = 'id = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true)'
  deleteRule = $null
  fields = @(
    (TextField 'name' $true 80)
    (SelectField 'role' @('admin','judge','service') $true)
    (BoolField 'active')
    (TextField 'phone' $false 40)
    (TextField 'notes' $false 500)
    (DateField 'last_login_at')
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
}

$students = Ensure-Collection @{
  name = 'hksp_students'
  type = 'auth'
  listRule = 'id = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true) || (birth_ymd != "" && @request.query.birth != "" && birth_ymd = @request.query.birth)'
  viewRule = 'id = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true) || (birth_ymd != "" && @request.query.birth != "" && birth_ymd = @request.query.birth)'
  createRule = ''   # public self-registration
  updateRule = 'id = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true) || (birth_ymd != "" && @request.data.birth_ymd != "" && birth_ymd = @request.data.birth_ymd)'
  deleteRule = '(@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true) || id = @request.auth.id'
  fields = @(
    (TextField 'student_id' $true 20)
    (TextField 'name' $false 80)
    (TextField 'birth_ymd' $false 8)
    (BoolField 'must_change_password')
    (BoolField 'active')
    (NumberField 'failed_login_count' $false $true)
    (DateField 'locked_until')
    (DateField 'last_login_at')
    (DateField 'registered_at')
    (JsonField 'profile_json')
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
  indexes = @(
    'CREATE UNIQUE INDEX idx_hksp_students_student_id ON hksp_students (student_id)'
  )
}

$activities = Ensure-Collection @{
  name = 'hksp_activities'
  type = 'base'
  listRule = 'active = true || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true)'
  viewRule = 'active = true || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true)'
  createRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  updateRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  fields = @(
    (TextField 'activity_id' $true 80)
    (TextField 'title' $true 120)
    (TextField 'academic_year' $false 20)
    (SelectField 'status' @('draft','open','closed','archived') $true)
    (BoolField 'active')
    (DateField 'upload_open_at')
    (DateField 'upload_close_at')
    (DateField 'judge_open_at')
    (DateField 'judge_close_at')
    (JsonField 'config_json')
    (TextField 'drive_root_folder_id' $false 128)
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
  indexes = @(
    'CREATE UNIQUE INDEX idx_hksp_activities_activity_id ON hksp_activities (activity_id)'
  )
}

$clubs = Ensure-Collection @{
  name = 'hksp_clubs'
  type = 'base'
  listRule = 'active = true || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true)'
  viewRule = 'active = true || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true)'
  createRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  updateRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  fields = @(
    (RelationField 'activity' $activities.id $true 1 $false)
    (TextField 'permanent_club_id' $true 80)
    (TextField 'name' $true 120)
    (SelectField 'category' @('自治','學藝','體能','服務','康樂','其他') $false)
    (BoolField 'active')
    (TextField 'drive_folder_id' $false 128)
    (JsonField 'meta_json')
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
  indexes = @(
    'CREATE UNIQUE INDEX idx_hksp_clubs_perm ON hksp_clubs (activity, permanent_club_id)'
  )
}

$memberships = Ensure-Collection @{
  name = 'hksp_memberships'
  type = 'base'
  listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && student = @request.auth.id)'
  viewRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && student = @request.auth.id)'
  createRule = '@request.auth.collectionName = "hksp_students" && student = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true)'
  updateRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  fields = @(
    (RelationField 'activity' $activities.id $true 1 $false)
    (RelationField 'club' $clubs.id $true 1 $false)
    (RelationField 'student' $students.id $true 1 $true)
    (SelectField 'role' @('member','officer','president') $true)
    (SelectField 'status' @('active','revoked') $true)
    (BoolField 'can_upload')
    (DateField 'bound_at')
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
  indexes = @(
    'CREATE UNIQUE INDEX idx_hksp_membership_unique ON hksp_memberships (activity, student)'
  )
}

$folders = Ensure-Collection @{
  name = 'hksp_folders'
  type = 'base'
  listRule = '@request.auth.id != ""'
  viewRule = '@request.auth.id != ""'
  createRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || @request.auth.collectionName = "hksp_students"'
  updateRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || @request.auth.collectionName = "hksp_students"'
  deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || @request.auth.collectionName = "hksp_students"'
  fields = @(
    (RelationField 'activity' $activities.id $true 1 $false)
    (RelationField 'club' $clubs.id $true 1 $false)
    (RelationField 'parent' '' $false 1 $false) # patched after create
    (TextField 'name' $true 120)
    (SelectField 'kind' @('evaluation','feature','system') $true)
    (TextField 'drive_folder_id' $false 128)
    (BoolField 'trashed')
    (DateField 'trashed_at')
    (RelationField 'created_by_student' $students.id $false 1 $false)
    (RelationField 'created_by_staff' $staff.id $false 1 $false)
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
}

# patch parent self-relation
if ($folders) {
  $folderFull = Invoke-Pb -Method Get -Path "/api/collections/$($folders.id)" -Headers $H
  $parentField = @($folderFull.fields | Where-Object { $_.name -eq 'parent' })[0]
  if ($parentField -and (-not $parentField.collectionId -or $parentField.collectionId -eq '')) {
    $parentField.collectionId = $folders.id
    $patch = @{
      fields = $folderFull.fields
    }
    # replace whole fields array with parent fixed
    $newFields = @()
    foreach ($f in $folderFull.fields) {
      if ($f.name -eq 'parent') {
        $newFields += (RelationField 'parent' $folders.id $false 1 $false)
      } else {
        $newFields += $f
      }
    }
    Write-Host 'PATCH hksp_folders.parent self-relation'
    $folders = Invoke-Pb -Method Patch -Path "/api/collections/$($folders.id)" -Body @{ fields = $newFields } -Headers $H
    $byName['hksp_folders'] = $folders
  }
}

$uploads = Ensure-Collection @{
  name = 'hksp_uploads'
  type = 'base'
  listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && (student = @request.auth.id || (@collection.hksp_memberships.student ?= @request.auth.id && @collection.hksp_memberships.club ?= club && @collection.hksp_memberships.status = "active")))'
  viewRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && (student = @request.auth.id || (@collection.hksp_memberships.student ?= @request.auth.id && @collection.hksp_memberships.club ?= club && @collection.hksp_memberships.status = "active")))'
  createRule = '@request.auth.collectionName = "hksp_students" && student = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true)'
  updateRule = '@request.auth.collectionName = "hksp_students" && (student = @request.auth.id || (@collection.hksp_memberships.student ?= @request.auth.id && @collection.hksp_memberships.club ?= club && @collection.hksp_memberships.status = "active")) || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true)'
  deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && (student = @request.auth.id || (@collection.hksp_memberships.student ?= @request.auth.id && @collection.hksp_memberships.club ?= club && @collection.hksp_memberships.status = "active")))'
  fields = @(
    (RelationField 'activity' $activities.id $true 1 $false)
    (RelationField 'club' $clubs.id $true 1 $false)
    (RelationField 'folder' $folders.id $false 1 $false)
    (RelationField 'student' $students.id $true 1 $false)
    (TextField 'client_attempt_id' $true 80)
    (SelectField 'upload_kind' @('evaluation','feature') $true)
    (TextField 'original_name' $true 255)
    (TextField 'mime_type' $false 120)
    (NumberField 'size_bytes' $false $true)
    (SelectField 'status' @('prepared','uploaded','completed','failed','trashed','replaced') $true)
    (FileField 'file' 1 10737418240)
    (TextField 'drive_file_id' $false 128)
    (TextField 'drive_web_view_link' $false 500)
    (JsonField 'meta_json')
    (DateField 'completed_at')
    (DateField 'trashed_at')
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
  indexes = @(
    'CREATE UNIQUE INDEX idx_hksp_uploads_attempt ON hksp_uploads (client_attempt_id)'
  )
}

$scores = Ensure-Collection @{
  name = 'hksp_scores'
  type = 'base'
  listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "judge" || @request.auth.role = "service")'
  viewRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true'
  createRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "judge")'
  updateRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "judge")'
  deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
  fields = @(
    (RelationField 'activity' $activities.id $true 1 $false)
    (RelationField 'club' $clubs.id $true 1 $false)
    (RelationField 'judge' $staff.id $true 1 $false)
    (TextField 'section_id' $true 80)
    (NumberField 'score' $false $false)
    (JsonField 'answers_json')
    (TextField 'comment' $false 2000)
    (NumberField 'revision' $false $true)
    (SelectField 'status' @('draft','submitted') $true)
    (DateField 'submitted_at')
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
  indexes = @(
    'CREATE UNIQUE INDEX idx_hksp_scores_unique ON hksp_scores (activity, club, judge, section_id)'
  )
}

$audit = Ensure-Collection @{
  name = 'hksp_audit_events'
  type = 'base'
  listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "service")'
  viewRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "service")'
  createRule = '@request.auth.id != ""'
  updateRule = $null
  deleteRule = $null
  fields = @(
    (TextField 'event_key' $true 80)
    (SelectField 'event_type' @('audit','security','upload','auth') $true)
    (RelationField 'actor_student' $students.id $false 1 $false)
    (RelationField 'actor_staff' $staff.id $false 1 $false)
    (TextField 'target_type' $false 40)
    (TextField 'target_id' $false 80)
    (JsonField 'payload_json')
    (TextField 'ip' $false 64)
    (TextField 'user_agent' $false 300)
    (DateField 'occurred_at')
    (AutoDate 'created' $true $false)
    (AutoDate 'updated' $true $true)
  )
}

# --- seed default activity ---
$actList = Invoke-Pb -Method Get -Path '/api/collections/hksp_activities/records?filter=(activity_id=%22115-1-club-evaluation%22)&perPage=1' -Headers $H
if ($actList.totalItems -eq 0) {
  Write-Host 'SEED activity 115-1-club-evaluation'
  Invoke-Pb -Method Post -Path '/api/collections/hksp_activities/records' -Headers $H -Body @{
    activity_id = '115-1-club-evaluation'
    title = '115-1 社團評鑑繳交'
    academic_year = '115-1'
    status = 'open'
    active = $true
    config_json = @{
      source = 'hksp-prototype-salvage'
      club_categories = @('自治','學藝','體能','服務','康樂','其他')
    }
  } | Out-Null
} else {
  Write-Host 'SEED activity already present'
}

Write-Host ''
Write-Host 'DONE. Collections:'
@('hksp_staff','hksp_students','hksp_activities','hksp_clubs','hksp_memberships','hksp_folders','hksp_uploads','hksp_scores','hksp_audit_events') | ForEach-Object {
  $c = $byName[$_]
  if ($c) { Write-Host ("- {0}  {1}" -f $_.PadRight(22), $c.id) }
}
