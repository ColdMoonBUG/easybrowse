# EasyBrowse · 多用户远程浏览器平台

> 用户在自己的浏览器里打开一个网页，获得一台**运行在你电脑上、数据独立且长期保留**的远程浏览器。
> 远端浏览器的出网流量直接跟随这台机器本身的网络（本机开着 v2rayN / Clash / sing-box 走代理，它就一起走代理），平台内不再配置任何代理节点。

本仓库按《多用户远程浏览器平台 · 产品需求说明书与技术设计草案 V1.0》实现的第一阶段（MVP）可运行版本，并按实际部署方式调整：**本机 Windows + Chrome + frp 穿透 + 用户用浏览器访问公网地址**。

---

## 1. 已实现能力

| 模块 | 能力 |
| --- | --- |
| 认证 | 用户名 + 密码登录、**自助注册**（`/register`，注册后自动登录）、scrypt 口令哈希、HttpOnly + SameSite Cookie、登录失败限速与锁定、错误提示不泄露账号是否存在 |
| 自助注册 | 登录页「没有账号？立即注册」进入注册页，只填用户名 + 密码即可开通；新号默认**流量不限（quota 0）、并发 2、有效期无限**，可在管理后台一键关闭入口 |
| 用户门户 | 远端画面实时渲染、地址栏导航、前进/后退/刷新、多标签页（新建/切换/关闭）、全屏、断线自动重连、刷新页面自动恢复会话 |
| 移动端 | iOS Safari / Android Chrome 触屏点击、滑动滚动；**控制栏常显不自动收起**（想全屏从「更多 → 收起/展开控制栏」手动收起，点顶部把手拉回）；**底部输入面板常驻**、不遮挡画面、支持中文输入法，点远端输入框自动聚焦并拉起本地键盘，键盘弹起时面板自动上移 |
| 会话管理 | 每用户独立浏览器进程与独立 profile；状态机 CREATING/RUNNING/DISCONNECTED/IDLE/STOPPED/ERROR；空闲断开画面、空闲停止进程；崩溃与重启后自动收敛孤儿会话 |
| **浏览数据保留** | Cookie、登录态、LocalStorage、IndexedDB、历史记录、书签、缓存、下载文件全部落在 `data/profiles/<用户ID>/`，**会话结束、服务重启都不会删除**，下次启动原样续上 |
| **网络出口** | 不传 `--proxy-server`，Chrome 直接使用本机网络（系统代理 / PAC / TUN 均可）；要临时固定出口时用环境变量 `CHROME_PROXY` 指定 |
| **内网防护** | 导航与文档级请求拦截回环、内网、链路本地、云元数据地址（`127.0.0.1` / `192.168.x.x` / `169.254.169.254` 等），防止公网用户借浏览器探测宿主机与内网 |
| **服务器端静音** | 浏览器跑在服务器上，声音本会从服务器音箱播出（别的用户看视频，管理员这边就响）。现统一静音：新实例带 `--mute-audio`，已在跑的实例按进程树在 Windows 音频会话层静音（含数据库里查不到的孤儿进程，按 profile 路径识别），每 5 分钟兜底巡检 |
| **各听各的声音** | 页面音频由注入钩子采集成 24kHz 单声道 PCM，只沿该用户自己的连接送回他的浏览器播放（WebAudio 排队，延迟约 100ms）。用户在顶栏点扬声器开启，服务器与管理端始终无声。覆盖页面 WebAudio、同源媒体与 MSE 流（B 站 / YouTube 这类主流视频站）；未声明 crossorigin 的跨域直链媒体受浏览器安全策略限制，声音拿不到 |
| 管理后台 | 仪表盘（在线用户、活动会话、今日/累计流量、主机 CPU/内存/磁盘）、用户 CRUD 与配额、强制结束会话、流量统计与 CSV 导出、审计日志、浏览数据占用查看与清理、系统配置 |
| 审计与计量 | 登录成功/失败/锁定、会话创建/恢复/结束、管理员操作、配额触发；互联网流量按用户/会话/日 汇总 |
| **/nowapi 节点查询** | 读本机 v2rayN 的本地库，返回**当前选中**的代理节点分享链接（`vless://…` 等），切节点即刻生效；默认纯文本，`?format=json` 取结构化信息；支持 9 种协议链接还原。另有**极简模式**把整站收敛成只回答这一个接口 |
| 安全 | 短时一次性连接票据（默认 120s）代替会话 Token、后端强制校验会话所有权、CDP 只监听 127.0.0.1 随机端口、CSP / X-Frame-Options / nosniff、WebSocket 背压保护 |

