#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $Root '.env'
$vars = @{}
Get-Content $envPath -Encoding UTF8 | ForEach-Object {
  $l = $_.Trim(); if (-not $l -or $l.StartsWith('#')) { return }
  $i = $l.IndexOf('='); if ($i -gt 0) { $vars[$l.Substring(0, $i).Trim()] = $l.Substring($i + 1).Trim() }
}
$Base = $vars['PB_URL'].TrimEnd('/')
$auth = Invoke-RestMethod -Method Post -Uri "$Base/api/collections/_superusers/auth-with-password" `
  -ContentType 'application/json; charset=utf-8' `
  -Body ((@{ identity = $vars.PB_ADMIN_EMAIL; password = $vars.PB_ADMIN_PASSWORD } | ConvertTo-Json -Compress))
$H = @{ Authorization = $auth.token }
Write-Host "AUTH_OK $($auth.record.email)"

function New-Fid([string]$p) { return "$p$(Get-Random -Minimum 100000000 -Maximum 999999999)" }
function F-Text($n, $req = $false, $max = 0) {
  @{ id = (New-Fid 'text'); name = $n; type = 'text'; required = [bool]$req; system = $false; hidden = $false; presentable = $false; primaryKey = $false; autogeneratePattern = ''; min = 0; max = $max; pattern = '' }
}
function F-Bool($n) { @{ id = (New-Fid 'bool'); name = $n; type = 'bool'; required = $false; system = $false; hidden = $false; presentable = $false } }
function F-Select($n, $vals, $req = $false) {
  @{ id = (New-Fid 'select'); name = $n; type = 'select'; required = [bool]$req; system = $false; hidden = $false; presentable = $false; maxSelect = 1; values = @($vals) }
}
function F-Date($n) { @{ id = (New-Fid 'date'); name = $n; type = 'date'; required = $false; system = $false; hidden = $false; presentable = $false; min = ''; max = '' } }
function F-Json($n) { @{ id = (New-Fid 'json'); name = $n; type = 'json'; required = $false; system = $false; hidden = $false; presentable = $false; maxSize = 0 } }
function F-Number($n, $onlyInt = $false) {
  @{ id = (New-Fid 'number'); name = $n; type = 'number'; required = $false; system = $false; hidden = $false; presentable = $false; onlyInt = [bool]$onlyInt; min = $null; max = $null }
}
function F-File($n, $maxSelect = 1, $maxSize = 104857600) {
  @{ id = (New-Fid 'file'); name = $n; type = 'file'; required = $false; system = $false; hidden = $false; presentable = $false; maxSelect = $maxSelect; maxSize = $maxSize; mimeTypes = @(); thumbs = @(); protected = $false }
}
function F-Rel($n, $cid, $req = $false, $max = 1, $cascade = $false) {
  @{ id = (New-Fid 'relation'); name = $n; type = 'relation'; required = [bool]$req; system = $false; hidden = $false; presentable = $false; collectionId = $cid; cascadeDelete = [bool]$cascade; minSelect = 0; maxSelect = $max }
}
function F-Auto($n, $c = $true, $u = $false) {
  @{ id = (New-Fid 'autodate'); name = $n; type = 'autodate'; system = $false; hidden = $false; presentable = $false; onCreate = [bool]$c; onUpdate = [bool]$u }
}

function Invoke-Pb($Method, $Path, $Body = $null) {
  $uri = "$Base$Path"
  try {
    if ($null -eq $Body) { return Invoke-RestMethod -Method $Method -Uri $uri -Headers $H }
    $bytes = [System.Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 40 -Compress))
    return Invoke-RestMethod -Method $Method -Uri $uri -Headers $H -Body $bytes -ContentType 'application/json; charset=utf-8'
  } catch {
    $resp = $_.Exception.Response
    $msg = $_.Exception.Message
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      $msg = $reader.ReadToEnd()
    }
    throw "$Method $Path => $msg"
  }
}

