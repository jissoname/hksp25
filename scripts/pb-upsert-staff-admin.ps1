# Upsert hksp_staff admin for admin.html (not PocketBase _superusers).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Get-Content (Join-Path $root '.env') | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -notmatch '=') { return }
  $k, $v = $_.Split('=', 2)
  Set-Item -Path "Env:$($k.Trim())" -Value $v.Trim()
}

$PB = $env:PB_URL.TrimEnd('/')
$email = if ($args.Count -ge 1) { $args[0] } else { 'hksp_6188@hk.edu.tw' }
$password = if ($args.Count -ge 2) { $args[1] } else { '921020' }

function Invoke-Pb([string]$Method, [string]$Path, $Body = $null, $Token = $null) {
  $headers = @{ 'Content-Type' = 'application/json' }
  if ($Token) { $headers.Authorization = $Token }
  $params = @{ Method = $Method; Uri = "$PB$Path"; Headers = $headers }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Depth 40 -Compress)
  }
  try {
    return Invoke-RestMethod @params
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
      Write-Host ("ERR => " + $reader.ReadToEnd())
    }
    throw
  }
}

$su = Invoke-Pb Post '/api/collections/_superusers/auth-with-password' @{
  identity = $env:PB_ADMIN_EMAIL
  password = $env:PB_ADMIN_PASSWORD
}
$T = $su.token

# Allow short campus passwords on staff auth (admin.html only).
$col = Invoke-Pb Get '/api/collections/hksp_staff' $null $T
foreach ($f in $col.fields) {
  if ($f.name -eq 'password' -and $f.type -eq 'password') {
    if ([int]$f.min -gt $password.Length) { $f.min = $password.Length }
  }
}
$patch = @{
  fields = $col.fields
}
$updated = Invoke-Pb Patch '/api/collections/hksp_staff' $patch $T
$pwdField = $updated.fields | Where-Object { $_.name -eq 'password' } | Select-Object -First 1
Write-Host ("password.min=" + $pwdField.min)

$filter = [uri]::EscapeDataString("email=`"$email`"")
$res = Invoke-Pb Get "/api/collections/hksp_staff/records?filter=$filter&perPage=1" $null $T
if ($res.totalItems -lt 1) {
  Write-Host "CREATE $email"
  Invoke-Pb Post '/api/collections/hksp_staff/records' @{
    email = $email
    emailVisibility = $true
    password = $password
    passwordConfirm = $password
    name = 'HKSP 總管理員'
    role = 'admin'
    active = $true
  } $T | Out-Null
} else {
  Write-Host "UPDATE $($res.items[0].id)"
  Invoke-Pb Patch "/api/collections/hksp_staff/records/$($res.items[0].id)" @{
    password = $password
    passwordConfirm = $password
    name = 'HKSP 總管理員'
    role = 'admin'
    active = $true
  } $T | Out-Null
}

$auth = Invoke-Pb Post '/api/collections/hksp_staff/auth-with-password' @{
  identity = $email
  password = $password
}
Write-Host "OK email=$($auth.record.email) role=$($auth.record.role) active=$($auth.record.active)"
