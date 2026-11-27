$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$uiDir = Join-Path $root "ui"
$nativeDir = Join-Path $root "src\native"
$distDir = Join-Path $root "dist"
$outExe = Join-Path $distDir "MacacoLive.exe"

Write-Host "==> [1/3] Compilando interface React + Vite..." -ForegroundColor Cyan
Push-Location $uiDir
npm run build
if ($LASTEXITCODE -ne 0) { Pop-Location; exit $LASTEXITCODE }
Pop-Location

Write-Host "==> [2/3] Embutindo recursos web em memoria..." -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "pack-assets.ps1")

Write-Host "==> [3/3] Compilando executavel unico nativo C++20 (Zero DLLs)..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $distDir | Out-Null

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vsPath = & $vswhere -latest -property installationPath
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\vcvars64.bat"

$wvPkg = Get-ChildItem "$env:USERPROFILE\.nuget\packages\microsoft.web.webview2" -Directory | Sort-Object Name -Descending | Select-Object -First 1
$wvInc = Join-Path $wvPkg.FullName "build\native\include"
$wvLib = Join-Path $wvPkg.FullName "build\native\x64\WebView2LoaderStatic.lib"

$buildCmd = @"
call "$vcvars" >nul
cd /d "$nativeDir"
rc.exe /nologo /fo app.res app.rc
if errorlevel 1 exit /b 1
cl.exe /nologo /std:c++20 /O1 /Os /MT /EHsc /utf-8 /DNDEBUG ^
  /I"$wvInc" ^
  main.cpp app.res "$wvLib" ^
  user32.lib gdi32.lib gdiplus.lib shell32.lib shlwapi.lib ole32.lib oleaut32.lib advapi32.lib dwmapi.lib mmdevapi.lib avrt.lib d3d11.lib dxgi.lib version.lib winhttp.lib ^
  /link /SUBSYSTEM:WINDOWS /OPT:REF /OPT:ICF /OUT:"$outExe"
if errorlevel 1 exit /b 1
del /q main.obj app.res 2>nul
"@

$batFile = Join-Path $env:TEMP "build_macacolive_native.bat"
[System.IO.File]::WriteAllText($batFile, $buildCmd, [System.Text.Encoding]::ASCII)
cmd.exe /c "`"$batFile`""
if ($LASTEXITCODE -ne 0) {
  throw "Falha ao compilar binário nativo."
}

$sizeKB = [math]::Round((Get-Item $outExe).Length / 1KB, 0)
$sizeMB = [math]::Round((Get-Item $outExe).Length / 1MB, 2)

$outZip = Join-Path $distDir "MacacoLive.zip"
if (Test-Path $outZip) { Remove-Item -Force $outZip }
Compress-Archive -Path $outExe -DestinationPath $outZip -Force
$zipKB = [math]::Round((Get-Item $outZip).Length / 1KB, 0)

Write-Host ""
Write-Host "MacacoLive pronto em arquivo unico: $outExe ($sizeMB MB / $sizeKB KB)" -ForegroundColor Green
Write-Host "Versao ZIP (caso o Discord bloqueie extensao .exe): $outZip ($zipKB KB)" -ForegroundColor Green
