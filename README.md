# dsh-clash-autovpn

DSH（DeepSeek Harness）的**按需 VPN** 插件：联网失败时判断是不是「墙」，是的话自动开你本机的 Clash
代理（自己挑能打开目标站的地区节点），**用完自动关**，并且**在 VPN 流量超过预算（默认 1GB）时
警告、暂停、问你**。

```
DSH 联网失败
   │
   ├─① 诊断：直连目标 ✗ ／ 经本机代理访问同一目标 ✓ ／ 国内基准站 ✓   → 判定「网络封锁」
   │
   ├─② 开：发现 Clash 控制口 → 按地区优先(香港→日本→新加坡→台湾→美国)实测选节点
   │         → Clash 临时切 rule（国内直连，省订阅流量）→ 打开系统代理
   │         → 用宿主 installProxyFromEnvironment() 接管 DSH 自身出站
   │
   ├─③ 关：联网空闲 3 分钟自动关，逐项还原（模式／节点选择／系统代理／DSH 出站策略）
   │
   └─④ 刹车：流量 > 1GB → 立刻关代理 + 暂停联网工具 → 用问答 UI 问你要不要继续
```

## 为什么不能只打开「系统代理」

这是本插件存在的根本原因：**DSH 自己的出站流量不读 Windows 系统代理**。

宿主 `@deepseek-ai/dsh-http-proxy` 的说明写得很明确：「不会读取 macOS 或 Windows 的系统代理设置，
因此仅在代理软件里拨了开关的用户仍须导出环境变量」。它的策略在**启动时**由启动器解析一次并安装到
undici 的全局 dispatcher 上。

所以本插件做两件事：

| 目标 | 手段 |
|---|---|
| 让**浏览器等其它程序**走代理 | 写注册表 `ProxyEnable`/`ProxyServer` + 通知 WinINET 刷新（保存原值，可精确还原） |
| 让 **DSH 自身**（web 搜索/抓取、MCP、子进程）走代理 | 运行时调用宿主导出的 `installProxyFromEnvironment()`，把策略重装成「走本机 7890」 |

第二件事是本插件的关键动作，并且用 `dispose()` 还原；若该接口在某个 DSH 版本上不可用，会自动降级为
自建 undici dispatcher（按主机名分流、回环强制直连），保证不至于完全不工作。

## 安装

本机实际采用「**不碰 package.json / lockfile**」的最小改动接入（插件包就在本工作区里）：

```powershell
# ① 接入 profile 的模块解析：目录联接（等价于 pnpm 对 file: 依赖做的软链，但不动 lockfile）
$src = Join-Path $PWD 'dsh-clash-autovpn'          # 插件源码目录（本工作区里那份）
$dst = Join-Path $env:USERPROFILE '.dsh\profiles\desktop\node_modules\dsh-clash-autovpn'
New-Item -ItemType Junction -Path $dst -Target $src
```

```yaml
# ② 编辑 %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml（profile 的**用户层**），追加：
- insert:
    - id: dsh-clash-autovpn
      name: 'dsh-clash-autovpn'
```

③ 让宿主重读 profile（本机实测：**改完 profile 的用户层会被立即重读**，工具面直接出现；
   若没出现就重启 DSH）。