## 2. 技术选型

| 层 | 实现 | 说明 |
| --- | --- | --- |
| 前端 | 原生 ES Module + 手写 CSS（无构建步骤） | 打开即用，避免 Node 构建链在 Windows 上的额外故障点 |
| 后端 | Node.js 22 + Express | REST + WebSocket 同端口 |
| 数据库 | SQLite（`node:sqlite` 内置模块，WAL 模式） | 零原生依赖、单机部署最稳；数据模型与 PostgreSQL 兼容，可按需迁移 |
| 浏览器运行层 | 系统 Chrome / Edge / Chromium，每用户**独立进程 + 独立 user-data-dir** | 见 [docs/ADR.md](docs/ADR.md) 中「容器 vs 独立 profile」的取舍与风险说明 |
| 画面传输 | Chrome DevTools Protocol `Page.startScreencast` → JPEG → WebSocket 二进制帧 | 无额外组件；手机端同样可用 |
| 输入转发 | CDP `Input.dispatchMouseEvent / dispatchKeyEvent / insertText` | 坐标按远端视口 CSS 像素归一化换算 |
| 出网 | 复用宿主机的网络栈（系统代理 / TUN） | 本机的 VPN 客户端决定出口，平台不参与选路 |
| 公网暴露 | frp tcp 映射（内网 28471 → 公网 `zjc.rainplay.cn:25578`） | 配置见 `deploy/frpc.toml` 与本机 `frpc-webproxy.toml` |

## 3. 快速开始

### 3.1 环境要求

- Node.js **≥ 22.5**（需要 `node:sqlite`）
- 本机已安装 Chrome / Edge / Chromium（或通过 `CHROME_PATH` 指定）
- 需要让外网访问时：本机已配置 frp 客户端

### 3.2 启动

```bash
npm install
npm start
```

默认监听 `0.0.0.0:28471`（端口由 `.env` 的 `PORT` 决定，刻意避开 8080 这类常被扫描的端口）。

首次启动会：

1. 创建数据目录 `data/`、SQLite 数据库与全部表；
2. 创建管理员账号 `admin`，**随机密码打印在控制台**（只显示一次，或用 `ADMIN_INITIAL_PASSWORD` 指定）；
3. 打印浏览器内核路径与会话策略。

访问 `http://localhost:28471/login`：

- 管理员登录后进入 `/admin`；
- 普通用户登录后进入 `/`（远程浏览器工作区）。

> Windows 上更省事的是**双击两个启动脚本之一**（见下）。

#### 两个启动脚本（Windows，二选一，双击即可）

| 脚本 | 启动内容 | 什么时候用 |
| --- | --- | --- |
| **`start-nowapi.bat`** | **只开放 `/nowapi`**：登录页、工作区、管理后台、`/api/*`、画面 WebSocket 全部 404；不启动任何远端浏览器；frpc 照常由服务托管 | 这台机器只作为「节点查询接口」对外服务时（**默认用法**） |
| `start-easybrowse.bat` | 完整平台：登录、用户工作区、管理后台、远端浏览器、画面与音频通道 | 需要真正用远程浏览器时 |

两个脚本都自己设置 `NOWAPI_ONLY` 环境变量，优先级高于 `.env`，所以不用改配置文件、也不用担心上次的模式残留。
关掉窗口或按 `Ctrl+C` 即停服，托管的 frpc 会一起退出。

#### 开机自启（Windows）

