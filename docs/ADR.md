# 架构决策记录（ADR）

本文件记录 EasyBrowse MVP 阶段的关键技术决策、备选方案对比与已知风险，供后续迭代与安全评审使用。

---

## ADR-001 总体形态：门户 / 数据面 两层分离

**决策**：门户与控制面（认证、授权、会话编排、统计审计）与浏览器数据面（Chromium 进程、画面流）分离部署在同一台主机上，但代码层面严格分层：`src/routes` 只做鉴权与业务编排，`src/browser` 只做浏览器生命周期，`src/ws` 只做通道；出网路径完全交给宿主机的网络栈（系统代理 / TUN），平台不参与选路。

**理由**：

- 与需求第 6.1 节推荐架构一致；
- 管理网站不承载浏览器流量，画面走独立 WebSocket 通道；
- 出口策略由本机 VPN 客户端统一管理，换节点、切规则都不用改平台代码；
- 后续把浏览器数据面迁到独立 Linux 主机时，只需替换 `launcher.js` 与 `session.js`。

**代价**：单机部署时门户与浏览器共享 CPU/内存，需要靠并发上限与空闲回收保护主机（已实现 `maxConcurrentSessions` 与两级空闲策略）。

---

## ADR-002 隔离粒度：每用户「独立进程 + 独立 user-data-dir」，暂不引入容器

需求优先要求容器隔离。当前实现选择**独立 Chromium 进程 + 独立 profile 目录**，原因与风险如下。

| 方案 | 隔离强度 | Windows 可用性 | 资源开销 | 结论 |
| --- | --- | --- | --- | --- |
| 每用户独立 Docker 容器（Kasm / Neko / Vessel 方案） | 高（OS 级） | 需 WSL2 + Docker Desktop，网络与 GPU 编码链路复杂 | 高（每容器一个完整桌面栈） | 本机无 Docker，作为阶段 3 的迁移目标 |
| 每用户独立进程 + 独立 user-data-dir（本实现） | 中（进程级）：Cookie / 缓存 / 历史 / 下载 / 存储完全隔离，进程崩溃互不影响 | 原生支持 | 低（约 150–300MB/用户） | **MVP 采用** |
| 同一 Chrome 多 BrowserContext | 低（同一进程内，调试端口共享） | 原生 | 最低 | 已否决：不满足「不把不同用户放在同一 Chrome 的不同标签页」的要求 |

**已实现的风险缓解**：

- 独立用户数据目录 ⇒ Cookie、LocalStorage、IndexedDB、缓存、历史、下载互不可见；
- CDP 端口随机且只绑 `127.0.0.1`，不暴露给前端，也不写入日志；
- 浏览器以普通权限运行，不挂载 Docker socket，不接触宿主管理接口；
- 导航与文档级请求拦截回环 / 内网 / 链路本地 / 云元数据地址（`netguard.js`）⇒ 即使页面试图通过 `http://127.0.0.1`、`192.168.x.x`、`169.254.169.254` 探测宿主机与内网，请求也会被直接中止；
- 单用户进程异常退出只影响本人（`ERROR` 状态 + 自动收敛）。

**已知风险（必须在生产前确认）**：

1. 同一操作系统用户下运行，恶意页面若利用 Chromium 沙箱逃逸漏洞，理论上可跨用户影响宿主机。**仅在信任用户群体的场景下可接受**。
2. Windows 上 Chromium 的渲染进程沙箱默认开启，但宿主为个人日常桌面时，仍建议使用专用 Windows 账户 / 专用虚拟机。
3. 若面向不受信任用户，请按 `docs/DEPLOY.md` 的「阶段 3 迁移路径」切到容器方案（`launcher.js` 中把 `spawn(chrome)` 换成 `docker run`，`session.js` 中把 CDP 端口改为容器内网端口 + SSH/代理转发即可）。

---

## ADR-003 画面传输：CDP `Page.startScreencast` + WebSocket 二进制帧

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| **CDP screencast（本实现）** | 零额外组件、依赖最少、实现可控、与 Chrome 版本解耦 | 仅 JPEG 帧（无音频）、依赖页面变化触发、高动态场景带宽较高 | **MVP 采用** |
| WebRTC（Neko / Selkies） | 低延迟、支持音频、硬件编码 | 需 TURN/STUN、Linux 容器与 GStreamer/Xvfb 栈，移动端兼容性需实测 | 阶段 3 候选 |
| noVNC / KasmVNC | 成熟、跨平台 | 需要完整 X/桌面栈，Windows 原生不可用 | 与容器方案一起考虑 |

**实现细节**：

- 帧格式：`[0x01][uint32 metaLen][meta JSON][JPEG]`，meta 带画面尺寸，前端按画布显示尺寸归一化坐标；
- 服务端在客户端 `bufferedAmount > 800KB` 时主动丢帧（保输入延迟可用）；
- 前端用 `createImageBitmap` + 单帧解码队列，避免乱序渲染；
- 无人观看时停止 screencast，避免空转消耗 CPU；
- 用户连接后按自己屏幕尺寸调整远端视口（`Emulation.setDeviceMetricsOverride`），移动端得到原生移动排版。

