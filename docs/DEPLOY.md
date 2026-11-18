# 部署说明（Windows 本机 + frp 穿透）

## 1. 真实拓扑

```
访客浏览器 ──► http://<frp 公网域名>:<公网端口>
                     │  (frps，公网服务器)
                     │  frp tcp 隧道
                     ▼
              frpc.exe（本机）
                     │  127.0.0.1:28471
                     ▼
        EasyBrowse（Node 服务，本机）
                     │  启动 Chrome（每用户独立 profile）
                     ▼
        本机网络（v2rayN / Clash / sing-box 决定出口）
```

要点：

- **代理不归平台管**。远端 Chrome 不传 `--proxy-server`，直接使用 Windows 的网络设置；你的 VPN 客户端无论是「系统代理」还是「TUN 模式」，Chrome 都跟着走。
- **平台端口刻意不用 8080**，默认 `28471`；对外只暴露 frp 上的那一个公网端口。
- frp 只做 TCP 透传，**不解析 HTTP**，所以 WebSocket（画面通道）天然可用。

## 2. 本机准备

1. Node.js ≥ 22.5（`node -v` 确认）。
2. Chrome 已安装；非默认路径时在 `.env` 里写 `CHROME_PATH=`。
3. 需要走代理出网时，正常开你的 v2rayN / Clash 即可，不用额外配置。

## 3. 启动服务

```bat
cd /d C:\Users\Administrator\WorkBuddy\easyvpn
npm install
npm start
```

或双击 `start-easybrowse.bat`（完整平台）/ `start-nowapi.bat`（只开放 `/nowapi`）。控制台应打印：

```
EasyBrowse 已启动：http://localhost:28471
数据目录：...\easyvpn\data
浏览器内核：C:/Program Files/Google/Chrome/Application/chrome.exe
```

`.env` 最小示例：

```ini
PORT=28471
HOST=0.0.0.0
BEHIND_HTTPS=0
BLOCK_PRIVATE_NETWORK=1
CHROME_PROXY=
PUBLIC_URL=http://zjc.rainplay.cn:25578
```

### 启动方式

两个脚本二选一，双击即可（都自己设 `NOWAPI_ONLY`，优先级高于 `.env`）：

| 脚本 | 效果 |
| --- | --- |
| `start-nowapi.bat` | **只开放 `/nowapi`**，其余页面 / 接口 / WebSocket 一律 404，不启动远端浏览器（默认用法） |
| `start-easybrowse.bat` | 完整平台：登录、工作区、管理后台、远端浏览器 |

### 开机自启

已内置脚本：右键「使用 PowerShell 运行」`install-autostart.ps1`。它注册计划任务 `easybrowse-app`，登录 Windows 后以隐藏窗口启动服务，异常退出 1 分钟后自动重试。

```powershell
.\install-autostart.ps1               # 开启，开机模式 = nowapi（只起接口）
.\install-autostart.ps1 -Mode full    # 开启，开机模式 = 完整平台
.\install-autostart.ps1 -Off          # 关闭开机自启（不动正在跑的进程）
```

- **开机模式记在 `data\autostart-mode.txt`**（`nowapi` / `full`），由服务在启动时读取（`src/config.js` 的 `resolveNowapiOnly()`）。这样守护脚本里不用改 WSH 进程环境，保持纯 ASCII；
- 隐藏启动由 `start-hidden.vbs` 完成，Node 绝对路径写在里面（当前 `D:\Ccode\NODE\node-v24.12.0-win-x64\node.exe`），换机器只改这一行；
- 查看状态：`Get-ScheduledTask easybrowse-app | Get-ScheduledTaskInfo`；
- 服务日志：`data\server.log`，守护日志：`data\guardian.log`。

## 4. 配置 frp

frpc 配置文件（本机 `D:\Ccode\FrpWin\frp_0.65.0_windows_amd64\frpc-webproxy.toml`）：

```toml
serverAddr = "zjc.rainplay.cn"
serverPort = 52292

[auth]
method = "token"
token = "你的 token"

# remotePort 填「服务商面板里的内网端口」，不是用户访问的端口
# 本机实测：内网端口 25575 → 面板分配的公网地址 zjc.rainplay.cn:25578
[[proxies]]
name = "easybrowse"
type = "tcp"
localIP = "127.0.0.1"
localPort = 28471
remotePort = 25575
```

