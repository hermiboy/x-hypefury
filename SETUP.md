# 🚀 X-AUTOMATION - KOMPLETTE SETUP ANLEITUNG

## SCHRITT 1: Mit VPS verbinden

Öffne **Windows PowerShell** und copy-paste:

```
ssh root@108.61.128.18
```

**Password:** `7[Qf?)_8,t=%TXR=`

*(Du siehst Password nicht beim Tippen - das ist normal!)*

Wenn erfolgreich siehst du:
```
root@Hypefurry-X:~#
```

---

## SCHRITT 2: Alte Versionen löschen

```bash
cd /root
rm -rf x-automation x-automation-v2
```

---

## SCHRITT 3: Neuen Code von GitHub holen

```bash
git clone https://github.com/hermiboy/x-automation.git x-automation-v2
cd x-automation-v2
```

---

## SCHRITT 4: Dependencies installieren

```bash
npm install
```

*(Dauert 1-2 Minuten)*

---

## SCHRITT 5: .env File erstellen

```bash
cat > .env << 'EOF'
GROK_API_KEY=xai-NjF3YSzR7CjuZt4EiryzIeI3knEbN3iJZmcg6CDIZgY0h4VOhOFBiEg9vaVwmfP3MN8K0mo2Z5rqDCWE
PORT=3000
NODE_ENV=production
TZ=America/New_York
EOF
```

---

## SCHRITT 6: Check Files

```bash
ls -la
```

Du solltest sehen:
- index.js
- config.json
- package.json
- .env
- node_modules/

---

## SCHRITT 7: System starten

```bash
node index.js
```

**System läuft!**

---

## ⚙️ System stoppen

**CTRL + C**

---

## 🚀 Background-Modus (24/7)

```bash
screen -S x-automation
node index.js
```

**Detach:** CTRL + A, dann D

**Logs anschauen:**
```bash
screen -r x-automation
```

**Wieder raus:** CTRL + A, dann D

---

## 🔧 Code updaten

Nachdem du Code auf GitHub geändert hast:

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

## 📊 Was du sehen solltest

```
✅ Database initialized
🤖 X-Automation System Started
📅 Timezone: America/New_York
⏰ Active Hours: 8:00 - 22:00
📊 Accounts: @onlyrileyreeves, @itsrileyreeves

🎯 Processing @onlyrileyreeves
📅 Week 2 - Limit: 0-2 replies
📊 Today's replies: 0/2
📡 [MOCK] Fetching tweets...
💭 Generating reply...
✅ Generated reply: "..."
```

---

## ⚠️ Troubleshooting

**Problem: Grok API Error 404**
→ Check ob .env richtig erstellt wurde:
```bash
cat .env
```

**Problem: Node nicht gefunden**
```bash
node --version
```
Sollte: v20.x zeigen

**Problem: npm install failed**
```bash
rm -rf node_modules
npm install
```

---

## 📋 Config anpassen

```bash
nano config.json
```

Ändere:
- `prompt` - Dein Custom-Prompt
- `created_date` - Wann Account erstellt
- `target_accounts` - Welche Accounts targeten

**Speichern:** CTRL + X → Y → ENTER

---

## 💰 Kosten

```
Vultr VPS: 9€
Grok API: 8€
HypeFury: 68€ (später)
X Premium: 108€ (10 Accounts)
────────────
TOTAL: 193€/Monat
```

---

**Bei Fragen: Screenshot + ich helfe!** 💪
