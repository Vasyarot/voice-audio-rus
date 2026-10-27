<#
.SYNOPSIS
  Download Voice Audio Rus from GitHub and install it into a DeepSeek Harness profile.

.DESCRIPTION
  Works from a cloned repository (uses the local ./plugin) or standalone: when no
  repository sits next to this script, it downloads the sources from GitHub into a
  cache directory and installs the plugin from there.

  Installation adds the package dependency (link: by default, file: with -Copy) to
  the chosen profile and makes sure the bundle is selected in dsh.profile.bundles.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1

.EXAMPLE
  # completely standalone, no clone needed
  irm https://raw.githubusercontent.com/Vasyarot/voice-audio-rus/main/install.ps1 -OutFile "$env:TEMP\voice-install.ps1"
  powershell -ExecutionPolicy Bypass -File "$env:TEMP\voice-install.ps1"

.EXAMPLE
  .\install.ps1 -Profile web

.EXAMPLE
  .\install.ps1 -Copy -Version v0.2.2

.EXAMPLE
  .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$Profile,
  [switch]$Copy,
  [switch]$Uninstall,
  [string]$Dsh,
  [switch]$DryRun,
  [string]$Source,
  [string]$Version = 'main',
  [string]$Repo = 'Vasyarot/voice-audio-rus',
  [switch]$FromGitHub,
  [string]$Dest
)

$ErrorActionPreference = 'Stop'
$defaultPackage = 'dsh-plugin-voice-studio'

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

function Test-PluginDir([string]$Path) {
  if (-not $Path) { return $false }
  return (Test-Path -LiteralPath (Join-Path $Path 'plugin\package.json')) -or
         (Test-Path -LiteralPath (Join-Path $Path 'plugin/package.json'))
}

function Get-CacheRoot {
  if ($Dest) { return $Dest }
  if ($env:OS -eq 'Windows_NT') {
    $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }
    return (Join-Path $base 'VoiceAudioRus')
  }
  if ($env:XDG_DATA_HOME) { return (Join-Path $env:XDG_DATA_HOME 'voice-audio-rus') }
  return (Join-Path $HOME '.local/share/voice-audio-rus')
}

function Invoke-Download([string]$Target) {
  $zipUrl = "https://codeload.github.com/$Repo/zip/refs/heads/$Version"
  $tagUrl = "https://codeload.github.com/$Repo/zip/refs/tags/$Version"
  $work = Join-Path ([IO.Path]::GetTempPath()) ('voice-audio-rus-' + [guid]::NewGuid().ToString('N'))
  $zip = "$work.zip"
  New-Item -ItemType Directory -Path $work -Force | Out-Null

  Step "скачиваю $Repo@$Version с GitHub"
  $downloaded = $false
  foreach ($url in @($zipUrl, $tagUrl)) {
    try {
      Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -ErrorAction Stop
      $downloaded = $true
      break
    } catch {
      if ($url -eq $tagUrl) {
        Remove-Item $work, $zip -Recurse -Force -ErrorAction SilentlyContinue
        Fail "не удалось скачать $Repo@${Version}: $($_.Exception.Message)"
      }
    }
  }
  if (-not $downloaded) { Fail "не удалось скачать $Repo@$Version" }

  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $work -Force -ErrorAction Stop
  } catch {
    Remove-Item $work, $zip -Recurse -Force -ErrorAction SilentlyContinue
    Fail "не удалось распаковать архив: $($_.Exception.Message)"
  }

  $inner = Get-ChildItem -Path $work -Directory | Select-Object -First 1
  if (-not $inner) {
    Remove-Item $work, $zip -Recurse -Force -ErrorAction SilentlyContinue
    Fail 'архив пустой'
  }
  if (-not (Test-PluginDir $inner.FullName)) {
    Remove-Item $work, $zip -Recurse -Force -ErrorAction SilentlyContinue
    Fail "в архиве нет plugin/package.json — $Repo@$Version не похож на Voice Audio Rus"
  }

  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force }
  New-Item -ItemType Directory -Path $Target -Force | Out-Null
  Copy-Item -Path (Join-Path $inner.FullName '*') -Destination $Target -Recurse -Force
  Remove-Item $work, $zip -Recurse -Force -ErrorAction SilentlyContinue
  Ok "исходники обновлены: $Target"
  return $Target
}

