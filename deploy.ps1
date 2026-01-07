# HypeFury V4 - PowerShell Deployment Script
# Run this on your LOCAL Windows machine

$VPS_IP = "108.61.128.18"
$VPS_USER = "root"
$LOCAL_DIR = "C:\hypefury-v4"

Write-Host "🚀 HypeFury V4 Deployment Script" -ForegroundColor Green
Write-Host ""

# Check if files exist
if (-not (Test-Path $LOCAL_DIR)) {
    Write-Host "❌ Directory $LOCAL_DIR not found!" -ForegroundColor Red
    Write-Host "Please extract the ZIP first to C:\hypefury-v4" -ForegroundColor Yellow
    exit 1
}

Write-Host "📦 Found local directory: $LOCAL_DIR" -ForegroundColor Cyan

# Upload files to VPS using SCP (requires OpenSSH or PuTTY pscp.exe)
Write-Host ""
Write-Host "📤 Uploading files to VPS..." -ForegroundColor Yellow

# Create directory on VPS
ssh ${VPS_USER}@${VPS_IP} "mkdir -p /root/x-automation-v3"

# Upload files
scp -r "${LOCAL_DIR}\*" ${VPS_USER}@${VPS_IP}:/root/x-automation-v3/

Write-Host "✅ Files uploaded!" -ForegroundColor Green

# Install and setup on VPS
Write-Host ""
Write-Host "🔧 Setting up on VPS..." -ForegroundColor Yellow

ssh ${VPS_USER}@${VPS_IP} @"
cd /root/x-automation-v3
echo '📦 Installing dependencies...'
npm install
echo '✅ Dependencies installed!'
echo ''
echo '🔄 Setting up PM2...'
pm2 delete x-automation 2>/dev/null || true
pm2 start index.js --name x-automation --cron '0 */6 * * *'
pm2 save
echo '✅ PM2 configured!'
echo ''
echo '📊 Current status:'
pm2 list
echo ''
echo '📋 Recent logs:'
pm2 logs x-automation --lines 20 --nostream
"@

Write-Host ""
Write-Host "✅ DEPLOYMENT COMPLETE!" -ForegroundColor Green
Write-Host ""
Write-Host "📊 Useful commands:" -ForegroundColor Cyan
Write-Host "  ssh ${VPS_USER}@${VPS_IP} 'pm2 logs x-automation'" -ForegroundColor Gray
Write-Host "  ssh ${VPS_USER}@${VPS_IP} 'pm2 restart x-automation'" -ForegroundColor Gray
Write-Host "  ssh ${VPS_USER}@${VPS_IP} 'cat /root/automation-state.json'" -ForegroundColor Gray
Write-Host ""
