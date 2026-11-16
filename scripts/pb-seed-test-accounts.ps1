# Seed HKSP student + judge test accounts on PocketBase.
# Reads admin creds from repo-root .env (not committed).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (-not (Test-Path $envFile)) { throw "Missing .env at $envFile" }

Get-Content $envFile | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_.Split('=', 2)
  Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
}

$PB = $env:PB_URL.TrimEnd('/')
if (-not $PB) { throw 'PB_URL missing' }

function Invoke-Pb([string]$Method, [string]$Path, $Body = $null, $Token = $null) {
  $headers = @{}
  if ($Token) { $headers.Authorization = $Token }
  $params = @{
    Method = $Method
    Uri = "$PB$Path"
    Headers = $headers
  }
  if ($null -ne $Body) {
    $params.ContentType = 'application/json'
    $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
  }
  return Invoke-RestMethod @params
}

$admin = Invoke-Pb Post '/api/collections/_superusers/auth-with-password' @{
  identity = $env:PB_ADMIN_EMAIL
  password = $env:PB_ADMIN_PASSWORD
}
$T = $admin.token

$activityId = if ($env:PB_ACTIVITY_ID) { $env:PB_ACTIVITY_ID } else { '115-1-club-evaluation' }
$actFilter = [uri]::EscapeDataString("activity_id=`"$activityId`"")
$actRes = Invoke-Pb Get "/api/collections/hksp_activities/records?filter=$actFilter&perPage=1" $null $T
if ($actRes.totalItems -lt 1) { throw "Activity $activityId not found" }
$activity = $actRes.items[0]

$clubFilter = [uri]::EscapeDataString("activity=`"$($activity.id)`" && permanent_club_id=`"DEMO-CLUB-001`"")
$clubRes = Invoke-Pb Get "/api/collections/hksp_clubs/records?filter=$clubFilter&perPage=1" $null $T
if ($clubRes.totalItems -lt 1) {
  Write-Host 'SEED club DEMO-CLUB-001'
  $club = Invoke-Pb Post '/api/collections/hksp_clubs/records' @{
    activity = $activity.id
    permanent_club_id = 'DEMO-CLUB-001'
    name = '示範社團'
    category = '學藝性'
    active = $true
  } $T
} else {
  $club = $clubRes.items[0]
  Write-Host "CLUB exists $($club.id)"
}

# --- Judge ---
$judgeEmail = 'judge.demo@hksp.local'
$judgePassword = 'JudgeDemo123!'
$judgeFilter = [uri]::EscapeDataString("email=`"$judgeEmail`"")
$judgeRes = Invoke-Pb Get "/api/collections/hksp_staff/records?filter=$judgeFilter&perPage=1" $null $T
if ($judgeRes.totalItems -lt 1) {
  Write-Host 'CREATE judge'
  Invoke-Pb Post '/api/collections/hksp_staff/records' @{
    email = $judgeEmail
    emailVisibility = $true
    password = $judgePassword
    passwordConfirm = $judgePassword
    name = '示範評審'
    role = 'judge'
    active = $true
  } $T | Out-Null
} else {
  Write-Host 'UPDATE judge password/role'
  $jid = $judgeRes.items[0].id
  Invoke-Pb Patch "/api/collections/hksp_staff/records/$jid" @{
    password = $judgePassword
    passwordConfirm = $judgePassword
    name = '示範評審'
    role = 'judge'
    active = $true
  } $T | Out-Null
}

# --- Student ---
$studentId = 'DEMO001'
$studentEmail = 'demo001@stu.hksp25.invalid'
$studentPassword = 'TestStu123!'
$stuFilter = [uri]::EscapeDataString("student_id=`"$studentId`"")
$stuRes = Invoke-Pb Get "/api/collections/hksp_students/records?filter=$stuFilter&perPage=1" $null $T
if ($stuRes.totalItems -lt 1) {
  Write-Host 'CREATE student DEMO001'
  $student = Invoke-Pb Post '/api/collections/hksp_students/records' @{
    email = $studentEmail
    emailVisibility = $false
    password = $studentPassword
    passwordConfirm = $studentPassword
    student_id = $studentId
    birth_ymd = '20000101'
    name = '示範學生'
    must_change_password = $false
    active = $true
    failed_login_count = 0
    registered_at = (Get-Date).ToUniversalTime().ToString('o')
  } $T
} else {
  Write-Host 'UPDATE student password + flags'
  $student = $stuRes.items[0]
  $student = Invoke-Pb Patch "/api/collections/hksp_students/records/$($student.id)" @{
    password = $studentPassword
    passwordConfirm = $studentPassword
    name = '示範學生'
    must_change_password = $false
    active = $true
    failed_login_count = 0
  } $T
}

$memFilter = [uri]::EscapeDataString("activity=`"$($activity.id)`" && club=`"$($club.id)`" && student=`"$($student.id)`"")
$memRes = Invoke-Pb Get "/api/collections/hksp_memberships/records?filter=$memFilter&perPage=1" $null $T
if ($memRes.totalItems -lt 1) {
  Write-Host 'CREATE membership'
  Invoke-Pb Post '/api/collections/hksp_memberships/records' @{
    activity = $activity.id
    club = $club.id
    student = $student.id
    role = 'member'
    status = 'active'
    can_upload = $true
    bound_at = (Get-Date).ToUniversalTime().ToString('o')
  } $T | Out-Null
} else {
  Write-Host 'UPDATE membership active'
  $mid = $memRes.items[0].id
  Invoke-Pb Patch "/api/collections/hksp_memberships/records/$mid" @{
    status = 'active'
    can_upload = $true
  } $T | Out-Null
}

# Verify logins
$stuAuth = Invoke-Pb Post '/api/collections/hksp_students/auth-with-password' @{
  identity = $studentEmail
  password = $studentPassword
}
$judgeAuth = Invoke-Pb Post '/api/collections/hksp_staff/auth-with-password' @{
  identity = $judgeEmail
  password = $judgePassword
}

Write-Host ''
Write-Host '==== TEST ACCOUNTS READY ===='
Write-Host "Student login ID : $studentId"
Write-Host "Student password : $studentPassword"
Write-Host "Student club     : DEMO-CLUB-001 / $($club.name)"
Write-Host "Judge email      : $judgeEmail"
Write-Host "Judge password   : $judgePassword"
Write-Host "Verified student : $($stuAuth.record.student_id)"
Write-Host "Verified judge   : $($judgeAuth.record.email) ($($judgeAuth.record.role))"
