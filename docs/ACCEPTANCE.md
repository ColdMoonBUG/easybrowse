# 验收测试记录

对照需求第 10.2 节的验收表，记录已完成实测的项目、方法与结果，以及尚未覆盖的项目。

测试环境：Windows 10 19044 · Node.js 22.22.2 · Google Chrome（系统安装版）· 无 Docker。

| 测试项 | 需求通过标准 | 实测方法 | 结果 |
| --- | --- | --- | --- |
| **双用户隔离** | 用户 A 与 B 同时登录，互相看不到对方浏览器、Cookie、历史记录和下载文件 | 创建 `admin` 与 `demo` 两个账号并各自启动浏览器；两个实例同时 `RUNNING`；检查 `data/profiles/<用户ID>/` 生成两个独立目录（admin: `d88cd8b0-…`，demo: `322d6e2d-…`） | ✅ 通过（进程级隔离，数据目录互不可见） |
| **出网跟随本机** | 远端浏览器不单独配置代理，流量出口与本机一致 | 本机 `sing-box`（v2rayN）运行，系统代理关闭、TUN 生效；新建会话后打开 `https://www.bing.com`、`https://api.ipify.org` | ✅ 通过：Bing 正常渲染（中文界面 + 图片加载），页面出口 IP 与本机 `curl` 一致，平台侧未传任何 `--proxy-server` |
| **内网拦截** | 公网用户不能借远端浏览器访问宿主机与内网 | 地址栏导航到 `http://192.168.1.1/`、`http://127.0.0.1:28471/login`；另对文档级请求做 CDP `Fetch` 拦截验证 | ✅ 通过：均被拒绝并提示「禁止访问内网地址」，远端页面保持原状，请求未发出 |
| **移动端** | iPhone Safari / Android Chrome 能登录、显示画面、输入网址并完成点击与滚动 | 已实现：控制栏常显（可手动收起）、底部输入面板常驻且不遮挡画面、点远端输入框自动聚焦、触摸拖动滚动、点按转发、自适应远端视口；**未在真机实测** | ⚠️ 待真机验证（代码路径已就绪） |
| **手机输入键盘** | 手机上点远端页面里的输入框能呼出本地键盘，输入内容能送到页面 | Chrome 390×844 + 触摸模拟打开工作区，远端导航到整屏 `input` 的页面后点画面中心；另测普通页面与手动键盘按钮 | ✅ 通过：点击后服务端回推 `focus.editable=true`，`.textpanel` 自动出现且 textarea 获得焦点（面板 390×61 贴底）；发送「你好 EasyBrowse」后远端输入框显示该文字、本地输入框已清空且焦点保留；普通页面回推 `editable=false` 不弹面板；工具栏键盘按钮可手动开合 |
| **各听各的（音频回传）** | 用户能听到自己浏览器里的声音；宿主机与其它用户无声；关闭时立刻停止推送 | 建测试账号启动浏览器，导航到 MSE 发声页（`data:` 页面内用 MediaRecorder 生成 webm 再喂给 MediaSource），点顶栏扬声器 | ✅ 通过：`peak=1.0`（满幅 660Hz）、约 46 包/秒、AudioContext `running`、播放队列无堆积；关闭后音频上下文挂起且不再推送；`--mute-audio` 仍开启（服务器无声） |
| **/nowapi 节点查询** | 访问 `/nowapi` 能返回本机代理当前选中节点的分享链接；切节点后立刻反映 | 读 v2rayN 的 `guiNDB.db`，与 v2rayN 里复制的链接逐字节比对；本地与公网各请求一次；再测 `?format=json`、`?token=` 错误口令 | ✅ 通过：返回串与目标链接 `vless://bfe9****-****-****-****-********da18@us.sa.openel.top:51386?encryption=none&security=tls&…` **逐字节完全一致**（UUID 已打码）；本地与公网均 `200 text/plain`；JSON 含 protocol/name/address/port/link/updatedAt；口令错误 `403`；首次读库 3ms，命中缓存 0ms |
| **极简模式（只留 /nowapi）** | `NOWAPI_ONLY` 开启后除 `/nowapi` 外无任何可达入口；不启动远端浏览器；frpc 与开机自启照常 | 写入 `data\autostart-mode.txt=nowapi`，通过计划任务重启（守护脚本不传环境变量，完全走文件判定），再用路径矩阵逐个请求 | ✅ 通过：本地与公网 `/nowapi` 均 `200`；`/` `/login` `/register` `/admin` `/api/*` `/css/*` `/js/*` `/favicon.ico` 全部 `404`；`/ws/screen` 升级请求返回 `404`；远端浏览器进程数 `0`；node 与 frpc 父子关系正常，frpc `login to server success` / `start proxy success` |
| **服务器端静音** | 任意用户网页播放音频时，宿主机音箱不得出声 | 建测试账号启动浏览器，用 ws 导航到本地 440Hz 测试页（`file:///…/eb-tone.html`），再查该实例进程树的 Windows 音频会话 | ✅ 通过：实例命令行含 `--mute-audio`；音频会话 `GetMute=true`（未加参数时实测为 `false`，脚本静音后转 `true`）；按 profile 路径可识别并静音数据库里没有记录的孤儿实例 |
| **会话权限** | 用户 A 无法通过改 URL、API 参数或 session_id 连接用户 B 的会话 | 用 admin 的登录态请求 demo 会话的票据 `POST /api/sessions/{demoSessionId}/ticket`，以及 `DELETE /api/sessions/{demoSessionId}` | ✅ 通过：均返回 `404 会话不存在或不属于当前用户` |
| **强制结束** | 管理员结束会话后用户连接立即失效，容器按策略销毁 | `DELETE /api/admin/sessions/{id}` 结束 demo 会话，随后查询 demo 的 `/api/sessions/current` | ✅ 通过：返回 `200`；随后 `session: null`，浏览器进程已退出，审计记录 `admin.session_forced_stop` |
| **流量统计** | 对浏览器执行可控下载/上传，统计值可与代理或网络计数器核对 | 浏览 `https://example.com` 后查看仪表盘与流量统计页 | ✅ 基本通过：`rx` 随浏览增长（实测 2.06 MB）；口径为 CDP `Network.loadingFinished.encodedDataLength`，与代理侧计数存在协议层差异 |
| **资源限制** | 单用户达到 CPU/内存上限时不影响宿主机与其他会话 | 已实现：平台级并发上限、两级空闲回收（断画面 / 停进程）、单用户单实例 | ⚠️ 部分：**未实现单进程 CPU/内存硬限制**（Windows 需 Job Object 或容器），见下方「已知缺口」 |
| **重启恢复** | 服务异常重启后能识别并清理孤儿容器，数据库会话状态不会长期卡在运行中 | 杀掉服务进程后重启 | ✅ 通过：日志输出「已收敛 1 个上一次运行遗留的会话状态」，遗留 pid 被 `taskkill` 清理，记录置为 `STOPPED / service_restart` |
| **浏览数据保留**（本项目额外要求） | 结束会话、服务重启后 Cookie、登录态、历史记录仍然存在 | 同一用户结束会话并重启服务后重新启动浏览器 | ✅ 通过：仍使用同一 `user-data-dir`，Chrome 恢复上次标签页（`example.com`），地址栏与历史保留 |
| **画面与输入** | 网页中可远程操作浏览器 | 通过 WebSocket 协议脚本验证：`nav` 后收到 `frameNavigated`、点击/滚轮/键盘/`insertText` 均无报错 | ✅ 通过 |
| **原画清晰度**（2x 渲染） | 远端画面文字锐利，不是放大的模糊图 | 客户端按 1920×1080 / DPR=1 打开工作区，读 `canvas.width` 与视口；解析帧 JPEG 的 SOF 段取真实像素 | ✅ 通过：视口 1884×881 CSS，帧 3768×1762（2 倍），canvas 按 1884×881 落版 → 超采样显示，文字边缘干净；状态栏显示 `1884×881 · 2x` |
| **低带宽保护** | 网络跟不上时优先保输入，不堆延迟 | 通过公网 `zjc.rainplay.cn:25578` 持续滚动 Bing 结果页 12 秒，统计帧数与体积 | ✅ 通过：27.5 Mbps / 16 fps / 210 KB 每帧，`dropped=0`；本地回环同样数值（瓶颈不在本机）。背压阈值 800KB，超限丢帧保输入 |
| **标签页管理** | 支持新建/切换/关闭标签页 | 通过协议脚本新建 `https://example.org` 标签页 → 激活 → 关闭 | ✅ 通过：标签列表正确更新并回到原标签页 |
| **公网访问（frp）** | 外网任何人可用公网地址登录并操作远程浏览器 | 内网 28471 → 面板内网端口 25575 → 公网 `zjc.rainplay.cn:25578`；check-host 5 国节点 HTTP 探测 + 公网 WebSocket 拉帧 | ✅ 通过：5 个节点全部 `200 OK`；公网登录、建用户、启动浏览器、`/ws/screen` 收到 `ready` 与画面帧（Bing 首页正常渲染） |
| **自助注册** | 未登录用户能从登录页「立即注册」创建账号，注册后直接进入工作区；新号不限流量、并发 2、永久有效 | 公网 `http://zjc.rainplay.cn:25578/register` 提交 `testreg01 / a`，读 `/api/auth/me` 与后台用户列表；再关闭「开放自助注册」开关复测 | ✅ 通过：201 + 登录 Cookie，访问 `/` 直接 200；`maxSessions=2`、`quotaBytes=0`、`expiresAt=null`；重名 409、空密码 400；关闭后 `/register` 302 → `/login?register=closed`、接口 403 |
| **未登录访问** | 未登录不能进入门户或后台 | 直接访问 `/`、`/admin`、`/api/admin/*` | ✅ 通过：页面 302 到 `/login`，接口 401 |

