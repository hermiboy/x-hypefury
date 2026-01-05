# X-Automation System v3

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your GROK_API_KEY
```

## Commands

```bash
# Health check
npm run health

# Test mode (dry-run single session)
npm run test
TEST_ACCOUNT=@riley npm run test

# Production
npm start

# Dry-run mode (no posting)
DRY_RUN=true npm start

# Debug mode (verbose logs)
DEBUG=true npm start
```

## Update

```bash
git pull
npm install
pm2 restart x-automation
```

## Features

✅ Single-instance lock
✅ Persistent Chrome profile
✅ Winston logging + screenshots
✅ Health checks
✅ Dry-run mode
✅ Stable tweet IDs (SHA256)
✅ Active hours (8-22)
✅ Warmup schedule
✅ Circuit breakers
✅ WAL database mode