# ---------------------------------------------------------------- source

$root = $null
if ($Source) {
  if (-not (Test-PluginDir $Source)) { Fail "в $Source нет plugin\package.json" }
  $root = (Resolve-Path -LiteralPath $Source).Path
} elseif (-not $FromGitHub -and $PSScriptRoot -and (Test-PluginDir $PSScriptRoot)) {
  $root = $PSScriptRoot
} elseif ($Uninstall) {
  # Removing the dependency does not need the sources.
  $root = $null
} else {
  $cache = Join-Path (Get-CacheRoot) 'src'
  $root = Invoke-Download $cache
}

$pluginDir = if ($root) { Join-Path $root 'plugin' } else { $null }
$name = $defaultPackage
$manifestPath = if ($pluginDir) { Join-Path $pluginDir 'package.json' } else { $null }
if ($manifestPath -and (Test-Path -LiteralPath $manifestPath)) {
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name) { $name = $manifest.name }
  if (-not $Uninstall) {
    $patch = $manifest.dsh.bundle.patch
    if (-not $patch) { Fail "$name не является DSH-бандлом: нет dsh.bundle.patch в package.json" }
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir $patch))) {
      Fail "не найден файл патча $patch внутри $pluginDir"
    }
    $client = Join-Path $pluginDir 'client.js'
    if (-not (Test-Path -LiteralPath $client)) {
      Fail "в $pluginDir нет собранного client.js — это не готовый релиз"
    }
  }
} elseif (-not $Uninstall) {
  Fail "не удалось получить исходники плагина"
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
  if ($env:OS -eq 'Windows_NT') {
    $candidates += Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
    $candidates += Join-Path $env:ProgramFiles 'DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  }
  $candidates += '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  $candidates += (Join-Path $HOME '.local/bin/dsh')
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

$spec = if ($pluginDir) {
  '{0}:{1}' -f ($(if ($Copy) { 'file' } else { 'link' })), $pluginDir
} else { '' }

Write-Host ''
Write-Host 'Voice Audio Rus' -ForegroundColor White
if ($pluginDir) { Write-Host "  плагин : $name" }
else { Write-Host "  плагин : $name (только удаление)" }
if ($pluginDir) { Write-Host "  откуда : $pluginDir" }
Write-Host "  dsh    : $dshBin"
Write-Host "  профиль: $profileName ($profileDir)"
if ($Uninstall) {
  Write-Host '  режим  : удаление'
} else {
  Write-Host "  режим  : $spec"
}
Write-Host ''

if (-not $pluginDir -and -not $Uninstall) { Fail 'нет исходников для установки' }

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
      if (-not $profileJson.dsh) { $profileJson | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object psobject) }
      if (-not $profileJson.dsh.profile) { $profileJson.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) }
      $profileJson.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
      $profileJson | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $profileManifest -Encoding utf8
      Ok 'бандл убран из dsh.profile.bundles'
    }
  } elseif (-not $selected) {
    $bundles += $name
    if (-not $profileJson.dsh) { $profileJson | Add-Member -NotePropertyName dsh -NotePropertyValue (New-Object psobject) }
    if (-not $profileJson.dsh.profile) { $profileJson.dsh | Add-Member -NotePropertyName profile -NotePropertyValue (New-Object psobject) }
    $profileJson.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
    $profileJson | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $profileManifest -Encoding utf8
    Ok 'бандл добавлен в dsh.profile.bundles'
  } else {
    Ok 'бандл уже выбран в профиле'
  }
}

Write-Host ''
if ($Uninstall) {
  Ok 'Готово. Перезапустите DSH, чтобы плагин исчез из интерфейса.'
} else {
  Ok 'Готово.'
  Write-Host '  1. Перезапустите DSH (настольное приложение) или `dsh web`.'
  Write-Host '  2. Плагины -> Voice Audio Rus -> «Скачать все модели».'
  Write-Host "  3. Обновить плагин: повторите этот скрипт — он перекачает GitHub@$Version."
}