## 已知缺口与后续计划

1. **单进程资源硬限制**：当前通过「并发上限 + 空闲回收」控制总量，未对单个 Chromium 进程做 cgroup / Job Object 级限制。阶段 3 迁移到容器后由 `--memory`、`--cpus`、`--pids-limit` 直接解决。
2. **配额自动禁用**：当前超额只阻断新会话启动并写审计，不会自动把账号置为禁用；管理员可在用户管理页手动禁用。
3. **域名审计日志**：默认不记录访问域名（隐私优先），如需可按配置项开启。
4. **移动端真机测试**：需在 iOS Safari 与 Android Chrome 上各做一次完整流程验证（登录 → 启动 → 输入网址 → 点击 → 滚动 → 输入中文）。
5. **视频类站点**：screencast 本质是「变化即推帧」，滚动与视频播放帧率有限；音频已通过 PCM 旁路回传，音画延迟差约 100ms 量级。跨域直链媒体（未声明 crossorigin）受浏览器安全策略限制无法取声，主流 MSE 站点不受影响。

## 复现测试的命令

```bash
# 1. 启动服务
npm start

# 2. 登录并拿到 Cookie
curl -c cookie.txt -H "Content-Type: application/json" \
     -d '{"username":"admin","password":"你的密码"}' \
     http://localhost:28471/api/auth/login

# 3. 创建会话，拿短时票据
curl -b cookie.txt -X POST http://localhost:28471/api/sessions

# 4. 用票据连接画面通道（浏览器控制台即可）
#    const ws = new WebSocket(`ws://localhost:28471/ws/screen?ticket=...`)
#    ws.binaryType = 'arraybuffer'
#    ws.onmessage = e => typeof e.data === 'string' ? console.log(JSON.parse(e.data)) : console.log('frame', e.data.byteLength)

# 5. 结束会话
curl -b cookie.txt -X DELETE http://localhost:28471/api/sessions/<sessionId>
```
