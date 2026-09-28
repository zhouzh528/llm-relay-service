# 应用层 HTTPS（私有 CA）使用指南

本文档介绍如何在 **没有公网域名、仅通过固定 IP 暴露服务** 的部署环境下，直接由应用层开启 HTTPS。启用后服务会自动生成一套 **私有 CA + server 证书**，管理员在后台下载根 CA 分发给各客户端导入系统信任库。

---

## 适用场景

- 部署在 **固定公网/内网 IP** 上，没有公网域名，无法使用 Let's Encrypt 等公共 CA
- 希望在服务进程本身完成 TLS 终结，**不想再挂一层反向代理**
- 客户端可控，能够接受 **一次性分发根 CA 证书**

> ⚠️ 如果前面已经有 Nginx/Caddy/NPM 做 TLS 终结——**不要**同时启用本方案，两者互斥。应用层 HTTPS 与 `TRUST_PROXY=true` 并存时会打印警告。

---

## 工作原理

```
首次启动
  └─► certificateManager.generateCa()   生成根 CA（10 年有效期）
  └─► certificateManager.generateServerCert()  用 CA 签发 server 证书（含 SAN，5 年）
  └─► 写入 data/certs/（0700 目录，0600 私钥）
  └─► https.createServer(tlsOptions, app).listen(HTTPS_PORT)

客户端访问
  客户端 ──https──► Relay Service
    ▲
    └── 预先导入 ca.crt 到系统信任库 / SDK 环境变量
```

---

## 第一步：启用 HTTPS

### 1. 修改 `.env`

```env
# 必填
HTTPS_ENABLED=true
HTTPS_SAN=IP:203.0.113.10,DNS:localhost,IP:127.0.0.1

# 可选（默认值如下）
HTTPS_PORT=3443
HTTPS_CERT_DIR=./data/certs
HTTPS_CERT_VALID_DAYS=1825         # server 证书 5 年
HTTPS_CA_VALID_DAYS=3650           # 根 CA 10 年
HTTPS_MIN_TLS_VERSION=TLSv1.2      # 或 TLSv1.3
HTTPS_KEY_BITS=2048                # 或 4096
HTTPS_HSTS_ENABLED=false           # 私有 CA 场景下建议保持 false
```

**`HTTPS_SAN` 必须填**。格式为逗号分隔的 `IP:<addr>` / `DNS:<name>`，启动时解析失败会 fail-fast：

```
HTTPS_SAN=IP:203.0.113.10,DNS:relay.internal,IP:127.0.0.1
```

### 2. 重启服务

```bash
npm start
```

首次启动日志示例：

```
[https] 正在生成根 CA ...
[https] 根 CA 已写入 data/certs/ca.crt
[https] 正在生成 server 证书 ...
[https] server 证书已写入 data/certs/server.crt
[https] HTTPS 监听 https://0.0.0.0:3443
```

### 3. 下载根 CA

登录管理后台 → **系统设置 → HTTPS 状态** → 点击"下载 ca.crt"。

> 🔒 `ca.key` 永远不会通过任何接口对外返回——下载路径在代码中硬编码为 `ca.crt`，并有回归测试守护。

---

## 第二步：分发根 CA 到客户端

### 系统级信任（浏览器自动识别）

| 系统 | 操作 |
|------|------|
| **macOS** | 双击 `ca.crt` → 导入钥匙串 → 打开"钥匙串访问" → 找到 `Relay Service CA` → 双击 → 信任 → "使用此证书时" 选 **始终信任** |
| **Windows** | 双击 `ca.crt` → 安装证书 → 本地计算机 → 将所有证书放入下列存储区 → **受信任的根证书颁发机构** |
| **Linux (Debian/Ubuntu)** | `sudo cp ca.crt /usr/local/share/ca-certificates/relay-ca.crt && sudo update-ca-certificates` |
| **Linux (RHEL/CentOS)** | `sudo cp ca.crt /etc/pki/ca-trust/source/anchors/relay-ca.crt && sudo update-ca-trust` |

### SDK 级信任（不读系统 store 的语言/运行时）

Node、Python、Java 等语言默认 **不读系统信任库**，必须额外设置环境变量：

| 语言 | 环境变量 |
|------|----------|
| **Node.js** | `NODE_EXTRA_CA_CERTS=/path/to/ca.crt` |
| **Python (requests / httpx)** | `REQUESTS_CA_BUNDLE=/path/to/ca.crt` |
| **Python (urllib / ssl)** | `SSL_CERT_FILE=/path/to/ca.crt` |
| **curl** | `curl --cacert /path/to/ca.crt https://...` 或 `CURL_CA_BUNDLE=...` |
| **Java** | `keytool -import -trustcacerts -keystore $JAVA_HOME/lib/security/cacerts -alias relay-ca -file ca.crt` |

