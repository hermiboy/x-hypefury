#!/bin/bash
# HypeFury V4 - Quick Installer
# Run: bash install.sh

echo "🚀 Installing HypeFury V4..."

# Install Node.js if needed
if ! command -v node &> /dev/null; then
  echo "📦 Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Install PM2 if needed
if ! command -v pm2 &> /dev/null; then
  echo "📦 Installing PM2..."
  npm install -g pm2
fi

# Setup
mkdir -p /root/hypefury-v4
cd /root/hypefury-v4

# Install dependencies
npm install puppeteer

# Setup PM2 to run every 6 hours
pm2 delete hypefury 2>/dev/null || true
pm2 start hypefury.js --name hypefury --cron '0 */6 * * *'
pm2 save

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Make sure /root/hypefury-cookies.json exists"
echo "2. Check: pm2 logs hypefury"
echo ""
