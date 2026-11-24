param([switch]$Release)

$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }

  & npm.cmd run android:sync
  if ($LASTEXITCODE -ne 0) { throw 'Capacitor sync failed.' }

  $task = if ($Release) { 'assembleRelease' } else { 'assembleDebug' }
  & .\android\gradlew.bat -p android $task
  if ($LASTEXITCODE -ne 0) { throw 'Gradle build failed.' }

  $apk = if ($Release) { 'release/app-release-unsigned.apk' } else { 'debug/app-debug.apk' }
  Write-Host "APK: android/app/build/outputs/apk/$apk"
} finally {
  Pop-Location
}
