# Relay Service

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/Redis-6+-red.svg)](https://redis.io/)

**🔐 Self-hosted Claude API relay service with multi-account management**

[中文文档](README.md)

</div>

> Released under the **MIT License**. Derived from the upstream project [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) at **v1.1.300**.
> The original copyright notice is retained in [LICENSE](LICENSE).

---

## ⚠️ Important Notice

**Please read carefully before using this project:**

🚨 **Terms of Service Risk**: Using this project may violate Anthropic's terms of service. Please carefully read Anthropic's user agreement before use. All risks from using this project are borne by the user.

📖 **Disclaimer**: This project is for technical learning and research purposes only. The author is not responsible for any account bans, service interruptions, or other losses caused by using this project.

## 🤔 Is This Project Right for You?

- 🌍 **Regional Restrictions**: Can't directly access Claude Code service in your region?
- 🔒 **Privacy Concerns**: Worried about third-party mirror services logging or leaking your conversation content?
- 👥 **Cost Sharing**: Want to share Claude Code Max subscription costs with friends?
- ⚡ **Stability Issues**: Third-party mirror sites often fail and are unstable, affecting efficiency?

If you have any of these concerns, this project might be suitable for you.

### Suitable Scenarios

✅ **Cost Sharing with Friends**: 3-5 friends sharing Claude Code Max subscription, enjoying Opus freely  
✅ **Privacy Sensitive**: Don't want third-party mirrors to see your conversation content  
✅ **Technical Tinkering**: Have basic technical skills, willing to build and maintain yourself  
✅ **Stability Needs**: Need long-term stable Claude access, don't want to be restricted by mirror sites  
✅ **Regional Restrictions**: Cannot directly access Claude official service  

### Unsuitable Scenarios

❌ **Complete Beginner**: Don't understand technology at all, don't even know how to buy a server  
❌ **Occasional Use**: Use it only a few times a month, not worth the hassle  
❌ **Registration Issues**: Cannot register Claude account yourself  
❌ **Payment Issues**: No payment method to subscribe to Claude Code  

**If you're just an ordinary user with low privacy requirements, just want to casually play around and quickly experience Claude, then choosing a mirror site you're familiar with would be more suitable.**

---

## 💭 Why Build Your Own?

### Potential Issues with Existing Mirror Sites

- 🕵️ **Privacy Risk**: Your conversation content is completely visible to others, forget about business secrets
- 🐌 **Performance Instability**: Slow when many people use it, often crashes during peak hours
- 💰 **Price Opacity**: Don't know the actual costs

### Benefits of Self-hosting

- 🔐 **Data Security**: All API requests only go through your own server, direct connection to Anthropic API
- ⚡ **Controllable Performance**: Only a few of you using it, Max $200 package basically allows you to enjoy Opus freely
- 💰 **Cost Transparency**: Clear view of how many tokens used, specific costs calculated at official prices
- 📊 **Complete Monitoring**: Usage statistics, cost analysis, performance monitoring all available

---

## 🚀 Core Features

> 📸 **[Click to view interface preview](docs/preview.md)** - See detailed screenshots of the Web management interface

### Basic Features
- ✅ **Multi-account Management**: Add multiple Claude accounts for automatic rotation
- ✅ **Custom API Keys**: Assign independent keys to each person
- ✅ **Usage Statistics**: Detailed records of how many tokens each person used

### Advanced Features
- 🔄 **Smart Switching**: Automatically switch to next account when one has issues
- 🚀 **Performance Optimization**: Connection pooling, caching to reduce latency
- 📊 **Monitoring Dashboard**: Web interface to view all data
- 🛡️ **Security Control**: Access restrictions, rate limiting
- 🌐 **Proxy Support**: Support for HTTP/SOCKS5 proxies

---

## 🖼️ Interface Preview

> All account names, usage and cost figures below are demo data.

### Real-time Observability · Dashboard

Token usage and cost captured live from streaming responses; the dashboard refreshes by the second.

![Dashboard](web/admin-spa/public/screenshots/dashboard.jpg)

### Fine-grained Metering · API Keys

Issue a dedicated key per person; cost, usage and last-used time are all itemised.

![API Keys](web/admin-spa/public/screenshots/api-keys.jpg)

### Smart Scheduling · Accounts

Claude, Gemini, OpenAI and more managed in one place, with session windows at a glance.

![Accounts](web/admin-spa/public/screenshots/accounts.jpg)

---

## 📋 Deployment Requirements

### Hardware Requirements (Minimum Configuration)
- **CPU**: 1 core is sufficient
- **Memory**: 512MB (1GB recommended)
- **Storage**: 30GB available space
- **Network**: Access to Anthropic API (recommend US region servers)
- **Recommendation**: 2 cores 4GB is basically enough, choose network with good return routes to your country (to improve speed, recommend not using proxy or setting server IP for direct connection)

### Software Requirements
- **Node.js** 18 or higher
- **Redis** 6 or higher
- **Operating System**: Linux recommended

### Cost Estimation
- **Server**: Light cloud server, $5-10 per month
- **Claude Subscription**: Depends on how you share costs
- **Others**: Domain name (optional)

---

## ⚡ One-Click Install (Recommended)

An `install.sh` script is provided at the repo root for **Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / Alibaba Cloud Linux**. It installs Node.js 20 + Redis, clones the repo, builds the frontend SPA, generates `.env`, writes the systemd unit, and starts the service.

### One-liner

```bash
curl -fsSL https://raw.githubusercontent.com/zhouzh528/llm-relay-service/main/install.sh | sudo bash
```

Or download first (to review / pass custom args):

```bash
curl -fsSL https://raw.githubusercontent.com/zhouzh528/llm-relay-service/main/install.sh -o install.sh
sudo bash install.sh                          # default: /opt/relay-service, app port 13000, Nginx public 8080 / admin 28080
sudo bash install.sh /opt/relay-service 8080  # custom install dir & port
```

### Interactive vs non-interactive

- **Interactive TTY**: prompts for the app listen port, the Nginx public/admin ports, admin username/password (≥8 chars with digit/letter/special), and Redis mode (existing instance / new dedicated instance). Blank = auto-generate.
- **Non-interactive** (e.g. piped): defaults to launching a new local-only Redis instance (random password, port auto-picked from 6380) and generates random admin credentials. Check `data/init.json` after install.

### After install

```bash
systemctl status relay-service     # status
systemctl restart relay-service    # restart
journalctl -u relay-service -f     # live logs
cat /opt/relay-service/data/init.json  # initial admin credentials
```

Admin panel: `http://<server-ip>:<port>/admin-next/`

### Upgrade

The installer checks out the latest release tag (`vX.Y.Z`). After that, upgrading from the admin panel is recommended: account menu → **检查更新 (Check for updates)**, review the changelog, then click upgrade. The server fetches the target tag, installs dependencies / rebuilds the web UI only when needed, and exits so systemd restarts it with the new code; if any step fails it rolls back and keeps running the old version.

> Only `vX.Y.Z` tags pushed to the repository are recognized as new releases — untagged commits on `main` never trigger an upgrade prompt, and prerelease tags such as `-rc` are not prompted by default.

Manual upgrade (replace `<vX.Y.Z>` with the target version):

```bash
cd /opt/relay-service
git fetch --tags origin
git checkout --detach refs/tags/<vX.Y.Z>
npm install --omit=dev
npm run build:web
systemctl restart relay-service
```

### Re-running `install.sh` (important)

Re-running is safe:
- `JWT_SECRET` / `ENCRYPTION_KEY` are **preserved** (regenerating would invalidate all sessions and AES-encrypted records).
- Redis host/port/password are synced back into `.env` on every run (`setup_redis_new` regenerates the Redis password and rewrites `redis.conf` each time; the sync step prevents drift between the two).
- Stale systemd units are disabled and replaced to avoid `Restart=always` leftovers interfering.

### When install fails

Frontend build failures (lint/prettier) are the most common case. The script captures the full `npm run install:web && npm run build:web` output to `/tmp/relay-install-build.XXXXXX.log` and, on failure, dumps the last 60 lines to stderr along with the exact fix command.

For full manual control, see "📦 Manual Deployment" below.

---

## 📦 Manual Deployment

### Step 1: Environment Setup

**Ubuntu/Debian users:**
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Redis
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
```

**CentOS/RHEL users:**
```bash
# Install Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Install Redis
sudo yum install redis
sudo systemctl start redis
```

### Step 2: Download and Configure

```bash
# Download project
git clone https://github.com/zhouzh528/llm-relay-service.git
cd llm-relay-service

# Install dependencies
npm install

# Copy configuration files (Important!)
cp config/config.example.js config/config.js
cp .env.example .env
```

### Step 3: Configuration File Setup

**Edit `.env` file:**
```bash
# Generate these two keys randomly, but remember them
JWT_SECRET=your-super-secret-key
ENCRYPTION_KEY=32-character-encryption-key-write-randomly

# Redis configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

**Edit `config/config.js` file:**
```javascript
module.exports = {
  server: {
    port: 13000,         // App listen port (loopback only by default; Nginx fronts it)
    host: '0.0.0.0'     // Don't change
  },
  redis: {
    host: '127.0.0.1',  // Redis address
    port: 6379          // Redis port
  },
  // Keep other configurations as default
}
```

### Step 4: Start Service

```bash
# Initialize
npm run setup # Will randomly generate admin account password info, stored in data/init.json

# Start service
npm run service:start:daemon   # Run in background (recommended)

# Check status
npm run service:status
```

### Service Management Commands

Manage the service process via `scripts/manage.js` (PID + nohup, cross-platform):

```bash
npm run service:start:daemon   # Start (background; terminal can be closed safely)
npm run service:stop           # Stop (graceful; force-kills after timeout)
npm run service:restart        # Restart (reloads latest config)
npm run service:update         # Update (git pull → install deps → build web → auto restart in background)
npm run service:status         # Show status
npm run service:logs           # View logs
```

> Metadata is persisted to **SQLite** by default (`data/metadata.db`); Redis is used only as cache + hot state, and only single-instance deployment is supported. To keep metadata in Redis, set `METADATA_BACKEND=redis` in `.env`. To migrate existing Redis data to SQLite, see `docs/metadata-storage-guide`.

---

## 🎮 Getting Started

### 1. Open Management Interface

Browser visit: `http://your-server-IP:28080/admin-next/`

Default admin account: Look in data/init.json

### 2. Add Claude Account

This step is quite important, requires OAuth authorization:

1. Click "Claude Accounts" tab
2. If you're worried about multiple accounts sharing 1 IP getting banned, you can optionally set a static proxy IP
3. Click "Add Account"
4. Click "Generate Authorization Link", will open a new page
5. Complete Claude login and authorization in the new page
6. Copy the returned Authorization Code
7. Paste to page to complete addition

**Note**: If you're in China, this step may require VPN.

### 2.1 Temporary Pause (503/5xx) and Account-Level TTL Overrides

When upstream errors happen, the router can temporarily pause an account. Global defaults are controlled by `.env.example`:

- `UPSTREAM_ERROR_503_TTL_SECONDS`
- `UPSTREAM_ERROR_5XX_TTL_SECONDS`
- `UPSTREAM_ERROR_OVERLOAD_TTL_SECONDS`
- `UPSTREAM_ERROR_AUTH_TTL_SECONDS`
- `UPSTREAM_ERROR_TIMEOUT_TTL_SECONDS`

For **Claude official OAuth accounts**, you can override policy per account in Admin UI:

- `Disable temporary cooldown for this account`: skip 503/5xx temp pause for this account
- `503 cooldown seconds`: empty = follow global default, `0` = disable 503 cooldown for this account
- `5xx cooldown seconds`: empty = follow global default, `0` = disable 5xx cooldown for this account

Priority order (high to low):

1. Account-level "disable temporary cooldown"
2. Account-level 503/5xx cooldown override
3. Call-site custom TTL (if provided)
4. Global env default TTL

In Accounts view, "Routing blocked reason" shows error type, HTTP status, total cooldown, remaining time, and recovery time. Use `Reset Status` to clear abnormal state and restore routing eligibility.

### 3. Create API Key

Assign a key to each user:

1. Click "API Keys" tab
2. Click "Create New Key"
3. Give the key a name, like "Zhang San's Key"
4. Set usage limits (optional)
5. Save, note down the generated key

### 4. Start Using Claude Code and Gemini CLI

Now you can replace the official API with your own service:

**Claude Code Set Environment Variables:**

Default uses standard Claude account pool:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080/api/" # Fill in your server's IP address or domain
export ANTHROPIC_AUTH_TOKEN="API key created in the backend"
```

**VSCode Claude Plugin Configuration:**

If using VSCode Claude plugin, configure in `~/.claude/config.json`:

```json
{
    "primaryApiKey": "crs"
}
```

If the file doesn't exist, create it manually. Windows users path is `C:\Users\YourUsername\.claude\config.json`.

**Gemini CLI Set Environment Variables:**

**Method 1 (Recommended): Via Gemini Assist API**

Each account enjoys 1000 requests per day, 60 requests per minute free quota.

```bash
CODE_ASSIST_ENDPOINT="http://127.0.0.1:8080/gemini"  # Fill in your server's IP address or domain
GOOGLE_CLOUD_ACCESS_TOKEN="API key created in the backend"
GOOGLE_GENAI_USE_GCA="true"
GEMINI_MODEL="gemini-2.5-pro"
```

> **Note**: gemini-cli console will show `Failed to fetch user info: 401 Unauthorized`, but this doesn't affect usage.

**Method 2: Via Gemini API**

Very limited free quota, easily triggers 429 errors.

```bash
GOOGLE_GEMINI_BASE_URL="http://127.0.0.1:8080/gemini"  # Fill in your server's IP address or domain
GEMINI_API_KEY="API key created in the backend"
GEMINI_MODEL="gemini-2.5-pro"
```

**Use Claude Code:**

```bash
claude
```

**Use Gemini CLI:**

```bash
gemini
```

---

## 🔧 Daily Maintenance

### Service Management

```bash
# Check service status
npm run service:status

# View logs
npm run service:logs

# Restart service
npm run service:restart:daemon

# Stop service
npm run service:stop
```

### Monitor Usage

- **Web Interface**: `http://your-domain:28080/admin-next/` - View usage statistics
- **Health Check**: `http://your-domain:8080/health` - Confirm service is normal
- **Log Files**: Various log files in `logs/` directory

### Upgrade Guide

When a new version is released, follow these steps to upgrade the service:

```bash
# 1. Navigate to project directory
cd llm-relay-service

# 2. Pull latest code
git pull origin main

# If you encounter package-lock.json conflicts, use the remote version
git checkout --theirs package-lock.json
git add package-lock.json

# 3. Install new dependencies (if any)
npm install

# 4. Restart service
npm run service:restart:daemon

# 5. Check service status
npm run service:status
```

**Important Notes:**
- Before upgrading, it's recommended to backup important configuration files (.env, config/config.js)
- Check the changelog to understand if there are any breaking changes
- Database structure changes will be migrated automatically if needed

### Common Issue Resolution

**Can't connect to Redis?**
```bash
# Check if Redis is running
redis-cli ping

# Should return PONG
```

**OAuth authorization failed?**
- Check if proxy settings are correct
- Ensure normal access to claude.ai
- Clear browser cache and retry

**API request failed?**
- Check if API Key is correct
- View log files for error information
- Confirm Claude account status is normal

---

## 🛠️ Advanced Usage

### Application-Layer HTTPS (Private CA, for internal/fixed-IP deployments)

If your deployment has **no public domain** (e.g. exposed only over a fixed public IP to an internal team), you can enable HTTPS directly at the application layer. Once enabled, the service auto-generates a **private CA + server certificate**; administrators download the root CA from the admin panel and distribute it to each client's system trust store.

**Minimum enablement steps:**

1. Add to `.env`:
   ```env
   HTTPS_ENABLED=true
   HTTPS_SAN=IP:<your-public-ip>,DNS:localhost,IP:127.0.0.1
   ```
2. Restart the service (the first boot auto-generates CA + server cert; logs show generation time and file paths)
3. Log into the admin panel → System Settings → **HTTPS Status** → download `ca.crt`
4. Distribute `ca.crt` to each client:
   - **macOS**: double-click to import to Keychain → Always Trust
   - **Windows**: `certmgr.msc` → Trusted Root Certification Authorities → Import
   - **Linux**: `sudo cp ca.crt /usr/local/share/ca-certificates/relay-ca.crt && sudo update-ca-certificates`
5. SDKs that don't consult the system trust store need explicit env vars:
   - **Node**: `NODE_EXTRA_CA_CERTS=/path/to/ca.crt`
   - **Python requests/httpx**: `REQUESTS_CA_BUNDLE=/path/to/ca.crt`
6. Switch client base URL to `https://<IP>:3443` (or whatever host port is mapped to 3443)

**SAN changes** (adding a new client IP): update `HTTPS_SAN` → delete `data/certs/server.*` → restart. The CA is preserved, so clients that already trust it need no re-import.
**Rollback**: `HTTPS_ENABLED=false` + restart; the service reverts to HTTP.

> ⚠️ **Important notes:**
>
> - If you already have a reverse proxy (Nginx/Caddy) doing TLS termination, **do not** enable application-layer HTTPS at the same time — that typically indicates a misconfiguration. See the "Reverse Proxy Deployment Guide" below.
> - **`ca.key` is never exposed through any admin endpoint**; only `ca.crt` (the public certificate) can be downloaded. Guard `data/certs/ca.key` carefully — a leak compromises the entire private trust chain.
> - After switching between HTTP and HTTPS, previously configured OAuth accounts (Claude / Gemini / Antigravity, etc.) may need their callback URLs rebound in Account Management if they were set up under the old scheme.

---

### Reverse Proxy Deployment Guide

For production environments, it is recommended to use a reverse proxy for automatic HTTPS, security headers, and performance optimization. Two common solutions are provided below: **Caddy** and **Nginx Proxy Manager (NPM)**.

---

## Caddy Solution

Caddy is a web server that automatically manages HTTPS certificates, with simple configuration and excellent performance, ideal for deployments that want zero extra dependencies.

**1. Install Caddy**

```bash
# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy

# CentOS/RHEL/Fedora
sudo yum install yum-plugin-copr
sudo yum copr enable @caddy/caddy
sudo yum install caddy
```

**2. Caddy Configuration**

Edit `/etc/caddy/Caddyfile`:

```caddy
your-domain.com {
    # Reverse proxy to local service
    reverse_proxy 127.0.0.1:13000 {
        # Support streaming responses or SSE
        flush_interval -1

        # Pass real IP
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}

        # Long read/write timeout configuration
        transport http {
            read_timeout 300s
            write_timeout 300s
            dial_timeout 30s
        }
    }

    # Security headers
    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        -Server
    }
}
```

**3. Start Caddy**

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl start caddy
sudo systemctl enable caddy
sudo systemctl status caddy
```

**4. Service Configuration**

Since Caddy automatically manages HTTPS, you can restrict the service to listen locally only:

```javascript
// config/config.js
module.exports = {
  server: {
    port: 13000,
    host: '127.0.0.1' // Listen locally only
  }
}
```

**Caddy Features**

* 🔒 Automatic HTTPS with zero-configuration certificate management
* 🛡️ Secure default configuration with modern TLS suites
* ⚡ HTTP/2 and streaming support
* 🔧 Concise configuration files, easy to maintain

---

## Nginx Proxy Manager (NPM) Solution

Nginx Proxy Manager manages reverse proxies and HTTPS certificates through a graphical interface, deployed as a Docker container.

> Note: with the default `HOST=127.0.0.1` the app only listens on the host loopback, so a containerized NPM cannot reach it.
> Either set `HOST=0.0.0.0` (this also exposes the admin panel — restrict it with a firewall/security group),
> or run NPM with host networking. Using the built-in Nginx option above is recommended.

**1. Create a New Proxy Host in NPM**

Configure the Details as follows:

| Item                  | Setting                  |
| --------------------- | ------------------------ |
| Domain Names          | relay.example.com        |
| Scheme                | http                     |
| Forward Hostname / IP | 192.168.0.1 (docker host IP) |
| Forward Port          | 13000                    |
| Block Common Exploits | ☑️                       |
| Websockets Support    | ❌ **Disable**            |
| Cache Assets          | ❌ **Disable**            |
| Access List           | Publicly Accessible      |

> Note:
> - Ensure Relay Service **listens on `0.0.0.0`, container IP, or host IP** to allow NPM internal network connections.
> - **Websockets Support and Cache Assets must be disabled**, otherwise SSE / streaming responses will fail.

**2. Custom locations**

No content needed, keep it empty.

**3. SSL Settings**

* **SSL Certificate**: Request a new SSL Certificate (Let's Encrypt) or existing certificate
* ☑️ **Force SSL**
* ☑️ **HTTP/2 Support**
* ☑️ **HSTS Enabled**
* ☑️ **HSTS Subdomains**

**4. Advanced Configuration**

Add the following to Custom Nginx Configuration:

```nginx
# Pass real user IP
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

# Support WebSocket / SSE streaming
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_buffering off;

# Long connection / timeout settings (for AI chat streaming)
proxy_read_timeout 300s;
proxy_send_timeout 300s;
proxy_connect_timeout 30s;

# ---- Security Settings ----
# Strict HTTPS policy (HSTS)
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

# Block clickjacking and content sniffing
add_header X-Frame-Options "DENY" always;
add_header X-Content-Type-Options "nosniff" always;

# Referrer / Permissions restriction policies
add_header Referrer-Policy "no-referrer-when-downgrade" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

# Hide server information (equivalent to Caddy's `-Server`)
proxy_hide_header Server;

# ---- Performance Tuning ----
# Disable proxy caching for real-time responses (SSE / Streaming)
proxy_cache_bypass $http_upgrade;
proxy_no_cache $http_upgrade;
proxy_request_buffering off;
```

**5. Launch and Verify**

* After saving, wait for NPM to automatically request Let's Encrypt certificate (if applicable).
* Check Proxy Host status in Dashboard to ensure it shows "Online".
* Visit `https://relay.example.com`, if the green lock icon appears, HTTPS is working properly.

**NPM Features**

* 🔒 Automatic certificate application and renewal
* 🔧 Graphical interface for easy multi-service management
* ⚡ Native HTTP/2 / HTTPS support

---

All the options above are suitable for production deployment.

---

## 💡 Usage Recommendations

### Account Management
- **Regular Checks**: Check account status weekly, handle exceptions promptly
- **Reasonable Allocation**: Can assign different API keys to different people, analyze usage based on different API keys

### Security Recommendations
- **Use HTTPS**: Strongly recommend using Caddy reverse proxy (automatic HTTPS) to ensure secure data transmission
- **Regular Backups**: Back up important configurations and data
- **Monitor Logs**: Regularly check exception logs
- **Update Keys**: Regularly change JWT and encryption keys
- **Firewall Settings**: Only open necessary ports (80, 443), hide direct service ports

---

## 🆘 What to Do When You Encounter Problems?

### Self-troubleshooting
1. **Check Logs**: Log files in `logs/` directory
2. **Check Configuration**: Confirm configuration files are set correctly
3. **Test Connectivity**: Use curl to test if API is normal
4. **Restart Service**: Sometimes restarting fixes it

### Seeking Help
- **GitHub Issues**: Submit detailed error information
- **Read Documentation**: Carefully read error messages and documentation
- **Community Discussion**: See if others have encountered similar problems

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).

### Attribution

This repository is a fork of [Wei-Shaw/claude-relay-service](https://github.com/Wei-Shaw/claude-relay-service) at **v1.1.300**, redistributed under the MIT License.
The original copyright notice `Copyright (c) 2025 Wesley Liddick` and full MIT license text are retained in the [LICENSE](LICENSE) file.

---

<div align="center">

**🤝 Feel free to submit Issues for problems, welcome PRs for improvement suggestions**

</div>
