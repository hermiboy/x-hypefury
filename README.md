# 🤖 HypeFury V4 - X Automation

**Automatic tweet engagement bot for HypeFury**

## 🚀 Quick Start

```bash
# 1. Clone repo
cd /root
git clone https://github.com/YOUR-USERNAME/hypefury-v4.git
cd hypefury-v4

# 2. Run installer
bash install.sh

# 3. Check logs
pm2 logs hypefury
```

Done! 🎉

## 📦 What's included

- `hypefury.js` - Main script
- `package.json` - Dependencies (just puppeteer)
- `install.sh` - Auto installer
- `README.md` - This file

## ⚙️ Configuration

Edit `hypefury.js` to change:
- Daily targets per account
- Reply messages
- Tweets per session

```javascript
const ACCOUNTS = {
  '@onlyrileyreeves': { dailyTarget: 23, replies: 0 },
  '@itsrileyreeves': { dailyTarget: 17, replies: 0 }
};
```

## 📊 How it works

1. Runs 4x per day (every 6 hours)
2. Opens HypeFury Engagement Builder
3. Processes 2 tweets per session
4. Auto-switches between accounts
5. Tracks daily progress

**Total: 8 tweets/day across 2 accounts**

## 🔧 Commands

```bash
# View logs
pm2 logs hypefury

# Restart
pm2 restart hypefury

# Stop
pm2 stop hypefury

# Check state
cat /root/automation-state.json

# Manual test
cd /root/hypefury-v4
node hypefury.js
```

## ⚠️ Requirements

- Ubuntu/Debian VPS
- Node.js 20+
- PM2
- HypeFury account logged in
- Cookies saved at `/root/hypefury-cookies.json`

## 🍪 Getting cookies

1. Login to HypeFury in browser
2. Open DevTools (F12)
3. Go to Console tab
4. Run: `copy(JSON.stringify(document.cookie))`
5. Save output to `/root/hypefury-cookies.json`

## 📅 Schedule

- 00:00 UTC - Session 1
- 06:00 UTC - Session 2
- 12:00 UTC - Session 3
- 18:00 UTC - Session 4

## 🐛 Troubleshooting

**Script not running:**
```bash
pm2 restart hypefury
pm2 logs hypefury --lines 50
```

**No tweets found:**
- Check if cookies are still valid
- Make sure HypeFury has tweets in Engagement Builder

**Change targets:**
```bash
nano /root/hypefury-v4/hypefury.js
# Edit ACCOUNTS config
pm2 restart hypefury
```

## 📝 License

MIT

---

Made with 🔥
