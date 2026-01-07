# HypeFury V4 - Setup Instructions

## 📦 Was ist drin?

- **index.js** - Hauptscript (V4 - Simple, kein HTML-Parsing)
- **package.json** - Dependencies
- **deploy.ps1** - PowerShell Deployment Script
- **SETUP.md** - Diese Anleitung

## 🚀 Quick Start

### Variante 1: PowerShell Script (Automatisch)

1. **Extract ZIP nach:** `C:\hypefury-v4`

2. **PowerShell als Admin öffnen**

3. **Script ausführen:**
   ```powershell
   cd C:\hypefury-v4
   .\deploy.ps1
   ```

Das Script:
- Uploaded alle Dateien zum VPS
- Installiert npm dependencies
- Richtet PM2 ein (4x täglich)
- Startet das System

### Variante 2: Manuell via VNC

1. **VNC zum VPS verbinden:**
   - IP: `108.61.128.18:5901`
   - Password: `XQPHAw42`

2. **Terminal öffnen und:**
   ```bash
   cd /root
   mkdir -p x-automation-v3
   cd x-automation-v3
   
   # Upload die Dateien (via FileZilla/WinSCP oder copy-paste)
   # Oder lade ZIP hoch und:
   unzip hypefury-v4.zip
   
   # Install
   npm install
   
   # Setup PM2
   pm2 delete x-automation 2>/dev/null || true
   pm2 start index.js --name x-automation --cron '0 */6 * * *'
   pm2 save
   
   # Check
   pm2 logs x-automation
   ```

## 📊 System Details

### Accounts
- `@onlyrileyreeves` - 23 replies/day
- `@itsrileyreeves` - 17 replies/day

### Schedule
- **4 Sessions pro Tag** (alle 6 Stunden)
- Zeiten: 00:00, 06:00, 12:00, 18:00 UTC
- Pro Session: 2 Tweets bearbeiten
- Total: 8 Tweets/Tag

### Files auf VPS
- Script: `/root/x-automation-v3/index.js`
- Cookies: `/root/hypefury-cookies.json` (muss existieren!)
- State: `/root/automation-state.json` (wird automatisch erstellt)

## 🔧 Wichtige Befehle

### PM2 Management
```bash
pm2 logs x-automation          # Live logs anschauen
pm2 logs x-automation --lines 100  # Letzte 100 Zeilen
pm2 restart x-automation       # Neustart
pm2 stop x-automation          # Stoppen
pm2 delete x-automation        # Löschen
pm2 list                       # Alle Prozesse
```

### State checken
```bash
cat /root/automation-state.json
```

Zeigt:
- Heutige Datum
- Replies pro Account
- Sessions heute

### Manual Test
```bash
cd /root/x-automation-v3
node index.js
```

## ⚠️ Wichtig: Cookies!

Das Script braucht `/root/hypefury-cookies.json`!

Wenn nicht vorhanden, musst du:
1. Via VNC einloggen
2. Browser öffnen
3. HypeFury einloggen
4. Cookies extrahieren

## 🎯 Was V4 macht

**SIMPLE APPROACH:**
1. Öffne Engagement Builder
2. Warte auf Tweets
3. Nimm erste 2 sichtbare Tweets
4. Klick Reply Button direkt
5. Type AI-Comment
6. Send
7. Next Tweet

**KEIN:**
- ❌ HTML Parsing
- ❌ Langes Scraping
- ❌ Scroll-Loops
- ❌ Komplexe Selektoren

**Features:**
- ✅ Mehrere Selector-Fallbacks
- ✅ Skip bei Fehler
- ✅ Account Switching
- ✅ State Tracking
- ✅ Daily Targets
- ✅ Proxy Support

## 🐛 Troubleshooting

### Script hängt sich auf
```bash
pm2 restart x-automation
pm2 logs x-automation --lines 50
```

### Keine Tweets gefunden
Prüfe ob:
- Cookies noch gültig
- Account eingeloggt
- Engagement Builder hat Tweets

### Account Switch klappt nicht
```bash
# Check logs für "Account switched"
pm2 logs x-automation | grep -A 5 "Account"
```

### Daily Targets ändern
Edit `/root/x-automation-v3/index.js`:
```javascript
const ACCOUNTS = {
  '@onlyrileyreeves': { dailyTarget: 30, replies: 0 },  // Geändert!
  '@itsrileyreeves': { dailyTarget: 20, replies: 0 }
};
```
Dann: `pm2 restart x-automation`

## 📞 Support

Bei Problemen:
1. Check Logs: `pm2 logs x-automation --lines 100`
2. Check State: `cat /root/automation-state.json`
3. Manual Test: `cd /root/x-automation-v3 && node index.js`

## 🎉 Success Checks

System läuft wenn:
- ✅ `pm2 list` zeigt "online"
- ✅ Logs zeigen "SESSION START" alle 6 Stunden
- ✅ State zeigt steigende Reply-Zahlen
- ✅ Keine Fehler in Logs

**LET'S FUGGING GOOO!** 🔥