- `install-autostart.ps1` 注册计划任务 **`easybrowse-app`**：登录 Administrator 后无窗口启动，任务设为 `IgnoreNew`，不会起出第二个实例。
- **开机默认只起 `/nowapi`**，完整平台要手动双击 `start-easybrowse.bat`。模式记在 `data/autostart-mode.txt`（`nowapi` / `full`），由 `install-autostart.ps1 -Mode` 写入；`.bat` 启动器的环境变量优先级更高。
- `start-hidden.vbs` 是**守护启动器**：node 非正常退出会自动拉起（5s→10s→20s→40s→60s 退避，连续 20 次失败后放弃并写 `data/guardian.log`）；退出码 0 视为有意停服，不再拉起。
- **frpc 不需要单独配自启**：它由服务托管（`.env` 里 `FRPC_CONFIG` 指向 `frpc-webproxy.toml`），随服务一起起、一起停。再配一份会抢同一个 `remotePort`。
- 停 / 重启请用 `scripts/stop-service.ps1`，**别直接杀 node** —— 守护会把它拉回来：

```powershell
.\scripts\stop-service.ps1            # 停止（含托管的 frpc）
.\scripts\stop-service.ps1 -Restart   # 重启
.\scripts\stop-service.ps1 -Status    # 只看状态，不动手

.\install-autostart.ps1               # 开启自启，模式=nowapi（默认）
.\install-autostart.ps1 -Mode full    # 开启自启，但开机就起完整平台
.\install-autostart.ps1 -Off          # 关闭开机自启（不会动正在跑的进程）
```

> 注意触发条件是「用户登录」而非「开机瞬间」：这台机器没开自动登录，断电重启后需要有人登录一次（远程桌面连一下也算），服务和 frpc 才会起来。

### 3.3 第一次使用只需要做一件事

**让别人拿到账号**，两种方式任选：

- **让对方自助注册**：把登录页地址发给对方，点「没有账号？立即注册」，填用户名和密码即可，注册后自动登录。新号默认不限流量、2 个并发会话、永久有效；同一 IP 每小时最多注册 6 个。不想开放时在 `管理后台 → 系统配置 → 开放自助注册` 关掉即可。
- **管理员手动创建**（`管理后台 → 用户管理 → 新建用户`），把初始密码交给使用者，并可单独设置流量额度、并发数与有效期。

网络出口不用配：远端浏览器用的是这台机器的网络。本机开着代理软件，它就走代理；本机直连，它就直连。想让所有远端浏览器**固定**走某个本地代理（例如不依赖系统代理设置），在 `.env` 里写：

```ini
CHROME_PROXY=http://127.0.0.1:10808
```

留空即为跟随本机。

## 4. 目录结构

```
easyvpn/
├─ src/
│  ├─ server.js              # 服务入口：路由、静态资源、安全响应头、可选 TLS、优雅退出
│  ├─ config.js              # 环境变量与路径配置（.env 可选）
│  ├─ db.js                  # SQLite 建表、设置项、初始管理员
│  ├─ auth.js                # 登录、Cookie 会话、RBAC、登录限速
│  ├─ audit.js               # 审计日志写入与查询
│  ├─ browser/
│  │  ├─ cdp.js              # 轻量 CDP 客户端（JSON-RPC over WebSocket）
│  │  ├─ launcher.js         # Chromium 参数拼装、进程启停（出口跟随系统）
│  │  ├─ netguard.js         # 内网 / 回环 / 元数据地址拦截
│  │  ├─ session.js          # 单用户实例：画面、输入、标签页、流量计数
│  │  └─ manager.js          # 会话编排、空闲回收、流量落库、profile 管理
│  ├─ routes/                # auth / session（用户端）/ admin（管理端）
│  ├─ ws/                    # 短时票据 + 画面 WebSocket 通道
│  └─ util/                  # 日志、口令与加解密、frpc 托管、代理节点读取（nodeinfo）
├─ public/                   # 登录页、用户工作区、管理后台（含 CSS / JS）
├─ start-nowapi.bat          # 启动：只开放 /nowapi（默认用法）
├─ start-easybrowse.bat      # 启动：完整平台
├─ start-hidden.vbs          # 开机自启用的守护启动器（无窗口 + 崩溃自动拉起）
├─ install-autostart.ps1     # 注册 / 关闭开机自启，可指定开机模式
├─ deploy/                   # frp、Caddy、Nginx 配置样例
├─ docs/                     # 架构决策记录、部署与验收文档
└─ data/                     # 运行期数据（数据库、用户 profile、日志）
   └─ profiles/<用户ID>/     # 每个用户独立的浏览器数据（Cookie、缓存、历史、下载）
```