装好后 `%USERPROFILE%\.dsh\clash-autovpn\` 下会有 `autovpn.log` 与 `state.json`，
工具面多出 6 个 `vpn_*` 工具。

> **⚠ 必须写成 `- insert:` 形式**（首次安装踩过的坑）。宿主 `dsh-app-boot` 的
> `applyEntryPatches` 语义是：带 `insert` = 新增条目；**不带** `insert` 的 `- id/name`
> 只是「覆盖一个已存在的 id」，新 id 在 bundle 层找不到就 `warn("patch: entry %C not found")`
> 并**静默跳过**——表现是「装完了、重启了，但插件根本没被 import」（日志里连一行加载记录都没有）。
> 卸载时删掉这一条 + 目录联接即可（模式/节点/系统代理无需处理，插件从不留残留）。

> **为什么不用 `dsh plugin add`**：desktop profile 由 Electron 应用独占管理（CLI 的
> `--dump-config` 会直接拒绝该 profile），并且安装时会按 `peerDependencies` 做兼容性门禁
> （实测会拒绝并提示 `dsh plugin allow-version` 才能放行），还会让 pnpm 重排整个 node_modules。
> 手工联接 + 用户层 patch 的改动面最小：只多一个目录联接与一个条目，卸载删掉这两样即可。
> 若要改走管理器正规安装，包本身是标准形态（`dsh.bundle.patch` + 自带 `cordis.patch.yml`），
> 直接 `dsh plugin --profile desktop add <路径>` 即可。
>
> 兼容性写法：本机 DSH 运行时是 `0.2.0-rc.2`，`@deepseek-ai/dsh-tools` 的 peer 范围写成
> `>=0.2.0-rc.2`（带 prerelease 的同元组下限才能被 semver 判为满足；写成 `>=0.1.0-rc.2`
> 会因为 semver 的「预发布版本排除」规则被判不兼容）。
>
> **改了 `lib/*.js` 要不要重启？** profile 的用户层会被重读，但**已 import 的插件模块走 ESM 缓存、
> 不会重新求值**——改代码后要重启 DSH 才生效（实测：`includeLog:false` 的修复在运行中的实例上
> 仍报旧错，新进程里已通过）。



## 工具

| 工具 | 用途 |
|---|---|
| `vpn_diagnose(target?)` | 判定失败是否因墙。返回 `vpn-needed` / `vpn-region-blocked` / `no-internet` / `target-ok-direct` / `proxy-unreachable` / `blocked-both` 等结论 + 证据 |
| `vpn_enable(target?, region?, reason?, force?)` | 开代理（发现控制口 → 选节点 → 切 rule → 系统代理 → 接管 DSH 出站） |
| `vpn_disable(reason?)` | 关代理并逐项还原，报告本轮用量 |
| `vpn_status(includeLog?)` | 状态、用量/预算、节点、暂停标记、最近日志 |
| `vpn_nodes(action, group?, node?, url?, limit?)` | `list` 组与节点（带地区）／`test` 真实测速／`select` 手动选节点 |
| `vpn_budget(action, addMB?, userSaid?)` | 超预算暂停后的处置：`continue`（追加额度并重开）／`stop`／`reset` |

自动行为（无需你操作）：

- **自动开**：联网工具（`web_fetch` / `web_search`，以及命令行里含 `git clone`/`curl`/`npm install` 等的 `pwsh`）
  失败且判定为封锁时，自动开代理并在下一轮上下文里告诉模型「代理已就绪，请重试」。
- **自动换节点**：开了之后仍失败、或经代理实测超过 `speedThresholdMs`（默认 2500ms），自动换一个节点
  （地区优先序不变，排除刚失败的那个）后复测。
- **自动关**：联网空闲 `autoDisableIdleMinutes`（默认 3 分钟）后关闭并还原。
- **刹车**：本会话累计流量超过 `budgetMB`（默认 1024MB）→ 立刻关代理 → 联网工具被 guard 否决（硬暂停）
  → 下一次联网尝试时用宿主的**问答 UI** 问你：追加 1GB 继续 / 本次不限额继续 / 停止。

> 为什么用问答（userQuestions）而不是审批弹窗（approval）：本机会话常驻 `approval: never` 预设，
> 审批请求会被自动拒绝、根本不会显示给你。问答通道不受该预设影响。

## 对外服务：`clashAutovpn`（0.2.0 起）

**代理实例只有这一份。** 别的插件要「借用」本插件的代理（例如
[dsh-sync-autovpn](../dsh-sync-autovpn) 在 GitHub 同步开始前预开、同步结束后还回来），
请取这个服务，**不要各自 `new VpnManager()`**：两份实例各记一份「原始状态」，关闭时会互相覆盖，
典型后果是系统代理被留在开着没人管。

```js
const vpn = ctx.get('clashAutovpn')
await vpn.enable({ reason: 'sync:web-button', target: 'https://github.com/' })  // 已经开着会返回 { already: true }
vpn.noteActivity()                                                              // 告诉它「还有人要用」，别按空闲关
await vpn.disable({ reason: 'sync-done' })                                      // 逐项还原
vpn.status()  // active / tripped / proxyUrl / node / region / usage / lastActivityAt …
```

服务字段：`version` `manager`（原始 VpnManager）`active` `tripped` `proxyUrl`
`status()` `noteActivity()` `enable(opts)` `disable(opts)` `verifyAndMaybeSwitch(target, opts)`。

取用方的顺序建议：`ctx.get('clashAutovpn')` → `ctx.clashAutovpn` → `globalThis.__dshClashAutovpn`（本插件
一直会挂的兜底全局，便于自动化测试与排查）。实测某些宿主的 ctx 没有 `provide`（本插件会记一条 warn 并
自动退到 `ctx.set`，再退到全局），所以取用方要有兜底。

**卸载即回收**：本插件卸载时会 `delete globalThis.__dshClashAutovpn` 并关代理，取用方拿不到时会如实报错，
不会拿到一个「已关停但看起来可用」的实例。

## 配置

覆盖方式：在 profile 的 `cordis.patch.yml` 里用**同 id + config**（不要带 `name`/`insert`，否则会与
bundle 层撞成两条同 id 条目导致 DSH 启动失败）：

```yaml
- id: dsh-clash-autovpn
  config:
    budgetMB: 512                 # 预算改成 512MB
    autoDisableIdleMinutes: 5     # 空闲 5 分钟才关
    regionPriority: [日本, 香港, 新加坡, 美国]
    switchModeToRule: false       # 不动我的 Clash 模式
    touchSystemProxy: false       # 不碰系统代理，只接管 DSH 出站
```

| 键 | 默认 | 说明 |
|---|---|---|
| `autoEnable` | `true` | 检测到封锁是否自动开代理 |
| `autoDisableIdleMinutes` | `3` | 联网空闲多少分钟自动关 |
| `budgetMB` | `1024` | 流量预算（MB），超过即警告+暂停+询问 |
| `budgetScope` | `session` | 预算口径：`session`=**本次装载**（≈每次 DSH 启动归零，额外额度也一并归零）；`day`=当日累计（跨重启，按日期键，次日清零） |
| `regionPriority` | `[香港,日本,新加坡,台湾,美国]` | 自动选节点的地区优先序 |
| `switchModeToRule` | `true` | 开代理时临时把 Clash 切到 rule（国内直连、只有国外走节点），关时还原 |
| `touchSystemProxy` | `true` | 是否接管 Windows 系统代理（DSH 自身不依赖它） |
| `proxyUrl` | `auto` | `auto` 取控制面 `/configs` 的 `mixed-port`；也可写死 `http://127.0.0.1:7890` |
| `controller` | `auto` | `auto` 自动发现；也可写死 `127.0.0.1:9090` |
| `controllerSecret` | `null` | 控制口 secret（自动发现会从配置文件里读到） |
| `targetGroups` | `auto` | 同步切换节点的组；`auto`=所有有意义的 select 组 |
| `meterIntervalMs` | `10000` | 计量轮询间隔 |
| `speedThresholdMs` | `2500` | 经代理实测超过此值就尝试换节点 |
| `askTimeoutMs` | `120000` | 超预算询问的等待上限（超时按「停止」处理） |
| `maxAutoEnablesPerHour` | `6` | 自动开代理的频率上限，防止故障时空转 |
| `autoReactTimeoutMs` | `30000` | 单次自动反应的时间上限，超时转后台并在下一次工具结果送达结论 |

## 控制口自动发现

实测本机磁盘上有**两份** Clash 配置，其中 `~/.config/clash/config.yaml` 是过期的（写着 61993），
真正在跑的核心用 `~/.config/mihomo/config.yaml` 里的 `127.0.0.1:65027`。所以本插件做三层发现，
而不是像现成插件那样写死 9090：

1. 显式配置（`controller` / `controllerSecret`）
2. 各客户端数据目录的 `config.yaml`（mihomo / clash / clash-verge / com.vortex.helper / clash_win …）
   里的 `external-controller` + `secret`
3. 把「名字像代理的进程」真正在监听的回环端口全部列出来（`netstat` + `tasklist`），逐个带 secret 握手

第一个 `GET /version` 成功者胜出。

## 安全边界

- **开之前先存盘**：模式、各节点组当前选择、系统代理两项，都写进 `state.json`。
- **还原是精确的**：系统代理只在「当前值仍等于我们写入的值」时才还原（你或 Clash GUI 中途改过就不覆盖）；
  模式与节点选择逐个写回。
- **崩溃自愈**：下次装载时若发现 `state.json` 里 `active: true`（上次进程没来得及关），自动还原并记录。
- **卸载即关**：插件卸载钩子会关代理；关键一步（接管出站）失败时立刻回滚系统代理，不留「半开」状态。
- **回环与内网永不走代理**：由宿主的策略保证（`localhost`、`127.0.0.0/8`、`::1` 等强制直连）。

## 自测

```powershell
# 端到端（真实改动本机 Clash 与系统代理，结束必定还原基线）
$env:ELECTRON_RUN_AS_NODE='1'
$exe = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\DeepSeek Harness.exe'  # 装到别处就改成实际路径
$here = Join-Path $PWD 'dsh-clash-autovpn\test'
# ⚠ 必须用 Start-Process -Wait：DeepSeek Harness.exe 是 GUI 子系统程序，PowerShell 用 `&`
#   调用**不会等待**它，pwsh 会立刻返回，随后 harness 回收 job object 把测试进程中途杀掉
#   —— 表现为「输出到一半突然没了」，极易误判成插件崩溃。
Start-Process -FilePath $exe -NoNewWindow -Wait -PassThru -ArgumentList (Join-Path $here 'smoke.mjs')

# 装载预检（按 profile 的解析路径真正 import + 真实 defineTool + mock ctx 跑 apply）
Start-Process -FilePath $exe -NoNewWindow -Wait -PassThru -ArgumentList (Join-Path $here 'plugin-load.mjs')

# 兜底还原（把模式/节点选择/系统代理恢复成 2026-10-14 的原始基线）
Start-Process -FilePath $exe -NoNewWindow -Wait -PassThru -ArgumentList (Join-Path $here 'restore-baseline.mjs')
```

CI（`.github/workflows/ci.yml`）只跑语法检查与 `plugin-load.mjs` 装载预检：`smoke.mjs` /
`restore*.mjs` 会真实开关本机 Clash 与系统代理，只能在你自己机器上手动跑。
`test/smoke-run.log` 保留完整输出。`smoke.mjs` 实测 **26/26 通过**，覆盖：控制口发现、节点/组解析与
地区识别、单节点测速、地区优先选节点、被墙目标的 `vpn-needed` 判定（直连 ECONNRESET / 经代理 HTTP 200）、
开代理（模式切 rule、系统代理、出站接管）、经策略访问 google（204）与被墙目标（到达 GitHub）、
流量计量、运行中换节点、关闭后的还原校验、超预算暂停与 guard 否决、解除暂停并追加额度。

### 本机现场验证（2026-10-14 12:07，真实会话内）

| 步骤 | 结果 |
|---|---|
| 装载 | `12:07:24` 日志：注册 6 个工具，`autoEnable=开`、预算 1024MB/session、空闲 3 分钟（生产默认值） |
| `vpn_diagnose(https://www.google.com/)` | `vpn-needed` —— 直连 ETIMEDOUT（8019ms）、DNS `ECONNREFUSED`（污染）；经代理 HTTP 200（618ms） |
| **自动路径**：`web_fetch(google)` 失败 | 插件自动判定并开代理：🇭🇰 Air-香港06（65ms）、模式切 rule、系统代理 0→1、DSH 出站经宿主接口接管；并把「已开启，请重试」注入上下文 |
| 重试同一个 `web_fetch(google)` | **HTTP 200，拿到 Google 首页** —— DSH 自身出口确实通了 |
| 计量 | 39 秒用 **16.6 MB**（系统代理开着期间，其它程序的外网流量一并计入）、2%／1GB |
| `vpn_disable` | **独立核对**：`mode=global`、6 个节点组选择逐项与基线一致、`ProxyEnable` 回到插件动手前的 `0` |
| 发现并修掉的问题 | `vpn_status({includeLog:false})` 因返回对象含 `undefined` 字段被宿主以 “value is not lossless JSON” 拒收 → 工具出口统一过 `jsonSafe()`；新进程验证通过（运行中实例因 ESM 缓存需重启生效） |


> 测试脚本里有两条「环境坑」的注释，值得保留：① 独立进程装完出站策略后剩下的句柄全是 unref 的，
> 事件循环会被抽干导致 Node 静默 `exit(0)`（宿主进程不会），所以脚本里挂了一个 ref 的 keepalive；
> ② 上面那条 `Start-Process -Wait` 的道理。


## 与现成插件的关系

动手前评估过三个同类项目（见 `_vpn-plugin-dev/repos/` 与 npm）：

| 项目 | 取用的部分 | 没取的部分 |
|---|---|---|
| [Lunatic029/dsh-clash-proxy](https://github.com/Lunatic029/dsh-clash-proxy) | 「必须接管进程内出站」这个判断；自建 dispatcher 作为降级方案的思路 | 它把 `HTTPS_PROXY` 当常开策略、不分场景开关，也不做诊断与流量控制 |
| [xituisuany-max/dsh-clash-proxy-toggle](https://github.com/xituisuany-max/dsh-clash-proxy-toggle) | 系统代理**保存原值再还原**的写法；节点整组测速与地区优先的思路 | 它是 PowerShell + 独立 bridge 常驻的形态，控制口写死 9090，无自动判定/无流量刹车 |
| npm `dsh-clash-proxy`（elevenmoon） | —— | 它自带规则引擎与订阅解析（要重复实现 Clash 已有能力），且不含「用完自动关」与预算暂停 |

本插件的增量：**自动判定是否因墙**、**用完自动关**、**1GB 流量刹车 + 暂停 + 询问**、
**控制口三层自动发现**（对付随机端口与过期配置）。

## 已知限制

- **只在 Windows 上有完整效果**：系统代理那部分是 WinINET 注册表；DSH 出站接管与节点选择跨平台可用。
- **Clash 模式**：默认会临时切到 `rule`（省流量）。若你的订阅在 rule 模式下对目标站点分流不正确，
  可把 `switchModeToRule` 设为 `false`，但要注意 global 模式下所有流量（含国内）都会消耗订阅额度。
- **流量口径**：以 Clash 的 `/connections` 累计计数差值为准，只统计**经过 Clash 的流量**（系统代理开着时，
  其它程序的外网流量也计入——那本来就是你订阅的流量）。`session` 每次装载归零，`day` 跨重启按日期键累计；
  核心重启会让累计计数归零，本插件会重新取基线而不是记成负数。
- **询问超时按「停止」处理**：宁可不做，也不偷偷烧流量。
- **广告伪节点**：按名字里的「订阅/失效/请选/如您/如果」等关键词剔除，若你的订阅用了别的措辞，
  可能需要调整 `lib/clash.js` 的 `INFO_NODE_RE`。