### 清晰度：为什么必须用 `--force-device-scale-factor`

「画质糊」排查下来是三个原因叠加，前两个是参数问题，第三个是 CDP 的限制：

1. **视口被锁在默认 1280×800**：早先靠 `setTimeout(400ms)` 触发视口协商，公网/frp 下消息常落在服务端监听器注册之前被丢弃，整场会话都把 1280 宽的图放大到 1900 宽显示。现改为收到 `ready` 后再协商，并在 `ResizeObserver` 里兜底。
2. **前端按 CSS 像素落版**：现在帧是物理像素，落版时先除以渲染倍率再算缩放比，保证 1 个物理像素对应 1 个屏幕像素。
3. **`Page.startScreencast` 不认 `deviceScaleFactor`**（实测：同一页面，`Page.captureScreenshot` 在 `deviceScaleFactor=2` 下返回 2880×1620，而 `startScreencast` 仍然只给 1440×810）。它按窗口的 surface scale 出图，所以只能把整个渲染管线的倍率用 `--force-device-scale-factor=2` 提上去。

**最终形态**：Chrome 以 `--force-device-scale-factor=2` 启动，窗口按 `max(视口,1920×1080) × 2` 预留（窗口给小了会把 2x surface 裁掉，帧卡在初始尺寸上）；视口仍是 CSS 尺寸，帧是它的 2 倍。`renderScale` 可在后台改成 1/2/3，或 `.env` 的 `RENDER_SCALE` 指定，**改完需重开会话**（进程级参数）。

**代价与取舍**：2 倍分辨率下滚动时实测 27 Mbps / 16 fps / 210 KB 每帧（公网 frp 实测同样数值，零丢帧），静态阅读几乎不耗流量（screencast 只在画面变化时推帧）。质量取 75：90 会多耗约 76% 带宽而肉眼差异极小。若带宽紧张，把 `renderScale` 降 1 或质量降到 55，而不是关掉背压保护。

**另一个坑**：重复调用 `Page.startScreencast` 时 Chromium 会沿用第一次的 `maxWidth/maxHeight`，视口变大后帧仍被压在旧分辨率。必须在 `setStreaming` 里先 `stopScreencast` 再重新 start。

---

## ADR-004 出网：跟随宿主机网络 + 内网拦截

**决策**：远端 Chrome **不传** `--proxy-server`，直接使用宿主机的网络设置（系统代理 / PAC / TUN 全部生效）。需要固定出口时才用环境变量 `CHROME_PROXY` 覆盖。同时新增 `netguard.js`，在导航层拦截回环、内网、链路本地与云元数据地址。

**理由**：

- 实际部署形态是「一台自己的 Windows 机器 + frp 穿透」，机器上本来就有 VPN 客户端在跑；平台再存一份代理配置属于重复建设，还会因为「平台里的出口 ≠ 本机实际出口」产生排障黑洞；
- 用户/管理员只维护一处网络设置：本机 VPN 客户端；
- Chromium 在 Windows 上原生读取系统代理，PAC 规则也能正确生效；TUN 模式下流量在更底层被接管，Chrome 甚至无需感知代理；
- 一旦通过公网暴露，浏览器就成了宿主机上的「公网可编程代理」——不限制目标地址等于把内网交出去。因此拦截放在平台侧，而不是依赖代理软件的分流规则。

**拦截实现**：对每个页面启用 CDP `Fetch`，只匹配 `resourceType = Document` 的请求（避免每个图片/脚本都做一次 DNS 判定），命中私有地址段则 `Fetch.failRequest(BlockedByClient)`，并通过 WebSocket 向用户提示原因；地址栏导航在 `navigate()` / `newTab()` 入口再做一次前置校验，给出明确的中文提示。DNS 结果缓存 5 分钟。

**取舍**：拦截只覆盖文档级请求。子资源（XHR/fetch 到内网）仍可能发出，但缺少合法文档上下文时无法读取响应，且无 CORS 许可，实际可用性极低。若需要更严格，可把 pattern 改为全部请求，代价是每次请求都要过一遍判定。

**已知限制**：如果宿主机 VPN 是 TUN 模式，Chrome 的流量在系统层被接管，`netguard` 依然在 CDP 层生效（它拦的是导航本身，与传输层无关）。

---

---

## ADR-005 数据库：SQLite（`node:sqlite`）

**决策**：MVP 使用 Node 22 内置 `node:sqlite`，WAL 模式，单文件存储在 `data/easybrowse.db`。

**理由**：

- 零原生依赖（`better-sqlite3` 需要编译工具链，Windows 上易失败）；
- 单机、并发 3–5 人规模的写入压力极小；
- 表结构（users / browser_sessions / traffic_samples / traffic_daily / audit_logs / settings）与需求第 12 节一致，迁移到 PostgreSQL 只需替换 `db.js` 的驱动层与自增语法。

