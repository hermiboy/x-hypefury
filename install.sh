#!/bin/bash
echo "🚀 Installing HypeFury V4..."

if ! command -v node &> /dev/null; then
  echo "📦 Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pm2 &> /dev/null; then
  echo "📦 Installing PM2..."
  npm install -g pm2
fi

npm install

pm2 delete hypefury 2>/dev/null || true
pm2 start hypefury.js --name hypefury --cron '0 */6 * * *'
pm2 save

echo ""
echo "✅ Done!"
echo "Check: pm2 logs hypefury"
