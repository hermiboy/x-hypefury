# X-Automation System v3.0 ULTIMATE

## 🔥 All Features Implemented

### Engagement Score System
- Calculates: (Likes ÷ Minutes) × Age Multiplier
- Age multipliers: <15min=2.0x, 15-30min=1.5x, etc.
- Account speed personality bias

### Smart Tweet Selection
- Scrapes all available tweets
- Calculates engagement score for each
- Sorts by score (viral + fresh = best)
- Selects top 8-12
- **Random picks 5-7 from top** (not strict top 6!)

### Max 1 Reply Rule
- Tracks replied authors per account per day
- Never replies to same author twice in one day
- Natural behavior!

### Variability Everywhere
- **Sessions per day:** 3-4 (random)
- **Accounts per session:** 3-7 (random, not all!)
- **Reply timing:** Fast (3-8s) / Medium (15-45s) / Slow (1-3min)
- **Engagement mix:** ±5% daily + ±2% per session
- **Session early exit:** 20% chance to stop at 60% target

### Engagement Mix
- **Replies:** 65-85% (varies per account + daily + session)
- **Likes:** 10-30% (with timing: ±3s around reply, or standalone)
- **Retweets:** 0-2 per day (from top 4 in last 20h pool)

### Like Timing
- 60% AFTER reply: +500ms to +3000ms
- 40% BEFORE reply: -2000ms to -500ms
- Natural mixed behavior!

### Retweets
- 0-2 per day (random)
- Pool: Last 20 hours, top 4 by likes
- Account-specific time windows (e.g. Account 1: evenings, Account 2: mornings)

### Low Activity Days
- 15% chance per day
- 5-8 replies instead of 15-25
- Mimics "busy day" / "not in mood"

### Account Personalities
- **Speed:** Fast responders vs. Slow responders
- **Engagement:** Reply-heavy vs. Like-heavy
- **Retweet timing:** Morning vs. Evening vs. Afternoon

### Proxy Integration
- All accounts through 1 IPS Residential Proxy
- Configured in config.json
- Anonymous to HypeFury/X

## 🚀 Commands

```bash
npm run health    # Check all systems
npm run test      # Single session test
npm start         # Production 24/7
DRY_RUN=true npm start  # No posting
```

## 📊 How It Works

### Daily:
1. System calculates targets (15-25 or 5-8 if low day)
2. Decides 3-4 sessions
3. Each session: 3-7 random accounts

### Session:
1. Browser opens HypeFury via proxy
2. Switch to account
3. Scrape engagement builder feed
4. Calculate scores for all tweets
5. Sort by score
6. Pick top 8-12
7. Random select 5-7
8. For each:
   - Check: Already replied to this author today? Skip
   - Decide: Reply / Like / Skip (based on engagement mix)
   - If reply: Generate with Grok + post
   - Maybe like too (40% chance, ±3s timing)
9. Wait 4-12 minutes
10. Next account

### Retweets:
- During retweet time window
- Get last 20h tweets
- Top 4 by likes
- Random 0-2
- Post with 30-60s delays

## 🔧 Configuration

**config.json:**
- Proxy credentials
- Per-account settings:
  - Speed personality (fast/medium/slow)
  - Reply timing distribution
  - Engagement mix rates
  - Retweet time window

**Add more accounts:**
Copy account block, change handle + settings!

## 📋 What's Different from v2

- ✅ Engagement score system (viral + fresh)
- ✅ Top 8-12 → random 5-7 (not strict top 6)
- ✅ Max 1 reply per author per day
- ✅ 3-4 sessions (variable)
- ✅ Reply timing personalities (3 speeds)
- ✅ Engagement mix ±5% daily + ±2% session
- ✅ Likes with realistic timing
- ✅ Retweets (0-2/day from pool)
- ✅ Low activity days (5-8 replies)
- ✅ Session early exit (20% chance)
- ✅ Proxy integration
- ✅ Account speed personalities

## 🐛 Debugging

```bash
DEBUG=true npm run test
ls -la logs/screenshots/
tail -f logs/$(date +%Y-%m-%d).log
```

## 📦 Update

```bash
git pull
npm install
pm2 restart x-automation
```
