param(
  [string]$WwwRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "src\MacacoLive.App\wwwroot"),
  [string]$OutHeader = (Join-Path (Split-Path -Parent $PSScriptRoot) "src\native\embedded_assets.h")
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutHeader) | Out-Null

function Get-MimeType([string]$ext) {
  switch ($ext.ToLowerInvariant()) {
    ".html" { return "text/html; charset=utf-8" }
    ".js"   { return "application/javascript; charset=utf-8" }
    ".mjs"  { return "application/javascript; charset=utf-8" }
    ".css"  { return "text/css; charset=utf-8" }
    ".png"  { return "image/png" }
    ".svg"  { return "image/svg+xml" }
    ".ico"  { return "image/x-icon" }
    ".json" { return "application/json; charset=utf-8" }
    default { return "application/octet-stream" }
  }
}

$files = Get-ChildItem -Path $WwwRoot -Recurse -File | Sort-Object FullName
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine("#pragma once")
[void]$sb.AppendLine("#include <cstdint>")
[void]$sb.AppendLine("")
[void]$sb.AppendLine("struct EmbeddedAsset {")
[void]$sb.AppendLine("    const wchar_t* path;")
[void]$sb.AppendLine("    const wchar_t* mime;")
[void]$sb.AppendLine("    const uint8_t* data;")
[void]$sb.AppendLine("    uint32_t size;")
[void]$sb.AppendLine("};")
[void]$sb.AppendLine("")

$entries = @()
$idx = 0
$totalBytes = 0

foreach ($f in $files) {
  $rel = $f.FullName.Substring($WwwRoot.Length).Replace('\', '/')
  if (-not $rel.StartsWith('/')) { $rel = '/' + $rel }
  $mime = Get-MimeType $f.Extension
  $bytes = [System.IO.File]::ReadAllBytes($f.FullName)
  $totalBytes += $bytes.Length
  $varName = "kAssetData_$idx"

  [void]$sb.Append("alignas(8) static const uint8_t $varName[$($bytes.Length)] = {")
  for ($i = 0; $i -lt $bytes.Length; $i++) {
    if (($i % 24) -eq 0) { [void]$sb.Append("`n  ") }
    [void]$sb.Append($bytes[$i])
    if ($i -lt ($bytes.Length - 1)) { [void]$sb.Append(",") }
  }
  [void]$sb.AppendLine("`n};")
  [void]$sb.AppendLine("")

  $entries += "    { L`"$rel`", L`"$mime`", $varName, $($bytes.Length)u }"
  $idx++
}

[void]$sb.AppendLine("static const EmbeddedAsset kEmbeddedAssets[$($entries.Count)] = {")
[void]$sb.AppendLine(($entries -join ",`n"))
[void]$sb.AppendLine("};")
[void]$sb.AppendLine("static constexpr size_t kEmbeddedAssetCount = $($entries.Count);")

[System.IO.File]::WriteAllText($OutHeader, $sb.ToString(), (New-Object System.Text.UTF8Encoding $false))
Write-Output ("PACKED_ASSETS=" + $entries.Count + " BYTES=" + $totalBytes)