$cols = Invoke-Pb Get '/api/collections?perPage=200'
$by = @{}
foreach ($c in $cols.items) { $by[$c.name] = $c }
$act = $by['hksp_activities']; $club = $by['hksp_clubs']; $stu = $by['hksp_students']; $staff = $by['hksp_staff']
if (-not $act -or -not $club -or -not $stu -or -not $staff) { throw 'Missing base hksp collections' }

if (-not $by.ContainsKey('hksp_folders')) {
  Write-Host 'CREATE hksp_folders'
  $folders = Invoke-Pb Post '/api/collections' @{
    name = 'hksp_folders'; type = 'base'
    listRule = '@request.auth.id != ""'
    viewRule = '@request.auth.id != ""'
    createRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || @request.auth.collectionName = "hksp_students"'
    updateRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || @request.auth.collectionName = "hksp_students"'
    deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || @request.auth.collectionName = "hksp_students"'
    fields = @(
      (F-Rel 'activity' $act.id $true)
      (F-Rel 'club' $club.id $true)
      (F-Text 'name' $true 120)
      (F-Select 'kind' @('evaluation', 'feature', 'system') $true)
      (F-Text 'drive_folder_id' $false 128)
      (F-Bool 'trashed')
      (F-Date 'trashed_at')
      (F-Rel 'created_by_student' $stu.id)
      (F-Rel 'created_by_staff' $staff.id)
      (F-Auto 'created' $true $false)
      (F-Auto 'updated' $true $true)
    )
  }
  $by['hksp_folders'] = $folders
  Write-Host "CREATED $($folders.id)"
  $full = Invoke-Pb Get "/api/collections/$($folders.id)"
  $fields = @($full.fields) + @((F-Rel 'parent' $folders.id))
  $folders = Invoke-Pb Patch "/api/collections/$($folders.id)" @{ fields = $fields }
  $by['hksp_folders'] = $folders
  Write-Host 'PATCHED parent'
} else {
  Write-Host "EXISTS hksp_folders $($by.hksp_folders.id)"
}
$folders = $by['hksp_folders']

if (-not $by.ContainsKey('hksp_uploads')) {
  Write-Host 'CREATE hksp_uploads'
  $uploads = Invoke-Pb Post '/api/collections' @{
    name = 'hksp_uploads'; type = 'base'
    listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && student = @request.auth.id)'
    viewRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && student = @request.auth.id)'
    createRule = '@request.auth.collectionName = "hksp_students" && student = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true)'
    updateRule = '@request.auth.collectionName = "hksp_students" && student = @request.auth.id || (@request.auth.collectionName = "hksp_staff" && @request.auth.active = true)'
    deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true || (@request.auth.collectionName = "hksp_students" && student = @request.auth.id)'
    fields = @(
      (F-Rel 'activity' $act.id $true)
      (F-Rel 'club' $club.id $true)
      (F-Rel 'folder' $folders.id)
      (F-Rel 'student' $stu.id $true)
      (F-Text 'client_attempt_id' $true 80)
      (F-Select 'upload_kind' @('evaluation', 'feature') $true)
      (F-Text 'original_name' $true 255)
      (F-Text 'mime_type' $false 120)
      (F-Number 'size_bytes' $true)
      (F-Select 'status' @('prepared', 'uploaded', 'completed', 'failed', 'trashed', 'replaced') $true)
      (F-File 'file' 1 104857600)
      (F-Text 'drive_file_id' $false 128)
      (F-Text 'drive_web_view_link' $false 500)
      (F-Json 'meta_json')
      (F-Date 'completed_at')
      (F-Date 'trashed_at')
      (F-Auto 'created' $true $false)
      (F-Auto 'updated' $true $true)
    )
    indexes = @('CREATE UNIQUE INDEX idx_hksp_uploads_attempt ON hksp_uploads (client_attempt_id)')
  }
  $by['hksp_uploads'] = $uploads
  Write-Host "CREATED $($uploads.id)"
} else { Write-Host "EXISTS hksp_uploads" }

