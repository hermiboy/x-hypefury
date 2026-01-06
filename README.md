# X-Automation System - ULTIMATE EDITION

## 🔥 Features

### ChatGPT Fixes ✅
- Stable Tweet IDs (SHA256, single source)
- NO Playwright selectors (Puppeteer-safe)
- Circuit breaker (5 failures = 1h pause)
- Stale lock detection
- Error screenshots everywhere

### Tweet Age Mix ✅
- Fresh (<10 min): 20-40%
- Medium (10-30 min): 30-50%
- Older (30min-2h): 10-30%
- Old (2-6h): 0-20%
- Percentages randomized per session

### Daily Planning ✅
- Morning: Calculate targets (15-25 per account)
- Distribute across 3 sessions
- Min 2 appearances per account
- Session 3 = cleanup (must complete)
- Guaranteed EOD target hit

### Max Variability ✅
- Per-account skip rates (configurable)
- Per-account active hours
- Random session start times
- Shuffled account order
- Gaussian delays (3-10 min)
- No patterns anywhere!

## 🚀 Commands

```bash
# Health check
npm run health

# Test mode (session 1 only, dry-run)
npm run test
TEST_ACCOUNT=@riley npm run test

# Dry-run (no posting)
DRY_RUN=true npm start

# Debug mode
DEBUG=true npm start

# Production
npm start
```

## 📊 Logs & Screenshots

```bash
# View logs
tail -f logs/$(date +%Y-%m-%d).log
tail -f logs/errors.log

# Screenshots
ls -la logs/screenshots/
```

## 🔧 Configuration

**config.json:**
- `skip_rate`: Per-account (0.55 = 55% skip)
- `active_hours`: Per-account start/end
- `warmup_schedule`: Week-based limits

**Per-Account Settings:**
```json
{
  "twitter_handle": "@handle",
  "skip_rate": 0.65,
  "active_hours": { "start": 8, "end": 22 }
}
```

## 📋 How It Works

### Morning (First Run):
1. Calculate daily targets (random: 15-25)
2. Distribute across 3 sessions
3. Plan which accounts in which sessions

### Session 1 (Random time 8-10am):
- Process accounts with targets
- Mix of tweet ages (fresh + older)
- Random skips per account
- Delays between accounts

### Session 2 (Random time 1-3pm):
- Continue with remaining targets
- Different account order
- Different tweet age mix

### Session 3 (Random time 7-9pm):
- CLEANUP MODE
- Must complete remaining targets
- More lenient (older tweets OK)

## 🎯 Target Guarantee

Every account hits its target by EOD:
- Morning: Target calculated (e.g. 21 replies)
- Session 1: 7 replies
- Session 2: 6 replies
- Session 3: 8 replies (completes remaining)

## 🔒 Safety Features

- Single instance lock (prevents overlaps)
- Circuit breaker (API failures)
- Warmup enforcement
- Active hours per account
- Age-mixed tweets (not only fresh)
- Random everything

## 🐛 Debugging

```bash
# If stuck
rm /tmp/x-automation.lock

# View what's happening
DEBUG=true npm run test

# Check database
sqlite3 automation.db "SELECT * FROM daily_stats"
sqlite3 automation.db "SELECT * FROM session_plans WHERE date='2026-01-06'"
```

## 📦 Update

```bash
git pull
npm install
pm2 restart x-automation
```
