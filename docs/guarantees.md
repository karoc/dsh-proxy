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
