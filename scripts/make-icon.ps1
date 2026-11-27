param(
  [string]$OutIco = (Join-Path (Split-Path -Parent $PSScriptRoot) "src\MacacoLive.App\app.ico"),
  [string]$OutPng = (Join-Path (Split-Path -Parent $PSScriptRoot) "ui\public\logo.png")
)

Add-Type -AssemblyName System.Drawing

function New-Color([string]$hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

# Same geometry as ui/src/Logo.tsx (64x64 grid)
function Draw-Mark([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $k = $size / 64.0

  $banana = New-Object System.Drawing.SolidBrush (New-Color "#F5C842")
  $fur    = New-Object System.Drawing.SolidBrush (New-Color "#6B4423")
  $face   = New-Object System.Drawing.SolidBrush (New-Color "#EBCB9E")
  $ink    = New-Object System.Drawing.SolidBrush (New-Color "#1F150B")

  # Tile
  $r = 15 * $k * 2
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $w = $size - 1
  $p.AddArc(0, 0, $r, $r, 180, 90)
  $p.AddArc($w - $r, 0, $r, $r, 270, 90)
  $p.AddArc($w - $r, $w - $r, $r, $r, 0, 90)
  $p.AddArc(0, $w - $r, $r, $r, 90, 90)
  $p.CloseFigure()
  $g.FillPath($banana, $p)

  function Circle($brush, [double]$cx, [double]$cy, [double]$rad) {
    $g.FillEllipse($brush, [single](($cx - $rad) * $k), [single](($cy - $rad) * $k), [single](2 * $rad * $k), [single](2 * $rad * $k))
  }
  function Ellipse($brush, [double]$cx, [double]$cy, [double]$rx, [double]$ry) {
    $g.FillEllipse($brush, [single](($cx - $rx) * $k), [single](($cy - $ry) * $k), [single](2 * $rx * $k), [single](2 * $ry * $k))
  }

  Circle $fur 16 30 8
  Circle $fur 48 30 8
  Circle $face 16 30 4
  Circle $face 48 30 4
  Circle $fur 32 33.5 17.5
  Circle $face 26.5 31 6.5
  Circle $face 37.5 31 6.5
  Ellipse $face 32 39.5 11 8
  Circle $ink 27 31 2
  Circle $ink 37 31 2

  if ($size -ge 32) {
    Circle $ink 30.4 37.6 0.9
    Circle $ink 33.6 37.6 0.9
    $pen = New-Object System.Drawing.Pen ((New-Color "#1F150B"), [single](1.7 * $k))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $g.DrawBezier($pen, [single](28 * $k), [single](42 * $k), [single](30 * $k), [single](44.6 * $k), [single](34 * $k), [single](44.6 * $k), [single](36 * $k), [single](42 * $k))
    $pen.Dispose()
  }

  $g.Dispose()
  return $bmp
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$pngs = @()
foreach ($s in $sizes) {
  $bmp = Draw-Mark $s
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $pngs += , ($ms.ToArray())
  if ($s -eq 256) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutPng) | Out-Null
    $bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $bmp.Dispose()
  $ms.Dispose()
}

$fs = [System.IO.File]::Create($OutIco)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]
  $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim)
  $bw.Write([byte]$dim)
  $bw.Write([byte]0)
  $bw.Write([byte]0)
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]$pngs[$i].Length)
  $bw.Write([UInt32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($data in $pngs) { $bw.Write($data) }
$bw.Dispose()
$fs.Dispose()

Write-Output "ICON_OK $OutIco"
Write-Output "PNG_OK $OutPng"
