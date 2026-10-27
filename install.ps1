<#
.SYNOPSIS
  Install Voice Audio Rus into a DeepSeek Harness profile with one command.

.DESCRIPTION
  Wires this checkout into the chosen profile as a DSH bundle:
  adds the package dependency (link: by default, file: with -Copy) and
  makes sure the bundle is selected in dsh.profile.bundles.

.EXAMPLE
  pwsh -File .\install.ps1

.EXAMPLE
  pwsh -File .\install.ps1 -Profile web

.EXAMPLE
  pwsh -File .\install.ps1 -Copy        # copy files into the profile instead of linking

.EXAMPLE
  pwsh -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile,
  [switch]$Copy,
  [switch]$Uninstall,
  [string]$Dsh,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Fail([string]$Message) {
  Write-Host "x $Message" -ForegroundColor Red
  exit 1
}

function Step([string]$Message) {
  Write-Host "> $Message" -ForegroundColor Cyan
}

function Ok([string]$Message) {
  Write-Host "[ok] $Message" -ForegroundColor Green
}

# ---------------------------------------------------------------- plugin

$root = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$pluginDir = Join-Path $root 'plugin'
$manifestPath = Join-Path $pluginDir 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath)) {
  Fail "не найден $manifestPath — запустите скрипт из каталога репозитория Voice Audio Rus"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$name = $manifest.name
if (-not $name) { Fail "в $manifestPath нет поля name" }
$patch = $manifest.dsh.bundle.patch
if (-not $patch) {
  Fail "$name не является DSH-бандлом: нет dsh.bundle.patch в package.json"
}
if (-not (Test-Path -LiteralPath (Join-Path $pluginDir $patch))) {
  Fail "не найден файл патча $patch внутри $pluginDir"
}

# ---------------------------------------------------------------- dsh

function Resolve-Dsh([string]$Explicit) {
  if ($Explicit) {
    if (-not (Test-Path -LiteralPath $Explicit)) { Fail "указанный dsh не найден: $Explicit" }
    return $Explicit
  }
  if ($env:DSH_BIN) {
    if (-not (Test-Path -LiteralPath $env:DSH_BIN)) { Fail "DSH_BIN указывает на несуществующий файл: $env:DSH_BIN" }
    return $env:DSH_BIN
  }
  $onPath = Get-Command dsh -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $candidates = @()
  if ($IsWindows -or $env:OS -eq 'Windows_NT') {
    $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    $candidates += Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  }
  if ($IsMacOS) {
    $candidates += '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  }
  $candidates += Join-Path $HOME '.local/bin/dsh'
  $candidates += '/usr/local/bin/dsh'
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }
  Fail 'не найден dsh. Установите DSH, добавьте dsh в PATH или укажите -Dsh <path>'
}

$dshBin = Resolve-Dsh $Dsh

# ---------------------------------------------------------------- profile

$homeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
$profilesDir = Join-Path $homeDir 'profiles'

function Resolve-Profile([string]$Explicit) {
  if ($Explicit) { return $Explicit }
  if (Test-Path -LiteralPath (Join-Path $profilesDir 'desktop')) { return 'desktop' }
  if (Test-Path -LiteralPath (Join-Path $profilesDir 'web')) { return 'web' }
  return 'web'
}

$profileName = Resolve-Profile $Profile
$profileDir = Join-Path $profilesDir $profileName
if (-not (Test-Path -LiteralPath $profileDir)) {
  if ($profileName -eq 'desktop') {
    Fail "профиль desktop не инициализирован ($profileDir). Запустите настольное приложение DSH один раз."
  }
  Step "профиль $profileName будет создан при первом запуске DSH"
}

# ---------------------------------------------------------------- spec

$spec = '{0}:{1}' -f ($(if ($Copy) { 'file' } else { 'link' })), $pluginDir

Write-Host ''
Write-Host 'Voice Audio Rus' -ForegroundColor White
Write-Host "  плагин : $name"
Write-Host "  каталог: $pluginDir"
Write-Host "  dsh    : $dshBin"
Write-Host "  профиль: $profileName ($profileDir)"
Write-Host "  режим  : $(if ($Uninstall) { 'удаление' } else { $spec })"
Write-Host ''

if ($DryRun) {
  Ok 'DryRun: команды не выполнялись'
  exit 0
}

# ---------------------------------------------------------------- run

if ($Uninstall) {
  Step "удаляю $name из профиля $profileName"
  & $dshBin plugin --profile $profileName remove $name
  if ($LASTEXITCODE -ne 0) { Fail "dsh plugin remove завершился с кодом $LASTEXITCODE" }
} else {
  Step "ставлю $name в профиль $profileName"
  & $dshBin plugin --profile $profileName add $spec
  if ($LASTEXITCODE -ne 0) { Fail "dsh plugin add завершился с кодом $LASTEXITCODE" }
}

# ---------------------------------------------------------------- bundle selection

$profileManifest = Join-Path $profileDir 'package.json'
if (Test-Path -LiteralPath $profileManifest) {
  $profileJson = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
  $bundles = @()
  if ($profileJson.dsh -and $profileJson.dsh.profile -and $profileJson.dsh.profile.bundles) {
    $bundles = @($profileJson.dsh.profile.bundles)
  }
  $selected = $bundles -contains $name
  if ($Uninstall) {
    if ($selected) {
      $bundles = @($bundles | Where-Object { $_ -ne $name })
      if (-not $profileJson.dsh) { $profileJson | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
      if (-not $profileJson.dsh.profile) { $profileJson.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
      $profileJson.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
      $profileJson | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $profileManifest -Encoding utf8
      Ok "бандл убран из dsh.profile.bundles"
    }
  } elseif (-not $selected) {
    $bundles += $name
    if (-not $profileJson.dsh) { $profileJson | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
    if (-not $profileJson.dsh.profile) { $profileJson.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
    $profileJson.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    $profileJson | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $profileManifest -Encoding utf8
    Ok "бандл добавлен в dsh.profile.bundles"
  } else {
    Ok 'бандл уже выбран в профиле'
  }
}

Write-Host ''
if ($Uninstall) {
  Ok "Готово. Перезапустите DSH, чтобы плагин исчез из интерфейса."
} else {
  Ok 'Готово.'
  Write-Host '  1. Перезапустите DSH (настольное приложение) или `dsh web`.'
  Write-Host '  2. Плагины → Voice Audio Rus → «Скачать все модели».'
  Write-Host '  3. Правки клиента подхватываются по Ctrl+R после `node tools/build.mjs`.'
}
