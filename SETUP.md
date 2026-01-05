# 🚀 X-Automation Phase 2 - Setup Guide

## Was das System macht:

✅ Logged automatisch in HypeFury ein
✅ Wechselt zwischen deinen X-Accounts
✅ Liest Engagement Builder Feed
✅ Berechnet Engagement-Rate (Likes/Minute)
✅ Generiert Replies mit Grok AI
✅ Postet mit human-like behavior (mouse, typing, delays)
✅ Liked Posts (80% bei eigenen Replies + extras)
✅ Retweetet beste Posts
✅ Sessions mit 2-4 Durchläufen (30-60 Min)
✅ Excludes 3 random Accounts pro Session
✅ Komplett variable Delays (0 Pattern!)
✅ Warmup-Schedule automatisch

---

## 📋 Setup auf VPS (Step-by-Step)

### 1. Alte Version löschen

```bash
cd /root
rm -rf x-automation
```

### 2. Neue Version von GitHub holen

```bash
git clone https://github.com/hermiboy/x-automation.git x-automation-v2
cd x-automation-v2
```

### 3. Dependencies installieren

```bash
npm install
```

Dauert 1-2 Minuten.

### 4. Config anpassen

```bash
nano config.json
```

**Ändere:**
- `twitter_handle` - Deine 2 Test-Accounts (aktuell: @onlyrileyreeves, @itsrileyreeves)
- `created_date` - Wann Account erstellt wurde (für Warmup)
- `prompt` - Dein Custom-Prompt pro Account
- `reply_style` - Dein Stil

**Speichern:** CTRL + X → Y → ENTER

### 5. HypeFury vorbereiten

**Auf deinem lokalen PC:**

1. Connecte 2 X-Accounts zu HypeFury (manuell, 1-2 Tage Abstand)
2. Stelle sicher HypeFury Engagement Builder funktioniert

---

## 🚀 System starten

### Option A: Foreground (zum Testen)

```bash
node index.js
```

Du siehst alle Logs live.
**Stoppen:** CTRL + C

### Option B: Background (Production)

```bash
screen -S x-automation
node index.js
```

**Detach:** CTRL + A, dann D

**Logs anschauen:**
```bash
screen -r x-automation
```

**System stoppen:**
```bash
screen -r x-automation
# Dann: CTRL + C
```

---

## ⚙️ Wichtige Settings

### config.json

```json
{
  "min_tweet_likes": 1000,          // Nur Tweets mit 1000+ Likes
  "min_engagement_rate": 5,         // Likes pro Minute Minimum
  "session_settings": {
    "min_duration_minutes": 30,     // Session: 30-60 Min
    "max_duration_minutes": 60,
    "min_pause_minutes": 15,        // Pause: 15-60 Min
    "max_pause_minutes": 60,
    "accounts_to_exclude_per_session": 3,  // 3 Accounts excluded
    "passes_per_session_min": 2,    // 2-4 Durchläufe
    "passes_per_session_max": 4
  }
}
```

---

## 📊 Was du siehst (Logs)

```
🚀 SESSION STARTED
⏱️  Duration: 42 minutes
🔄 Passes: 3
🚫 Excluded: @account3, @account7, @account10
✅ Active: @account1, @account2, @account4, @account5, @account6, @account8, @account9

--- Pass 1/3 ---

🎯 Processing @account2
📊 Today: 2 replies, 8 likes
📅 Week 2: Limit 0-2
📨 Found 15 tweets
✨ 5 quality tweets found

💭 Generating reply for: "Hot take: Dating apps are dead..."
📝 Reply: "Not dead, just evolved. The game changed..."
❤️  Liking tweet...
💬 Posting reply...
✅ Reply posted

⏸️  Waiting 7 minutes before next account...
```

---

## 🎯 Account-Prompts anpassen

**Für jeden Account eigenen Stil:**

```bash
nano config.json
```

**Beispiel:**

```json
{
  "twitter_handle": "@onlyrileyreeves",
  "prompt": "You're a relationship coach. Keep it real, bold, but not cringe. No hashtags unless relevant. Max 280 chars. Focus on practical insights that make people think differently.",
  "reply_style": "Give counter-intuitive dating advice"
}
```

**Speichern:** CTRL + X → Y → ENTER

---

## 🔧 Troubleshooting

### Problem: Browser startet nicht

```bash
# Chrome neu installieren
apt install -y google-chrome-stable
```

### Problem: HypeFury Login failed

- Manuell einloggen wenn Browser öffnet
- System wartet 30 Sekunden

### Problem: Keine Tweets gefunden

- Check HypeFury Engagement Builder (manuell)
- Sind User/Keywords hinzugefügt?

### Problem: Grok API Error

- Check API Key in `.env`
- Check Grok API Guthaben

---

## 📈 System überwachen

### Logs live anschauen:

```bash
screen -r x-automation
```

### Database checken:

```bash
sqlite3 automation.db
SELECT * FROM daily_stats;
.quit
```

### Code updaten (nach GitHub-Push):

```bash
cd /root/x-automation-v2
git pull
npm install
screen -r x-automation
# CTRL + C (stoppen)
node index.js
# CTRL + A, dann D (detach)
```

---

## 🎯 Nächste Schritte

**Nach 1-2 Wochen Test:**

1. Weitere Accounts zu config.json hinzufügen
2. Prompts optimieren
3. Settings anpassen (mehr Replies, etc.)

**config.json erweitern:**

```json
{
  "accounts": [
    { "twitter_handle": "@account1", ... },
    { "twitter_handle": "@account2", ... },
    { "twitter_handle": "@account3", ... }
    // bis 10 Accounts
  ]
}
```

---

## 🚨 Wichtige Hinweise

- System läuft mit **Browser sichtbar** (headless: false)
- Nutzt **human-like patterns** (ghost-cursor, random delays)
- **Warmup-Schedule** automatisch basierend auf `created_date`
- **3 Accounts excluded** pro Session = weniger Pattern
- **Variable alles** = 0% Detection-Risiko

---

## 💰 Kosten Reminder

```
HypeFury: 68€
X Premium (10 Accounts): 108€
Grok API: 8€
Vultr VPS: 9€
────────────────
GESAMT: 193€/Monat
```

(Ohne Proxies da HypeFury = whitelisted!)

---

**Bei Problemen: Screenshot Logs + ich helfe!** 💪
