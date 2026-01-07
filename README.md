# 🤖 HypeFury X Automation V4

**Simple, Robust, No-Bullshit Tweet Engagement Bot**

## 🎯 What it does

Automatically engages with tweets on X (Twitter) via HypeFury:
- Switches between 2 accounts
- Replies with AI-style comments
- Tracks daily targets (23 + 17 = 40 replies/day)
- Runs 4x per day automatically

## 🚀 Features

✅ **Simple Approach** - No HTML parsing, works with visible elements  
✅ **Robust** - Multiple selector fallbacks, skip on errors  
✅ **Account Switching** - Auto-switches between @onlyrileyreeves & @itsrileyreeves  
✅ **State Tracking** - Remembers daily progress  
✅ **Proxy Support** - Built-in Webshare.io rotating proxy  
✅ **PM2 Automation** - Runs every 6 hours automatically  

## 📋 Requirements

- VPS (Ubuntu 24.04)
- Node.js 20+
- PM2
- HypeFury Account (logged in)
- Webshare.io Proxy

## 📦 Installation

See `SETUP.md` for detailed instructions.

**Quick:** Run `deploy.ps1` on Windows

## 🔧 Config

Edit `index.js`:

```javascript
const ACCOUNTS = {
  '@onlyrileyreeves': { dailyTarget: 23, replies: 0 },
  '@itsrileyreeves': { dailyTarget: 17, replies: 0 }
};
```

## 📊 Schedule

- **00:00 UTC** - Session 1 (2 tweets)
- **06:00 UTC** - Session 2 (2 tweets)
- **12:00 UTC** - Session 3 (2 tweets)
- **18:00 UTC** - Session 4 (2 tweets)

Total: **8 tweets/day** across 2 accounts

## 🎨 Reply Styles

Random selection from:
- "That's a game-changer! 🔥"
- "This hits different 💯"
- "Absolutely love this perspective!"
- "This is exactly what I needed to hear today 🙌"
- "Golden advice right here ✨"

## 📝 Logs

```bash
pm2 logs x-automation
```

## 🐛 Debug

```bash
cd /root/x-automation-v3
node index.js
```

## 📈 Version

**V4 - Simple Edition**
- No HTML parsing
- Direct element interaction
- Multiple selector fallbacks
- Skip on errors

Previous versions had issues with:
- HTML parsing causing hangs
- Scraping hundreds of tweets
- Complex selector logic

V4 fixes all of that!

## 🔐 Security

- Cookies stored in `/root/hypefury-cookies.json`
- Proxy credentials in code (rotate regularly)
- State in `/root/automation-state.json`

## ⚡ Performance

- Fast execution (~30-60 sec per session)
- No scroll loops
- Processes only visible tweets
- Headless Chrome

## 🎉 Status

**Production Ready!** 🚀

---

Made with 🔥 by Claude & Riley
