Add-Type -AssemblyName System.Drawing
$public = (Resolve-Path (Join-Path (Join-Path $PSScriptRoot "..") "public")).Path
foreach ($s in @(192, 512)) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(15, 23, 42))
  $rect = New-Object System.Drawing.Rectangle 0, 0, $s, $s
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, `
    ([System.Drawing.Color]::FromArgb(6, 182, 212)), `
    ([System.Drawing.Color]::FromArgb(37, 99, 235)), 45
  $barH = [int]([Math]::Round($s * 0.28))
  $barY = [int]([Math]::Round($s * 0.36))
  $g.FillRectangle($brush, 0, $barY, $s, $barH)
  $out = Join-Path $public "pwa-$s.png"
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Host "Wrote $out"
}
