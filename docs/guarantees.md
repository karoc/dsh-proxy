# Negative guarantees (pinned by assertions)

Every row below is a promise this plugin makes to the user. The third column is
the **assertion label** that pins it: `scripts/check-guarantees.mjs` fails
`npm test` if the label disappears from `scripts/*.spec.mjs`, so a guarantee
cannot be silently dropped and an assertion cannot be deleted while its promise
stays in the docs. (The routing guard once matched only the literal `127.0.0.1`
while the README promised "loopback always direct"; the assertion meant to pin
it passed for the wrong reason — this file exists so that cannot recur silently.)

| id | guarantee | pinned by |
|---|---|---|
| G1 | loopback 目标**恒直连** —— 即使它被显式列进 `proxiedHosts`，也绝不发往上游代理 | `loopback host is always direct even when listed` |
| G2 | loopback 是**整个 `127.0.0.0/8`**，不是只有字面 `127.0.0.1`（历史缺陷：`127.0.0.2` 会被转发） | `loopback is the whole 127/8 block, not only 127.0.0.1` |
| G3 | **未列入** `proxiedHosts` 的 host 永不走上游（即使上游开着） | `unlisted host is direct` |
| G4 | 上游指向**本代理自身端口**时按禁用处理（自环防护，避免代理套自己） | `upstream pointing at this proxy port is disabled (self-loop guard)` |
| G5 | loopback 流量**永不**到达上游（端到端观察，不只是路由判定） | `upstream never sees loopback traffic` |
| G6 | loopback **永不**进入观测列表 / 不写进 `proxy.json` 的 `knownHosts` | `loopback never lands in knownHosts` |
| G7 | 被禁用的上游**永不**代理任何流量 | `disabled upstream never proxies` |
| G8 | 上游不可达时**快速失败**，不让请求挂住 | `dead upstream fails fast (no hang)` |
| G9 | 未知配置操作返回 **400**，不被当成有效写入 | `unknown op 400` |
| G10 | 配置里**多余的键被丢弃**，不落盘、不回显 | `extra key dropped (sanitized)` |
| G11 | 未知协议收敛为 `http`、端口钳到 `65535`（不产生非法配置） | `unknown protocol collapses to http; port clamps to 65535` |
| G12 | SOCKS5 上游只承载 HTTPS/CONNECT 目标；纯 `http` 目标**退回直连**而不是发错协议 | `http target with socks5 upstream falls back to direct` |
| G13 | loopback 的**提供方主机永不作为代理目标出现**（勾选也永远不会生效——路由恒直连），live/legacy 两条路径一致 | `loopback provider hosts are never offered as proxy targets` |
| G14 | 提供方列表以**实时 settings 文档**为准；存在遗留 `settings.yaml` 时也不会用它覆盖 live（防止陈旧数据复活） | `live settings document wins over a stale legacy settings.yaml` |
| G15 | settings 读取**失败或服务缺席**时 `/proxy/api` 仍返回 200 并回退到 legacy 文档，不把设置页打挂 | `a throwing settings read keeps GET /proxy/api at 200` |
| G16 | 固定监听端口被占用时**回退到随机端口并显式报告**（`portHonored:false` + 日志点名该端口），绝不静默让启动环境指向空端口 | `requested listen port taken -> falls back and reports it` |
| G17 | 「进程内流量走了本代理」**只在启动环境确实指向本监听端口**时为真——别的目标、别的端口、没有启动代理都判否，观测到的主机再多也不影响 | `launch proxy pointing elsewhere is not in-process routing` |
| G18 | 启动环境**已声明代理**时，插件绝不 layer/抢占 egress（本插件的代理把未勾选主机直连，覆盖上去等于静默绕过启动方的策略） | `a launcher-declared proxy is never displaced by the plugin` |
| G19 | 自装 harness 出网策略**失败必须显式报告**（页面给出启动环境兜底），绝不把"没装上"当成"已代理" | `an unresolvable policy package is reported as unavailable` |
| G20 | 未固定端口时**采纳启动环境声明的 loopback 端口**（那是启动方期望本代理所在的地址）；非 loopback 或非法值绝不采纳 | `adoption recognises the loopback spellings` |
| G21 | 「除勾选外全部走上游」模式下语义**显式反转**：未勾选主机走上游、勾选主机直连；上游禁用或 loopback 目标仍然不代理 | `except-listed: an unchecked host goes upstream` |
| G22 | 无法识别的 `routeMode` 一律收敛为**默认（只代理勾选）**，绝不因为坏值变成"全部走上游" | `an unknown route mode falls back to only-listed, never to all-upstream` |
| G23 | IPv6 字面量在**任何拼写**下都按 loopback 归类（`::1` / `[::1]` / `::ffff:127.0.0.1`，含 Node 归一化后的 `::ffff:7f00:1`）；且 `proxiedHosts` 匹配走归一化形态——列了 `[::1]` 也拦得住 `::1` 目标 | `every loopback spelling is loopback:` |
| G24 | CONNECT 的 `[v6]:port` 只把方括号当 authority 语法：`[::1]` 目标恒直连**且不留下 `[` 这种垃圾主机名**，远端 IPv6 目标走上游时保留方括号形式 | `a bracketed loopback CONNECT never reaches the upstream` |
| G25 | SOCKS5 上游对 IPv6 目标使用 **ATYP=4 + 16 字节地址**（压缩写法、全写、内嵌 IPv4、zone id 都能展开），绝不把 IPv6 字面量当域名发出去 | `socks5: IPv6 target is sent as ATYP=4 with 16 address bytes` |
| G26 | 「清空观测列表」**同时清空会话内已观测集合**——否则下一次持久化会把刚清掉的条目写回 `proxy.json`（按钮看起来"没生效"） | `forgetHosts clears the live set so the next persist cannot write the cleared hosts back` |
