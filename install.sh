#!/bin/bash
echo "🚀 Installing HypeFury V4..."

npm install

pm2 delete hypefury 2>/dev/null || true
pm2 start hypefury.js --name hypefury --cron '0 */6 * * *'
pm2 save

echo ""
echo "✅ Done!"
echo "Check: pm2 logs hypefury"