> ⚠️ **最容易踩的坑**：服务商面板给的是两列 ——「内网端口」和「映射公网地址」。`remotePort` 必须填**内网端口**（25575），用户访问的是**映射公网地址**（`zjc.rainplay.cn:25578`）。把内网端口当访问地址，表现就是「映射成功但连不上」。

启动：

```bat
frpc.exe -c frpc-webproxy.toml
```

日志出现下面两行即为成功：

```
login to server success, get run id [...]
[easybrowse] start proxy success
```

> **公网端口必须在 frp 服务商面板里已分配/放行**。`start proxy success` 只代表 frpc 把配置交给了 frps，不代表公网 IP 上真的能连上——如果外部访问超时，先查服务商面板的端口映射与服务器防火墙。

### 常见排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 外部访问超时，`52292` 能连 | 公网端口未分配 / 被防火墙丢包 | 在 frp 面板申请端口，或换一个已放行的 `remotePort` |
| 外部访问 502 `upstream connect failed` | 本机服务没起，或本地端口写错 | `netstat -ano | findstr 28471` 确认监听 |
| 页面能开，画面黑屏 | WebSocket 被中间设备拦 | 确认没有额外反代去掉了 `Upgrade` 头 |
| 登录后又跳回登录页 | Cookie `Secure` 与访问协议不匹配 | http 访问时 `BEHIND_HTTPS=0`，https 时改 1 |

## 5. 用户访问

把公网地址发给使用者即可：

```
http://zjc.rainplay.cn:25578/login
```

管理员账号在首次启动时创建；普通用户由管理员在 `管理后台 → 用户管理` 里新建。

## 6. HTTPS（三选一）

现状是 frp 的 **tcp 透传 + 纯 HTTP**，登录口令在公网是明文。要上 HTTPS：

### 方案 A：本机 TLS + 自有域名证书（推荐，改动最小）

1. 域名解析到 frp 公网 IP（或已在证书 SAN 内）。
2. 把证书放到本机，例如 `data/tls/fullchain.pem`、`data/tls/privkey.pem`。
3. `.env`：

   ```ini
   TLS_CERT=./data/tls/fullchain.pem
   TLS_KEY=./data/tls/privkey.pem
   TLS_PORT=28472
   BEHIND_HTTPS=1
   ```

4. frpc 再加一条映射：`localPort = 28472` → 另一个公网端口；
5. 用户访问 `https://域名:公网端口/`。

### 方案 B：VPS 上 Caddy 反代（推荐，能拿到免费证书）

在 frps 所在服务器上加站点，把流量反代到隧道端口：

```caddyfile
browse.example.com {
    # 25575 是 frps 侧内网端口（面板「内网端口」列），公网入口才是 25578
    reverse_proxy 127.0.0.1:25575 {
        header_up Host {host}
    }
}
```

Caddy 自动申请 Let's Encrypt 证书；用户访问 `https://browse.example.com`。此时 `.env` 设 `BEHIND_HTTPS=1`。

> Nginx 的等价配置见 `deploy/nginx.conf`，注意必须带 `Upgrade` / `Connection` 头与长超时。

### 方案 C：自签证书

能加密但不被浏览器信任，用户会看到「不安全」警告，只适合自己用。生成脚本见 `deploy/make-cert.ps1`。

## 7. 安全清单

- [x] 平台端口只监听本机，靠 frp 出公网
- [x] `BLOCK_PRIVATE_NETWORK=1`（远端浏览器无法访问 127.0.0.1 / 192.168.x.x / 云元数据）
- [x] 每个用户独立 profile，互不可见
- [x] 会话所有权后端校验，跨用户访问一律 404
- [x] 登录失败限速 + 锁定
- [ ] 强口令（管理员初始密码登录后立即改）
- [ ] 尽量上 HTTPS（见上一节）
- [ ] 定期在 `浏览数据` 页看占用，按需清理离职用户的数据