## 5. 关键配置项（管理后台 → 系统配置）

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| 空闲断开画面 | 30 分钟 | 超时只断画面，浏览器进程保留 |
| 空闲停止进程 | 240 分钟 | 进程停止但 **profile 目录保留**，数据不丢 |
| 全平台并发上限 | 8 | 同时运行的浏览器实例数量 |
| 远端视口 | 1280×800 | 用户连接后会按自己屏幕自适应 |
| 渲染倍率 | 2x | **原画开关**。2 = 按 2 倍物理像素推流，文字锐利；1 = 省流量但会发虚。改动需重开会话 |
| 画面质量 | 75 | 30–100。2x 分辨率下 75 已看不出压缩痕迹，90 多耗约 76% 带宽 |
| 允许下载文件 | 开启 | 文件落在各自 `profile/Downloads` |
| 无头模式 | 开启 | 关闭后会在服务器桌面弹出可见窗口，便于调试 |

环境变量（`.env` 或系统环境）：

```ini
PORT=28471
HOST=0.0.0.0
BEHIND_HTTPS=0          # 用户访问的是 https 地址时设为 1，Cookie 加 Secure
SESSION_SECRET=...      # 留空则自动生成并保存到 data/.session_secret
DATA_DIR=./data
CHROME_PATH=C:/Program Files/Google/Chrome/Application/chrome.exe
CHROME_PROXY=           # 留空=跟随本机网络；填 http://127.0.0.1:10808 则强制走该代理
CHROME_EXTRA_ARGS=      # 额外的 Chrome 参数，空格分隔
BLOCK_PRIVATE_NETWORK=1 # 拦截远端浏览器访问内网/回环地址，公网部署务必保持 1
PUBLIC_URL=             # 仅用于启动日志提示，例如 http://你的域名:端口
TLS_CERT=               # 可选：本机直接提供 HTTPS 时填证书路径
TLS_KEY=
TLS_PORT=28472
ADMIN_INITIAL_PASSWORD= # 仅首次初始化生效
```

## 6. API 概览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 登录 |
| POST | `/api/auth/register` | 自助注册（默认不限流量 / 并发 2 / 永久有效），成功后直接登录 |
| POST | `/api/auth/logout` | 退出 |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/password` | 修改自己的密码 |
| POST | `/api/sessions` | 创建或恢复浏览器会话，返回短时连接票据 |
| GET | `/api/sessions/current` | 当前会话状态 |
| POST | `/api/sessions/:id/ticket` | 断线重连换新票据（校验所有权） |
| DELETE | `/api/sessions/:id` | 结束自己的会话（校验所有权） |
| GET | `/api/sessions/usage` | 我的用量与会话历史 |
| GET | `/api/admin/dashboard` | 仪表盘 |
| GET/POST/PATCH/DELETE | `/api/admin/users…` | 用户管理、重置密码 |
| GET/DELETE | `/api/admin/sessions…` | 会话列表、强制结束 |
| GET | `/api/admin/traffic?format=csv` | 流量统计与导出 |
| GET | `/api/admin/audit-logs` | 审计日志 |
| GET/PATCH | `/api/admin/settings` | 系统配置 |
| GET/POST | `/api/admin/profiles…` | 浏览数据占用、清理 |
| WS | `/ws/screen?ticket=…` | 画面与输入通道（票据 120 秒有效） |
| GET | `/nowapi` | 返回本机代理（v2rayN）当前选中的节点；默认纯文本分享链接，`?format=json` 取结构化信息 |

### /nowapi：查本机代理当前节点

不登录也能访问（一般给外部脚本 / 手机快捷指令轮询用），数据直接读 v2rayN 的本地库，
所以在 v2rayN 里切换节点后**下一次请求就会变**，不需要重启本服务。

```bash
# 默认：一行分享链接，可直接订阅到别的客户端
curl http://<host>:28471/nowapi
# vless://bfd...@us.sa.openel.top:51386?encryption=none&security=tls&...#[vless]美国优化

