$ErrorActionPreference = "Stop"

function Find-WixBin {
  $programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
  Get-ChildItem -Path $programFilesX86 -Directory -Filter "WiX Toolset v3*" |
    Sort-Object Name -Descending |
    ForEach-Object {
      $bin = Join-Path $_.FullName "bin"
      if ((Test-Path (Join-Path $bin "candle.exe")) -and
          (Test-Path (Join-Path $bin "light.exe"))) {
        return $bin
      }
    } |
    Select-Object -First 1
}

$candle = Get-Command candle.exe -ErrorAction SilentlyContinue
$light = Get-Command light.exe -ErrorAction SilentlyContinue
$wixBin = if ($candle -and $light) { Split-Path $candle.Source } else { Find-WixBin }
if (-not $wixBin) {
  choco install wixtoolset --yes --no-progress
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  $wixBin = Find-WixBin
}

if (-not $wixBin) {
  throw "WiX Toolset v3 with candle.exe and light.exe was not found."
}

$env:PATH = "$wixBin;$env:PATH"
$wixBin >> $env:GITHUB_PATH
Write-Host "Using WiX Toolset from $wixBin"