**代价**：不支持多实例水平扩展；`traffic_samples` 量大后需要定期归档（已按日聚合到 `traffic_daily`）。

---

## ADR-006 会话策略：持久 profile（按用户要求「浏览数据保留」）

**决策**：每个用户固定使用 `data/profiles/<user_id>/`，**结束会话 / 空闲停止进程 / 服务重启都不删除**；管理员可在「浏览数据」页查看占用并主动清理。

**行为**：

- 用户点「结束会话」→ 浏览器进程退出，profile 保留；
- 空闲 30 分钟 → 断开画面；空闲 240 分钟 → 停止进程（可在系统配置调整）；
- 下次登录 → 同一 `user-data-dir` 启动，Cookie、登录态、历史、书签、下载文件原样恢复；若上次异常退出，Chrome 还会提示恢复标签页；
- 服务重启 → `recoverOnBoot()` 收敛上一轮遗留的 `RUNNING` 记录并清理孤儿进程，避免状态卡死。

**隐私权衡**：数据长期保留意味着服务器磁盘上存在用户的网站登录态。已实现：账号删除不自动删数据（避免误删），清理入口单独放置且二次确认，审计记录 `profile.purged`。生产环境需在隐私告知中说明保留期限（登录页文案可由管理员在系统配置中修改）。

---

## ADR-007 前端：原生 ES Module，无构建步骤

**决策**：不使用 Vue/React 构建链，直接用 ES Module + 手写 CSS 变量体系。

**理由**：需求第 6.1 节建议 Vue 或 Next.js，但 MVP 的页面复杂度（登录、工作区、后台 8 个页签）不需要框架；无构建可显著降低 Windows 服务器上的部署与升级成本，也避免 `node_modules` 体积与打包故障。若后续要做复杂表单/权限矩阵，可在保持 API 不变的前提下平滑切换到 Vue 3。

---

## 参考开源项目评估

| 项目 | 可借鉴点 | 对本次实现的结论 |
| --- | --- | --- |
| Kasm Workspaces | 容器化工作空间、用户/工作空间管理、浏览器隔离 | 功能最完整，但需要 Linux + Docker 全套栈；作为阶段 3 的对照产品与迁移目标 |
| Neko | Docker 虚拟浏览器、WebRTC 传输 | 面向多人共享房间，单用户独立实例编排需自行实现；其 WebRTC 传输层是阶段 3 的画面升级候选 |
| Vessel | 每会话独立容器、画面/输入转发、资源限制、断线恢复 | 直接借鉴了「会话状态机 + 断线恢复 + 资源限制」的设计；其容器编排方式在无 Docker 的 Windows 主机不可用 |
| Remote Browser | BrowserContext 隔离、MJPEG/WebSocket | 验证了「WebSocket 推 JPEG 帧 + CDP 输入」的可行性；其 Context 级隔离不满足需求，仅参考传输实现 |
| Mini-Kasm | 轻量会话管理、空闲暂停、noVNC 反代 | 借鉴了「空闲暂停 + 会话恢复」的状态设计 |
| docker-browser / FrontBrowser | 按用户独立进程、独立 profile、网络隔离 | 与我方「独立进程 + 独立 profile + 内网拦截」思路一致，验证了该路径的可行性 |
| Selkies | HTML5 远程桌面流媒体 | 传输层方案，依赖 Linux 容器，作为阶段 3 候选 |
| Apache Guacamole | RDP/VNC/SSH 网关 | 与浏览器实例管理无关，未采用 |
| Browserless | 浏览器服务化、CDP 会话管理 | 面向程序调用，无用户门户，未采用 |

**许可证提醒**：Kasm Workspaces 采用版号受限的许可协议，Neko/Selkies 为 Apache-2.0 / MIT 系；正式引入前需逐个复核最新提交、Issue 与许可证条款。

---

## 分阶段实施计划

| 阶段 | 内容 | 当前状态 |
| --- | --- | --- |
| 阶段 0 技术验证 | 验证 Windows + Chrome + CDP 画面/输入、内网拦截、移动端可用性 | ✅ 已完成（见 ACCEPTANCE） |
| 阶段 1 MVP | 登录、用户管理、浏览器生命周期、网页远程操作、出网跟随本机、数据保留 | ✅ 已完成 |
| 阶段 2 管理与计量 | 流量统计、会话列表、强制结束、配额、审计日志、浏览数据管理 | ✅ 已完成（配额为「超额阻断启动」，自动禁用留待阶段 3） |
| 阶段 3 稳定性与安全 | 容器化迁移、短时凭证轮换、限流加固、备份、异常恢复、压测 | ⏳ 待实施 |
| 阶段 4 增强 | 多节点选择、下载管理、更多浏览器、报表、多人协作 | ⏳ 待实施 |