# 结构化信息
curl "http://<host>:28471/nowapi?format=json"
# {"ok":true,"protocol":"vless","name":"[vless]美国优化","address":"us.sa.openel.top",
#  "port":51386,"network":"ws","security":"tls","link":"vless://...","updatedAt":"...","source":{...}}
```

数据来源与实现要点：

- `guiConfigs/guiNConfig.json` 的 `IndexId` = 当前选中的节点编号；`guiConfigs/guiNDB.db` 的
  `ProfileItem` 表里存着该节点的完整字段（`ProtoExtra` / `TransportExtra` 是 JSON，装着 flow、
  ws 的 Host/Path、ss 的加密方式这些细节）。**不读 sing-box 的运行期配置** —— v2rayN 拉起内核后
  会把那份临时 `config.json` 删掉。
- 支持 vless / vmess / trojan / ss / socks / http / hysteria2 / tuic / anytls 的链接还原；
  `custom`（整份 yaml）与 `wireguard`（字段过多）没有单条 URI 表示，会返回 501 并提示用 JSON。
- 起不来的三种情况都有明确错误码：`v2rayn_not_found`（找不到目录，配 `V2RAYN_DIR`）、
  `no_selection`（v2rayN 里没选节点）、`db_read_failed`（文件被占用）。
- 配置项：`V2RAYN_DIR` 指定 v2rayN 便携版根目录（留空自动探测常见落点）；
  `NOWAPI_TOKEN` 设了口令后必须带 `?token=xxx` 或 `X-Nowapi-Token` 头，否则 403。

#### 极简模式（只留这一个接口）

`NOWAPI_ONLY=1` 时整个站点退化为「只回答 `/nowapi`」：

- 除 `/nowapi` 外，页面、`/api/*`、静态资源、画面 WebSocket **一律 404**（裸文本，不暴露原本是什么服务）；
- 不启动空闲回收等定时器，不接受任何会话，**反过来把上一轮遗留的远端浏览器进程在启动时清掉**；
- frpc 托管、开机自启照常工作，`/nowapi` 之外没有任何可达入口。

判定顺序：环境变量 `NOWAPI_ONLY`（两个 `.bat` 启动器设置）> `data/autostart-mode.txt`（开机自启用）> 默认关闭。


## 7. 安全说明

- 公网只暴露一个入口；CDP 端口为随机端口且只监听 `127.0.0.1`，任何接口都不会把端口号或 `webSocketDebuggerUrl` 返回给前端。
- 会话资源一律在后端用 `user_id` 校验所有权，前端传入的 `session_id` 不可信。
- 画面 WebSocket 使用一次性短时票据（`/api/sessions/:id/ticket`），避免把登录态放进 URL。
- 远端浏览器被限制访问回环 / 内网 / 链路本地 / 云元数据地址，避免被当成内网跳板（`BLOCK_PRIVATE_NETWORK=1`）。
- 不记录网页正文、表单内容、密码或 Cookie；不解密 HTTPS。
- **`/nowapi` 会原文吐出代理节点链接，等价于公开代理凭据**（含 UUID、服务器地址、SNI）。
  默认不校验口令是为了便于脚本调用；对外部署时请务必设置 `NOWAPI_TOKEN`，否则任何人都能拿走你的节点。
  未设置时服务启动日志会打一条 WARN 提醒。

> 注意：通过 frp 的 tcp 映射以 **纯 HTTP** 暴露时，登录口令在公网是明文传输的。要真正安全只有两条路：本机提供 TLS（自签会告警，需自有域名证书），或在 VPS 上用 Caddy/Nginx 做 HTTPS 反代。见 `docs/DEPLOY.md`。

完整的安全边界、取舍与已知风险见 [docs/ADR.md](docs/ADR.md)。

## 8. 部署与验收

- Windows 本机 + frp 的完整部署步骤：[docs/DEPLOY.md](docs/DEPLOY.md)
- 验收测试清单与实测结果：[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)

## 9. 当前版本边界

- 一个用户同一时间只有一个浏览器实例（`max_sessions` 字段已预留，MVP 按 1 实现）。
- 隔离级别为「独立进程 + 独立 profile」，**不是**容器级隔离；如需对抗恶意样本，请按 ADR 的建议迁移到 Docker / Linux 主机方案。
- 流量统计为应用层字节数（CDP Network 域），与运营商或代理侧计费口径存在差异，属可解释误差。
- 不做网站访问审计、配额自动禁用、多人协同、下载管理；这些属于后续阶段。
