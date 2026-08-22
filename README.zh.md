# dsh-proxy

[English](README.md) | 简体中文

[![npm version](https://img.shields.io/npm/v/@karoc/dsh-proxy.svg)](https://www.npmjs.com/package/@karoc/dsh-proxy)
[![npm downloads](https://img.shields.io/npm/dm/@karoc/dsh-proxy.svg)](https://www.npmjs.com/package/@karoc/dsh-proxy)
[![license MIT](https://img.shields.io/npm/l/@karoc/dsh-proxy.svg)](LICENSE)

一个**外部** DeepSeek Harness 插件：为**模型提供方**提供带**按主机路由**的**正向代理**，并附带一个专职设置页。

它在 dsh host 进程内启动一个 loopback 正向代理，把进程的出站流量指向它（`HTTP(S)_PROXY` + `NODE_USE_ENV_PROXY`），**只把你在设置页勾选的主机**转发到可选的上游代理（HTTP / HTTPS / SOCKS5，支持可选 Basic 认证），其余全部直连。模型提供方主机从你的 dsh `settings.yaml` 读取，流量中观测到的主机也会被收集——两者都以复选框形式出现。

为什么要做成外部插件：内置设置页不覆盖出站代理，而给内置包加一页会在官方下次发布时被覆盖。本包作为可安装的 **bundle** 交付，从不触碰仓库源码，官方更新无法覆盖它。

代理引擎与设置 UI 抽取自 [karoc/dsh-desktop](https://github.com/karoc/dsh-desktop)（行为保持一致），让纯浏览器版的 `dsh web` 也能获得桌面壳原有的模型提供方代理控制。

## 它新增了什么

一个放在内置 **Models** 与 **Model reasoning** 页之后的新设置项 **「代理 / Proxy」**，包含：

- **上游代理卡片**：启用开关、协议选择（HTTP / HTTPS / SOCKS5）、主机、端口、可选用户名/密码，以及**测试连接**按钮（验证上游是否会说对应协议）；
- **模型提供方**列表——从你的 dsh `settings.yaml` 读取的主机（`llm-deepseek.baseURL`、`llm-pi-ai.providers.<n>.baseURL`、任意 `llm-*` 命名空间），有友好显示名时以显示名标注；
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
  "knownHosts": ["api.deepseek.com", "registry.npmjs.org"]
}
```

`knownHosts` 由插件写入（观测到的流量）；`upstream` 与 `proxiedHosts` 由设置页写入。你也可以在 dsh 运行中手改该文件——它是实时重读的。

## 安装

**前置要求：** 已安装带 `dsh` CLI 的 DeepSeek Harness，以及 [pnpm](https://pnpm.io)（`dsh plugin` 命令底层调用 pnpm）。这是一个可安装的 **bundle**——由 `dsh` 加载，不是当作库 import。

### 从 npm 安装（推荐）

包已发布到 npm，名为 `@karoc/dsh-proxy`：

```sh
dsh plugin --profile web add @karoc/dsh-proxy
```

安装预构建 bundle 并追加到 `web` profile。然后**重启 `dsh web`**，打开 **设置 → 代理 / Proxy**。

### 从 git 安装

```sh
dsh plugin --profile web add github:karoc/dsh-proxy#<sha>
```

git 安装会运行包的 `prepare` 脚本构建 bundle。pnpm ≥ 10 需要先放行该构建——把 pnpm 打印的包 key 复制到 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 下，再重跑 `add`（见 DSH 仓库 `docs/user/develop/basic/publish.md`）。

### 更新

用 pnpm update 升到最新版（或重 `add` 以拉取更新的 git ref）：

```sh
dsh plugin --profile web update dsh-proxy
# 或，若依赖规格被 pin 住：dsh plugin --profile web add dsh-proxy
```

然后**重启 `dsh web`** 以加载新客户端 bundle。

### 卸载

```sh
dsh plugin --profile web remove dsh-proxy
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
scripts/proxy-core.spec.mjs  # 行为测试（13 场景，无外部网络）
```

### /proxy/api 路由

host 半区用同源 HTTP 路由为设置页供数（内置 `/api` 前缀被 gateway 占用，故用 `/proxy/api`）：

- `GET  /proxy/api` → `{ upstream, proxiedHosts, knownHosts, hosts, providers, port }`
- `POST /proxy/api` `{ op: 'save', upstream, proxiedHosts }` → 清洗后持久化的配置
- `POST /proxy/api` `{ op: 'test', upstream }` → `{ ok, detail }`
- `POST /proxy/api` `{ op: 'persist' }` → 把观测主机并入 `knownHosts`

## 构建

```sh
pnpm install
pnpm bundle          # 产出 lib/index.js + lib/client.js
pnpm test            # tsc --noEmit + proxy-core.spec.mjs（13 场景）
pnpm release:check   # 发布门禁：文档/changelog/tag/工作区/构建/registry 全过
pnpm publish         # 跑门禁（prepack/prepublishOnly），随后 postpublish 验证线上发布
```

bundle 把平台包（`react`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-*`）保持 external——它们在运行时从 loader 的模块表解析；其余全部内联。

## 注意事项 / 限制

- **代理是进程级出站点，不是模型逐请求读的开关。** 它通过把进程的 `HTTP(S)_PROXY` 指向自身来实现。本插件 host `apply()` 之后 dsh 发起的请求（任何子进程、以及 global dispatcher 仍是惰性的 undici fetch）会走代理。若某个 dsh 内部 fetch 在插件加载前就已实体化了 dispatcher，可能不会走它——文档化的解法是重启 dsh（桌面壳通过 spawn dsh 前设环境变量来施加同样的边界）。
- `npm`/`pnpm` 安装/更新流量与其它一样走代理；改动**与安装/更新相关的主机**会在下次安装/更新时生效（已在进行的操作保留其环境）。
- **设置页导航图标由壳分配，插件无法自定义。** 内置 `ui-settings-general` 的 `SettingsRoot.tsx` `navIcon(id)` 只映射已知 id，其它 id（包括本节的 `dsh-proxy`）一律齿轮。`settings.section` 注册没有 icon 字段，外部插件不 patch 壳就改不了。等 DSH 开放每节图标后，本节建议用 `dsh-client-ui-primitives` 的 `IconGlobeOutline14`。
- 桌面壳（`dsh-desktop`）保留自己的代理与托盘设置窗口——本插件是独立抽取，不是替代品。两者可共存（例如把 `dsh-proxy` 装进壳的 profile，同时获得 dsh 内设置页）。

## License

[MIT](LICENSE)

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)（开发 + 发布清单）与 [CHANGELOG.md](CHANGELOG.md)（版本历史）。
