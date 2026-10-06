# 思磨力代理插件（Smoothly Proxy）

[English](README.md) | 简体中文

[![npm version](https://img.shields.io/npm/v/@karoc/dsh-proxy.svg)](https://www.npmjs.com/package/@karoc/dsh-proxy)
[![npm downloads](https://img.shields.io/npm/dm/@karoc/dsh-proxy.svg)](https://www.npmjs.com/package/@karoc/dsh-proxy)
[![license MIT](https://img.shields.io/npm/l/@karoc/dsh-proxy.svg)](LICENSE)

**思磨力代理插件**（**Smoothly Proxy** / 思磨力）是一个**外部** DeepSeek Harness 插件：为**模型提供方**提供带**按主机路由**的**正向代理**，并附带一个专职设置页。

它在 dsh host 进程内启动一个 loopback 正向代理，把进程的出站流量指向它（`HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY`），**只把你在设置页勾选的主机**转发到可选的上游代理（HTTP / HTTPS / SOCKS5，支持可选 Basic 认证），其余全部直连。模型提供方主机**实时**读自正在运行的 dsh 配置，流量中观测到的主机也会被收集——两者都以复选框形式出现。

为什么要做成外部插件：内置设置页不覆盖出站代理，而给内置包加一页会在官方下次发布时被覆盖。本包作为可安装的 **bundle** 交付，从不触碰仓库源码，官方更新无法覆盖它。

代理引擎与设置 UI 抽取自 [karoc/dsh-desktop](https://github.com/karoc/dsh-desktop)（行为保持一致），让纯浏览器版的 `dsh web` 也能获得桌面壳原有的模型提供方代理控制。

## 它新增了什么

一个新的设置项 **「思磨力代理 / Smoothly Proxy」**（导航顺序 25），排在内置 **Models** 页以及（若装了该插件）外部 **Model reasoning** 页之后，包含：

- **上游代理卡片**：启用开关、协议选择（HTTP / HTTPS / SOCKS5）、主机、端口、可选用户名/密码，以及**测试连接**按钮（SOCKS5 上游走 SOCKS5 握手、HTTP 上游走 `CONNECT` 探测；HTTPS 上游只验证 TCP 可达——不校验其 TLS 握手）；
- **模型提供方**列表——**实时**读自正在运行的 dsh 配置的主机（`llm-deepseek.baseURL`、`llm-pi-ai.providers.<n>.baseURL`、任意 `llm-*` 命名空间），有友好显示名时以显示名标注。取值来自 harness 自己的 settings 文档，因此列表跟着运行中的配置走，与 dsh 把文档放在哪里无关；仍在用 0.2 之前 `<DSH_HOME>/settings.yaml` 的 harness 会回退读那个文件。loopback 端点不会出现——它们永远不可能被代理；
- **其它已观测主机**列表——代理在流量中见过的主机（含 `registry.npmjs.org` 等安装/更新流量），持久化进 `proxy.json` 以跨重启保留；
- **搜索框**——输入时按主机 / 名称过滤上面两个列表。

勾选主机即让该主机走上游代理。保存会写入 `<DSH_HOME>/proxy.json`；运行中的代理**每个请求都重读该文件**，因此改动立即生效——无需重启 dsh。

### 代理如何路由流量

```
dsh host 进程
  ├─ undici fetch（模型请求、联网搜索）──┐
  ├─ npm / pnpm / git / 子 CLI ──────────┤  HTTP(S)_PROXY → loopback 代理
  └─ 子代理 ─────────────────────────────┘        │
                                                   ▼
                            127.0.0.1:<随机>  forward proxy（裸 net/http）
                                                   │
                            ┌──────────────────────┴──────────────┐
                            ▼                                     ▼
                    在 proxiedHosts 中的主机                  其它一切
                    + 上游已启用                         DIRECT（loopback 恒直连）
                            │
                            ▼
                    上游代理（HTTP/HTTPS/SOCKS5，可选 Basic 认证）
```

安全规则（硬编码，不可配置）：

- **loopback 目标恒直连**——绝不发给上游代理；
- 指向本代理自身的上游被当作**禁用**（防自环保护）；
- 代理自身只用裸 `net`/`http`，所以永远不可能把自己出站连接再路由回自己。

### 配置文件

```
<DSH_HOME>/proxy.json     # $DSH_HOME，默认 ~/.dsh
```

```json
{
  "upstream": { "enabled": false, "protocol": "http", "host": "", "port": 0, "username": "", "password": "" },
  "proxiedHosts": ["api.deepseek.com"],
  "knownHosts": ["api.deepseek.com", "registry.npmjs.org"],
  "listenPort": 45999
}
```

`knownHosts` 由插件写入（观测到的流量）；`upstream`、`proxiedHosts` 与 `listenPort` 由设置页写入（`listenPort` 重启后生效；`0` 表示随机端口）。`listenPort` 是本插件**监听**的地址，**不是上游地址**——上游地址属于 `upstream`；把它填成上游自己的端口会导致绑定失败并回退到临时端口。你也可以在 dsh 运行中手改该文件——它是实时重读的。

## 安装

**前置要求：** 已安装带 `dsh` CLI 的 DeepSeek Harness，以及 [pnpm](https://pnpm.io)（`dsh plugin` 命令底层调用 pnpm）。这是一个可安装的 **bundle**——由 `dsh` 加载，不是当作库 import。

### 从 npm 安装（推荐）

包已发布到 npm，名为 `@karoc/dsh-proxy`：

```sh
dsh plugin --profile web add @karoc/dsh-proxy
```

安装预构建 bundle 并追加到 `web` profile。然后**重启 `dsh web`**，打开 **设置 → 思磨力代理 / Smoothly Proxy**。

### 从 git 安装

```sh
dsh plugin --profile web add github:karoc/dsh-proxy#<sha>
```

git 安装会运行包的 `prepare` 脚本构建 bundle。pnpm ≥ 10 需要先放行该构建——把 pnpm 打印的包 key 复制到 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 下，再重跑 `add`（见 DSH 仓库 `docs/user/develop/basic/publish.md`）。

### 更新

用 pnpm update 升到最新版（或重 `add` 以拉取更新的 git ref）：

```sh
dsh plugin --profile web update @karoc/dsh-proxy
# 或，若依赖规格被 pin 住：dsh plugin --profile web add @karoc/dsh-proxy
```

然后**重启 `dsh web`** 以加载新客户端 bundle。

### dsh 自己的请求（模型调用）会自动走本代理

本代理有两类客户端，接线方式不同：

- **子进程**（bash、npm、pnpm、git、curl…）继承本插件写进环境的 `*PROXY` 变量——无需配置；
- **dsh 自己的请求**（模型调用、web fetch/search）由 harness 的出网策略决定，而该策略是 dsh **在启动时、早于任何插件**从启动环境解析的。当启动环境没有声明代理时，本插件会在自己的监听就绪后**自己装上同一条策略**并指向本端口（见 `src/egress.ts`）——无需任何配置。

设置 → 思磨力代理会明说当前属于哪一种：

- **已路由（自装）**——常态：模型流量按上面的主机勾选逐台分流。监听端口是插件自己挑的临时端口：**没有任何需要配置的东西**，诊断面板（默认折叠，只在需要你注意时才展开）只是把端口报出来便于排查；
- **已路由（启动环境）**——你的启动环境声明了 `HTTP_PROXY=http://127.0.0.1:<listenPort>`，dsh 在插件之前就装好了策略；把 `listenPort`（`proxy.json`）固定成某个端口，这个地址才能跨重启保持稳定；
- **出网归启动环境的另一个代理管**——启动环境声明了**别的**代理。本插件**故意不覆盖**它（本插件的代理会把未勾选主机直连，覆盖上去等于静默绕过启动方的策略）。想让 dsh 自己的请求也按本插件分流，就把启动环境指向本代理，或删掉那个变量；
- **不可用**——当前组合里解析不到 harness 的策略包（少见的布局）。页面会打印可直接粘贴的 `Environment=` 行作为兜底，其它功能不受影响。

### 卸载

```sh
dsh plugin --profile web remove @karoc/dsh-proxy
```

同时从 `web` profile 移除依赖与 bundle 层。重启 `dsh web` 后该设置项消失。

## 目录结构

```
cordis.patch.yml      # bundle 层：挂一行让 client-modules 服务发现（dsh.client manifest）
package.json          # dsh.bundle (patch) + dsh.client (web) + exports["./client"]
tsdown.config.ts      # 自包含构建：node 半区 + 模块表客户端 bundle
src/proxy-core.ts     # 前向代理引擎（HTTP+CONNECT、SOCKS5/HTTPS 上游、按主机路由、
                      # 实时配置、测试探针）—— dsh-desktop scripts/proxy.mjs 的 TS 移植
src/index.ts          # host apply：起代理、设 *PROXY 环境变量、注册 /proxy/api（GET 视图 / POST save·test·persist）
src/client/index.ts   # client apply：注册 settings.section（id dsh-proxy）
src/client/ProxySection.tsx  # 设置页（上游卡片 + 主机列表）
src/client/styles.ts  # design-token 样式（--dsw-alias-*）+ 注入
src/client/locales.ts # en/zh 文案
scripts/*.spec.mjs    # 行为测试：proxy-core.ts（13 场景）+ host route / client
                      # boot / cordis mount，全程无外部网络
```

### /proxy/api 路由

host 半区用同源 HTTP 路由为设置页供数（内置 `/api` 前缀被 gateway 占用，故用 `/proxy/api`）：

- `GET  /proxy/api` → `{ ok, upstream, proxiedHosts, knownHosts, hosts, providers, port }`
- `POST /proxy/api` `{ op: 'save', upstream, proxiedHosts }` → 清洗后持久化的配置
- `POST /proxy/api` `{ op: 'test', upstream }` → `{ ok, detail }`
- `POST /proxy/api` `{ op: 'persist' }` → 把观测主机并入 `knownHosts`

## 构建

```sh
pnpm install
pnpm bundle          # 产出 lib/index.js + lib/client.js
pnpm typecheck        # tsc --noEmit
pnpm test             # node --test：proxy-core（13 场景）+ host-route /
                      # client-boot / cordis-mount，无外部网络
pnpm release:check   # 发布门禁：文档/changelog/tag/工作区/构建/registry 全过
pnpm publish         # 跑门禁（prepack/prepublishOnly），随后 postpublish 验证线上发布
```

bundle 把平台包（`react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-*`）保持 external——它们在运行时从 loader 的模块表解析；其余全部内联。

## 注意事项 / 限制

- **代理是进程级出站点，不是模型逐请求读的开关。** 它通过把进程的 `HTTP(S)_PROXY` 指向自身来实现。本插件 host `apply()` 之后 dsh 发起的请求（任何子进程、以及 global dispatcher 仍是惰性的 undici fetch）会走代理。若某个 dsh 内部 fetch 在插件加载前就已实体化了 dispatcher，可能不会走它——文档化的解法是重启 dsh（桌面壳通过 spawn dsh 前设环境变量来施加同样的边界）。
- `npm`/`pnpm` 安装/更新流量与其它一样走代理；改动**与安装/更新相关的主机**会在下次安装/更新时生效（已在进行的操作保留其环境）。
- **SOCKS5 上游只承载 HTTPS 目标。** SOCKS5 没有 absolute-URI 的 HTTP 模式，因此选中的纯 `http://` 主机会退回直连（设置页也写明了这一点）。
- **设置页导航图标由壳分配，插件无法自定义。** 内置 `ui-settings-general` 的 `SettingsRoot.tsx` `navIcon(id)` 只映射已知 id，其它 id（包括本节的 `dsh-proxy`）一律齿轮。`settings.section` 注册没有 icon 字段，外部插件不 patch 壳就改不了。等 DSH 开放每节图标后，本节建议用 `dsh-client-ui-primitives` 的 `IconGlobeOutlineRegular`。
- **本节自 v0.1.4 起要求 dsh ≥ 0.1.7（0.1.2–0.1.6 请用 v0.1.3）。** DSH 0.1.7 改了图标导出名（`IconX14` → `IconXRegular`，尺寸后缀并入 artwork 默认值、名字改为承载笔画权重；上游 commit `4937343a5e`），本节现在导入 `*Regular` 变体。该下限已声明为对 `@deepseek-ai/dsh-client-ui-settings` 的**可选 peer 依赖**，由 dsh ≥ 0.1.7 的兼容门禁按运行时版本判定（不匹配则拒绝加载该 bundle，并给出 `dsh plugin allow-version` 的具体解法）。0.1.7 之前的 dsh 没有这道门禁，仍会加载本插件并渲染出坏掉的分区——那些运行时请用 v0.1.3。
- **需以官方方式安装才生效。** loader entry 名、bundle 注册 id、host 插件名三者均为 `@karoc/dsh-proxy`（与 npm 包名一致）。手写 `link:` 依赖只有在包管理器把它落到 profile 的 `node_modules` 下、且 profile 的 `dsh.profile.bundles` 列出它之后才算数——请用 `dsh plugin --profile web add @karoc/dsh-proxy`（npm）或 `dsh plugin --profile web add link:/path/to/dsh-proxy`（源码）安装，然后重启 `dsh web`。
- 桌面壳（`dsh-desktop`）保留自己的代理与托盘设置窗口——本插件是独立抽取，不是替代品。两者可共存（例如把 `dsh-proxy` 装进壳的 profile，同时获得 dsh 内设置页）。

## License

[MIT](LICENSE)

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)（开发 + 发布清单）与 [CHANGELOG.md](CHANGELOG.md)（版本历史）。
