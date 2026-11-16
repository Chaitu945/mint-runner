# Deploying the mint bot on your Tencent Lighthouse VPS

You already run PM2 on this VPS for the wallet tracker bot, so this reuses
the same pattern.

## 1. SSH in
```bash
ssh your_user@your_vps_ip
```

## 2. Install Node.js if not already present
```bash
node -v   # check first
# if missing:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

## 3. Upload your project
From your local machine:
```bash
scp -r mint-bot-example your_user@your_vps_ip:~/mint-bot
```
Or `git clone` if you push it to a **private** repo first — never a public one, since `.env` and `wallets.json` hold real keys. Add both to `.gitignore` regardless.

## 4. Install deps on the VPS
```bash
cd ~/mint-bot
npm install
```

## 5. Set up real config on the VPS
```bash
cp .env.mainnet.example .env
nano .env          # fill in real RPC URLs + contract addresses
nano wallets.json   # fill in real private keys
```

## 6. Lock down file permissions
```bash
chmod 600 .env wallets.json
```
Only your user can read these — reduces exposure if the VPS is ever compromised.

## 7. Dry run first
Before mint day, do a connectivity test — point `.env`'s contract address
at your **testnet** deployment temporarily, or just run with a chain
commented out of `CHAINS_TO_RUN` to confirm no errors before going live.

## 8. Run it live (foreground, for a one-shot mint)
```bash
node mint-mainnet.js
```
Since this is a single mint-moment script (not a long-running service like
your tracker bot), you likely don't need PM2 for this one — just run it
directly at the right time. If you want it to auto-restart on crash while
you wait for mint time, you can still use PM2:
```bash
pm2 start mint-mainnet.js --name mint-bot --no-autorestart
pm2 logs mint-bot
```

## Why VPS over your own laptop
Lower, more consistent latency to Alchemy's servers (VPS is likely in a
proper datacenter region, unlike home broadband/wifi), and it stays online
even if your laptop sleeps or loses connection — both matter for shaving
milliseconds at mint time.
