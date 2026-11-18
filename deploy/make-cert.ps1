# 生成自签证书（仅供自用；公网用户会看到「不安全」警告）
# 用法：在仓库根目录执行  .\deploy\make-cert.ps1 -HostName zjc.rainplay.cn
param(
  [string]$HostName = 'localhost',
  [string]$OutDir = '.\data\tls'
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
  throw '未找到 openssl。装了 Git for Windows 的话通常在 C:\Program Files\Git\usr\bin\openssl.exe，可先加入 PATH。'
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$key = Join-Path $OutDir 'privkey.pem'
$crt = Join-Path $OutDir 'fullchain.pem'
$cnf = Join-Path $OutDir 'openssl.cnf'

@"
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
x509_extensions = v3_req

[dn]
CN = $HostName

[v3_req]
subjectAltName = @alt
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth

[alt]
DNS.1 = $HostName
DNS.2 = localhost
IP.1 = 127.0.0.1
"@ | Set-Content -Path $cnf -Encoding ASCII

openssl req -x509 -nodes -newkey rsa:2048 -days 825 -keyout $key -out $crt -config $cnf
if ($LASTEXITCODE -ne 0) { throw 'openssl 生成证书失败' }

Write-Host "证书: $crt"
Write-Host "私钥: $key"
Write-Host ''
Write-Host '在 .env 中加入：'
Write-Host "  TLS_CERT=$crt"
Write-Host "  TLS_KEY=$key"
Write-Host '  TLS_PORT=28472'
Write-Host '  BEHIND_HTTPS=1'
