# One Development: Kommo для Claude — установка на Windows. Node.js не обязателен: если подходящего (20+) нет,
# скачивается официальный портативный node.exe (nodejs.org, сверка SHA-256) в %USERPROFILE%\.onedev-kommo\node —
# без прав администратора.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ver = 'v24.21.0'
$sums = @{ 'x64' = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'; 'arm64' = '8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921' }

function Test-Node($p) {
  if (-not $p -or -not (Test-Path $p)) { return $false }
  try { $v = & $p -v; return ([int]($v.TrimStart('v').Split('.')[0]) -ge 20) } catch { return $false }
}

$node = $null
foreach ($c in @((Join-Path $env:USERPROFILE '.onedev-kommo\node\node.exe'), (Join-Path $env:USERPROFILE '.onedev-connector\node\node.exe'))) {
  if (-not $node -and (Test-Node $c)) { $node = $c }
}
if (-not $node) {
  $sys = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($sys -and (Test-Node $sys.Source)) { $node = $sys.Source }
}
if (-not $node) {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $name = "node-$ver-win-$arch"
  Write-Host "Скачиваю Node.js ($name, ~37 МБ)..."
  $tmp = Join-Path $env:TEMP "onedev-$([guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp "$name.zip"
  Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($hash -ne $sums[$arch]) { throw "Контрольная сумма Node.js не совпала: $hash" }
  $tar = Join-Path $env:WINDIR 'System32\tar.exe'
  if (Test-Path $tar) { & $tar -xf $zip -C $tmp "$name/node.exe"; if ($LASTEXITCODE) { throw 'tar' } }
  else { Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force }
  $dir = Join-Path $env:USERPROFILE '.onedev-kommo\node'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $node = Join-Path $dir 'node.exe'
  Copy-Item -LiteralPath (Join-Path $tmp "$name\node.exe") -Destination $node -Force
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  Write-Host "Node.js готов: $node"
}
& $node (Join-Path $here 'install.mjs')
exit $LASTEXITCODE
