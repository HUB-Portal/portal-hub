<#
  One-time setup for a Vercel deployment (demo or test).

  What it does:
    1. Asks for the Neon "owner" connection string and the other values (nothing is sent anywhere except to your database).
    2. Makes the restricted app login (kph_app) with a new random password and runs the database migrations.
    3. Prints the complete list of environment variables to paste into Vercel, and copies it to the clipboard.

  Run from the repository root:
      powershell -ExecutionPolicy Bypass -File deploy\vercel\setup.ps1

  Nothing is written to disk. DATABASE_OWNER_URL is never put in the Vercel list: the running app must not hold the owner login.
#>
param([switch]$SkipMigrate)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $root

function Ask([string]$label, [string]$default = '') {
  $suffix = if ($default) { " [$default]" } else { '' }
  $v = Read-Host "$label$suffix"
  if ([string]::IsNullOrWhiteSpace($v)) { return $default }
  return $v.Trim()
}
function RandHex([int]$bytes) {
  $b = New-Object 'byte[]' $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (($b | ForEach-Object { $_.ToString('x2') }) -join '')
}
function RandB64([int]$bytes) {
  $b = New-Object 'byte[]' $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b)
}

Write-Host ''
Write-Host '== Database ==' -ForegroundColor Cyan
Write-Host 'In Neon: Connect, switch Connection pooling OFF, copy the postgresql://... string (the owner login).'
$ownerUrl = Ask 'Owner connection string'
if ($ownerUrl -notmatch '^(postgres(?:ql)?://)([^:@/]+):([^@]*)@(.+)$') { throw 'That does not look like a postgresql://user:password@host/db string.' }
$scheme = $Matches[1]; $ownerUser = $Matches[2]; $rest = $Matches[4]
if ($rest -match '-pooler') {
  Write-Host 'Removing "-pooler" from the host: the migration and the app both use the direct connection.' -ForegroundColor Yellow
  $rest = $rest -replace '-pooler', ''
  $ownerUrl = "$scheme$ownerUser`:$($Matches[3])@$rest"
}
$appPassword = RandHex 24
$appUrl = "${scheme}kph_app:$appPassword@$rest"

Write-Host ''
Write-Host '== Encryption keys ==' -ForegroundColor Cyan
Write-Host 'Paste your existing MASTER_KEYS JSON (starts with {), or press Enter to generate new ones.'
Write-Host 'Do not generate new keys if the database already holds data: it could no longer be read.' -ForegroundColor Yellow
$masterKeys = Ask 'MASTER_KEYS'
if (-not $masterKeys) {
  $masterKeys = (@{ k1 = (RandB64 32); b1 = (RandB64 32) } | ConvertTo-Json -Compress)
  Write-Host 'New keys generated. Keep a copy of the block printed at the end.' -ForegroundColor Yellow
}
$parsed = $masterKeys | ConvertFrom-Json
if (-not $parsed.k1 -or -not $parsed.b1) { throw 'MASTER_KEYS must contain the key ids k1 and b1.' }

Write-Host ''
Write-Host '== Public address and storage ==' -ForegroundColor Cyan
$publicUrl = Ask 'Public address of the site' 'https://portal-hub-jql6.vercel.app'
$s3Endpoint = Ask 'S3 endpoint (Neon: Connect > Storage > .env > AWS_ENDPOINT_URL_S3)'
$s3Region   = Ask 'S3 region (AWS_REGION)' 'us-east-1'
$s3Bucket   = Ask 'S3 bucket name' 'uploads'
$s3Key      = Ask 'S3 access key id (AWS_ACCESS_KEY_ID)'
$s3Secret   = Ask 'S3 secret access key (AWS_SECRET_ACCESS_KEY)'
$smtp       = Ask 'SMTP address (smtps://user:password@host:465), or Enter for a dummy' 'smtps://demo:demo-password@smtp.example.com:465'
$support    = Ask 'Support email' 'support@example.com'

if (-not $SkipMigrate) {
  Write-Host ''
  Write-Host '== Migration ==' -ForegroundColor Cyan
  if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Host 'Installing packages (npm ci) ...'
    & npm ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  }
  $env:DATABASE_OWNER_URL = $ownerUrl
  $env:DATABASE_URL = $appUrl
  $env:MASTER_KEYS = $masterKeys
  $env:ACTIVE_KEY_ID = 'k1'
  $env:BLIND_INDEX_KEY_ID = 'b1'
  & npm run migrate
  if ($LASTEXITCODE -ne 0) { throw 'The migration failed. Read the message above; nothing was changed in Vercel.' }
  Write-Host 'Migration finished.' -ForegroundColor Green
}

$block = @"
NODE_ENV=production
PORT=4000
TRUST_PROXY=true
PUBLIC_URL=$publicUrl
DATABASE_URL=$appUrl
MASTER_KEYS='$masterKeys'
ACTIVE_KEY_ID=k1
BLIND_INDEX_KEY_ID=b1
STORAGE_DRIVER=s3
S3_ENDPOINT=$s3Endpoint
S3_REGION=$s3Region
S3_BUCKET=$s3Bucket
S3_ACCESS_KEY_ID=$s3Key
S3_SECRET_ACCESS_KEY=$s3Secret
S3_FORCE_PATH_STYLE=true
SMTP_URL=$smtp
SUPPORT_EMAIL=$support
PRIVACY_EMAIL=$support
SCANNER=none
ALLOW_NO_SCANNER=true
RUN_WORKER=true
"@

Write-Host ''
Write-Host '== Paste this into Vercel (Settings > Environment Variables > paste into the Key box) ==' -ForegroundColor Cyan
Write-Host $block
try { Set-Clipboard -Value $block; Write-Host ''; Write-Host 'The block is also on your clipboard.' -ForegroundColor Green } catch {}
Write-Host ''
Write-Host 'After pasting: check that MASTER_KEYS starts with { (no quote mark), then redeploy.' -ForegroundColor Yellow
