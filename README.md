# Run PSN Price Watcher on DigitalOcean (cron)

No automatic deployment. You run the script on your droplet via cron: reads your Google Sheet via Apps Script, fetches PSN prices, and writes the results back.

---

## 1. One-time setup on the droplet

### 1.1 Install Node.js and Git

```bash
apt update && apt install -y git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # v20.x
```

### 1.2 Clone the repo

```bash
cd ~
git clone https://github.com/wilrikdeloose/psn-price-watcher.git
cd psn-price-watcher
npm ci
```

### 1.3 Environment file

```bash
cd ~/psn-price-watcher
cp .env.example .env
nano .env
```

Set:

- `APPS_SCRIPT_URL` – the Web App URL from your deployed Apps Script (see section below).

Save and exit. Do not commit `.env`.

---

## 2. Google Sheet + Apps Script setup

1. Open your Google Sheet.
2. Go to **Extensions → Apps Script**.
3. Replace the default code with the contents of `APPS_SCRIPT.js` from this repo.
4. Click **Deploy → New deployment → Web app**.
5. Set **Execute as: Me**, **Who has access: Anyone**.
6. Click **Deploy**, authorize when prompted, and copy the URL.
7. Paste the URL into `APPS_SCRIPT_URL` in your `.env`.

---

## 3. Cron job

Run the script on a schedule (e.g. daily at 06:00):

```bash
crontab -e
```

Add (adjust path and time as needed):

```cron
0 1 * * * cd /home/YOUR_USER/psn-price-watcher && node psn-prices.js
```

---

## 4. Manual run

```bash
cd ~/psn-price-watcher
git pull
node psn-prices.js
```

---

## 5. Sheet columns

The script expects a sheet with (at least) these **exact** header names:

- **Game** – the game title. If a cell has a hyperlink pointing to `store.playstation.com`, the script will fetch prices for that game. After fetching, the game name is updated with the official title (keeping the link).
- **Original Price**
- **Current Price**
- **Discount**

Only rows where the Game cell has a PSN store hyperlink are processed. Rows without a link are skipped.