if (-not $by.ContainsKey('hksp_scores')) {
  Write-Host 'CREATE hksp_scores'
  $scores = Invoke-Pb Post '/api/collections' @{
    name = 'hksp_scores'; type = 'base'
    listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true'
    viewRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true'
    createRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "judge")'
    updateRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "judge")'
    deleteRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.role = "admin" && @request.auth.active = true'
    fields = @(
      (F-Rel 'activity' $act.id $true)
      (F-Rel 'club' $club.id $true)
      (F-Rel 'judge' $staff.id $true)
      (F-Text 'section_id' $true 80)
      (F-Number 'score')
      (F-Json 'answers_json')
      (F-Text 'comment' $false 2000)
      (F-Number 'revision' $true)
      (F-Select 'status' @('draft', 'submitted') $true)
      (F-Date 'submitted_at')
      (F-Auto 'created' $true $false)
      (F-Auto 'updated' $true $true)
    )
    indexes = @('CREATE UNIQUE INDEX idx_hksp_scores_unique ON hksp_scores (activity, club, judge, section_id)')
  }
  $by['hksp_scores'] = $scores
  Write-Host "CREATED $($scores.id)"
} else { Write-Host "EXISTS hksp_scores" }

if (-not $by.ContainsKey('hksp_audit_events')) {
  Write-Host 'CREATE hksp_audit_events'
  $audit = Invoke-Pb Post '/api/collections' @{
    name = 'hksp_audit_events'; type = 'base'
    listRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "service")'
    viewRule = '@request.auth.collectionName = "hksp_staff" && @request.auth.active = true && (@request.auth.role = "admin" || @request.auth.role = "service")'
    createRule = '@request.auth.id != ""'
    updateRule = $null
    deleteRule = $null
    fields = @(
      (F-Text 'event_key' $true 80)
      (F-Select 'event_type' @('audit', 'security', 'upload', 'auth') $true)
      (F-Rel 'actor_student' $stu.id)
      (F-Rel 'actor_staff' $staff.id)
      (F-Text 'target_type' $false 40)
      (F-Text 'target_id' $false 80)
      (F-Json 'payload_json')
      (F-Text 'ip' $false 64)
      (F-Text 'user_agent' $false 300)
      (F-Date 'occurred_at')
      (F-Auto 'created' $true $false)
      (F-Auto 'updated' $true $true)
    )
  }
  $by['hksp_audit_events'] = $audit
  Write-Host "CREATED $($audit.id)"
} else { Write-Host "EXISTS hksp_audit_events" }

$filter = [uri]::EscapeDataString('activity_id="115-1-club-evaluation"')
$actList = Invoke-Pb Get "/api/collections/hksp_activities/records?filter=$filter&perPage=1"
if ($actList.totalItems -eq 0) {
  Write-Host 'SEED activity'
  Invoke-Pb Post '/api/collections/hksp_activities/records' @{
    activity_id = '115-1-club-evaluation'
    title = '115-1 社團評鑑繳交'
    academic_year = '115-1'
    status = 'open'
    active = $true
    config_json = @{
      source = 'hksp-prototype-salvage'
      club_categories = @('自治', '學藝', '體能', '服務', '康樂', '其他')
    }
  } | Out-Null
} else { Write-Host 'SEED activity exists' }

Write-Host '---- SUMMARY ----'
@('hksp_staff', 'hksp_students', 'hksp_activities', 'hksp_clubs', 'hksp_memberships', 'hksp_folders', 'hksp_uploads', 'hksp_scores', 'hksp_audit_events') | ForEach-Object {
  if ($by.ContainsKey($_)) { Write-Host ("OK {0} {1}" -f $_, $by[$_].id) } else { Write-Host "MISSING $_" }
}