---

## 第三步：客户端访问

```bash
# 命令行验证
curl --cacert ca.crt https://203.0.113.10:3443/health

# Claude Code CLI 使用本服务
export ANTHROPIC_BASE_URL=https://203.0.113.10:3443
export ANTHROPIC_API_KEY=cr_xxxxx
export NODE_EXTRA_CA_CERTS=/path/to/ca.crt
claude --print "hi"
```

---

## 运维操作

### 查看证书状态

管理后台 → 系统设置 → **HTTPS 状态**，只读面板展示：

- 启用状态 / 监听端口
- SAN 列表
- Subject / Issuer
- 证书有效期、剩余天数（**< 30 天** 变琥珀色告警）
- CA 剩余天数（**< 90 天** 变琥珀色告警）

### 新增客户端 IP / 修改 SAN

```bash
# 1. 修改 .env
HTTPS_SAN=IP:203.0.113.10,IP:203.0.113.11,DNS:localhost,IP:127.0.0.1

# 2. 删除旧 server 证书（CA 保留，客户端无需重新导入）
rm data/certs/server.crt data/certs/server.key

# 3. 重启
npm start
```

### 证书损坏恢复

日志定位具体损坏文件（`data/certs/*.crt/.key`），删除后重启会自动重新签发：

- 删 `server.*` → 保留 CA，仅重签 server（客户端无需换信任）
- 删 `ca.*` + `server.*` → 完全重建（**所有客户端需重新导入新 ca.crt**）

### 回滚到 HTTP

```env
HTTPS_ENABLED=false
```

重启后恢复监听 `PORT`（默认 13000）。

---

## 环境变量速查

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HTTPS_ENABLED` | `false` | 总开关 |
| `HTTPS_PORT` | `3443` | 监听端口 |
| `HTTPS_SAN` | *（空）* | **必填**。`IP:x.x.x.x,DNS:name` 逗号分隔 |
| `HTTPS_CERT_DIR` | `./data/certs` | 证书存放目录 |
| `HTTPS_CERT_VALID_DAYS` | `1825` | server 证书有效天数（5 年） |
| `HTTPS_CA_VALID_DAYS` | `3650` | CA 有效天数（10 年） |
| `HTTPS_MIN_TLS_VERSION` | `TLSv1.2` | 最低 TLS 版本 |
| `HTTPS_KEY_BITS` | `2048` | RSA 密钥位数 |
| `HTTPS_HSTS_ENABLED` | `false` | 是否注入 HSTS（私有 CA 下谨慎启用） |

---

## 安全注意事项

- **`ca.key` 绝不能泄漏**——它是整条私有信任链的根，泄漏等同攻击者可对任意域名签发可信证书
  - 代码层：管理后台只允许下载 `ca.crt`，路径硬编码 + 回归测试守护
  - 文件系统层：`data/certs/` 权限 `0700`，`.key` 文件权限 `0600`
  - 部署层：`.gitignore` 已加入 `data/certs/`
- **不要同时启用 `HTTPS_ENABLED=true` 和 `TRUST_PROXY=true`**——两者代表的部署形态通常互斥，启动会打印警告
- **HSTS 谨慎启用**：私有 CA 场景下一旦客户端缓存 HSTS，服务中断时无法降级到 HTTP 访问
- **切换 HTTP ↔ HTTPS 后**，已授权的 OAuth 账号（Claude / Gemini / Antigravity 等）回调 URL 可能需要重新绑定

---

## 常见错误

| 错误 | 原因 | 处理 |
|------|------|------|
| `HTTPS_SAN is required` | `HTTPS_SAN` 为空 | 填写后重启 |
| `EACCES: permission denied 0.0.0.0:443` | 容器内绑定 <1024 端口 | 用 3443，或加 `CAP_NET_BIND_SERVICE` |
| `EADDRINUSE` | 端口冲突 | 改 `HTTPS_PORT` 或释放占用进程 |
| `InvalidPemError` | 证书文件损坏 | 删除损坏文件后重启自动重签 |
| 客户端 `SELF_SIGNED_CERT_IN_CHAIN` | 未导入 / SDK 未指向 ca.crt | 设置 `NODE_EXTRA_CA_CERTS` 等 |
| 客户端 `ERR_CERT_COMMON_NAME_INVALID` | 访问 IP 不在 SAN | 追加到 `HTTPS_SAN` → 删 server.* → 重启 |
