# Deploy to DigitalOcean Ubuntu

On every push to `main`, GitHub Actions SSHs into your DigitalOcean Ubuntu server and runs `git pull` + `npm ci` so the app is always up to date.

---

## 1. DigitalOcean

1. Create a **Droplet** (Ubuntu 22.04 or 24.04).
2. Choose a plan (Basic shared CPU is enough).
3. Add your SSH key (optional but recommended for your own access).
4. Note the **droplet IP** (e.g. `164.92.xxx.xxx`).

---

## 2. Ubuntu server setup

SSH into the server (from your PC):

```bash
ssh root@YOUR_DROPLET_IP
```

(Or use a non-root user if you created one.)

### 2.1 Install Node.js and Git

```bash
apt update && apt install -y git
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # should be v20.x
git --version
```

### 2.2 Create a deploy user (recommended)

Using a dedicated user keeps deployment isolated and avoids using `root`:

```bash
adduser deploy
usermod -aG sudo deploy
su - deploy
```

From here on, run the next steps as `deploy` (or as `root` if you skip this).

### 2.3 Generate an SSH key for GitHub Actions

This key will be used by GitHub to SSH into the server. Run **on the server**:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/github_actions -N ""
cat ~/.ssh/github_actions.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

- **Private key** (needed in GitHub Secrets in step 3):

  ```bash
  cat ~/.ssh/github_actions
  ```

  Copy the entire output (including `-----BEGIN ... KEY-----` and `-----END ... KEY-----`).

- **Public key** is already in `authorized_keys`, so this server will accept logins using that private key.

### 2.4 Clone the repo and set deploy path

Pick a directory where the app will live, e.g. `/home/deploy/psn-price-watcher`:

```bash
cd ~
git clone https://github.com/wilrikdeloose/psn-price-watcher.git
cd psn-price-watcher
npm ci
```

If the repo is **private**, clone via SSH and ensure this user can pull without a password:

```bash
# On server: add your GitHub deploy key to this user, then:
git clone git@github.com:wilrikdeloose/psn-price-watcher.git
cd psn-price-watcher
npm ci
```

Note the **full path** of the app directory. You can get it with:

```bash
pwd
# e.g. /home/deploy/psn-price-watcher
```

You will use this path as `DEPLOY_PATH` in GitHub Secrets.

---

## 3. GitHub Secrets

In your repo on GitHub:

1. Go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret** and add:

| Name              | Value                                                                 |
|-------------------|-----------------------------------------------------------------------|
| `SSH_HOST`        | Your droplet IP (e.g. `164.92.xxx.xxx`).                             |
| `SSH_USER`        | User that owns the repo (`deploy` or `root`).                        |
| `SSH_PRIVATE_KEY` | The **private** key you printed with `cat ~/.ssh/github_actions`.   |
| `DEPLOY_PATH`     | Full path to the app (e.g. `/home/deploy/psn-price-watcher`).       |

Optional:

| Name       | Value              |
|------------|--------------------|
| `SSH_PORT` | `22` (default). Use another port if you changed SSH. |

- Paste the private key as a single block (with the BEGIN/END lines and line breaks).
- Do **not** add the public key as a secret; it lives in `authorized_keys` on the server.

---

## 4. Trigger a deploy

- Push to `main` (or merge a PR into `main`).
- Open the **Actions** tab in the repo and check the “Deploy to DO” workflow.

If it fails, open the run and read the log (e.g. “Not a git repo”, “Permission denied”, or “npm ci failed”).

---

## 5. Running the app on the server

After deploy, the app is updated in `DEPLOY_PATH`. Run it manually when you want a report:

```bash
ssh deploy@YOUR_DROPLET_IP
cd /home/deploy/psn-price-watcher   # or your DEPLOY_PATH
node psn-prices.js list.csv
```

If you use a `list.csv` only on the server, put it in that directory (and optionally add `list.csv` to `.gitignore` so it isn’t committed). To run on a schedule (e.g. daily), add a cron job for the same command.

---

## Summary checklist

- [ ] DO droplet created (Ubuntu), IP noted  
- [ ] Node.js 20 and Git installed on the server  
- [ ] Deploy user created (optional)  
- [ ] SSH key pair generated on server, private key copied  
- [ ] Public key appended to `~/.ssh/authorized_keys`  
- [ ] Repo cloned in `DEPLOY_PATH`, `npm ci` run once  
- [ ] GitHub Secrets set: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `DEPLOY_PATH`  
- [ ] Push to `main` and verify the Actions deploy run succeeds  
