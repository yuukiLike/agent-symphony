# 接入 dsh

当前适配器面向 `@deepseek-ai/dsh@0.1.6-alpha.2` / Cordis 4.0.2。它是可由 dsh Loader 加载的 ESM 插件，订阅已提交的 `session/event`。插件不执行 hook、不修改工具结果、不向 agent 发指令；声音由浏览器独立处理。

## 运行与配置

需要 Node.js 24 或更新版本。在本仓库运行 `pnpm install`、`pnpm start`。服务默认监听 `http://127.0.0.1:4317`，终端或界面的接入信息会给出完整的 `endpoint`、绝对路径 `tokenFile` 与 `pluginPath`。只填写 token 文件路径，不把 token 内容复制到 dsh 配置里。

最方便的方式是在「接入与覆盖」页复制生成的命令；服务已在自己的数据目录写好 `dsh-observer.generated.patch.yml`。或者运行 `pnpm start setup-dsh --out ./symphony.patch.yml` 生成独立文件。两种方式都不修改 dsh 的现有配置。

也可以手动新建自己的 `symphony.patch.yml`，替换下面两个绝对路径：

```yaml
- insert:
    - id: agent-symphony
      name: '/absolute/path/agent-symphony/adapters/dsh.mjs'
      config:
        endpoint: 'http://127.0.0.1:4317/api/ingest'
        tokenFile: '/absolute/path/symphony-data/ingest.token'
        instanceId: 'my-laptop-dsh'
```

`instanceId` 标识一个 dsh 来源，重启时保持不变；不同机器或独立安装用不同值。相同来源、session ID、seq 的重发会由记录器去重。把插件插入 profile 的根级，才能观察该 `sessions` 服务下的父子 sessions；不要插入某个单独 agent 的局部插件树。

先验证组合配置，再用你的 profile 正常启动。例如官方 `headless` profile：

```sh
dsh --profile headless --patch ./symphony.patch.yml --dump-config
dsh --profile headless --patch ./symphony.patch.yml '你的任务'
```

也可把 `headless` 换成你已使用的 `web`、`acp` 或自定义 profile。`--profile`、`--patch` 等 launcher 参数放在任务或应用参数之前。`--dump-config` 只组合配置，不启动 agent；完整输出可能包含你已有配置的内容，不应公开分享。此版本 help 中的 `tui` 是自定义 profile 示例，干净安装没有名为 `tui` 的官方模板。

接入需要 dsh 加载这个插件；网页无法注入一个从未加载插件的现有进程。插件加载后会读已活跃 sessions 的可见历史，新事件继续以现场记录送达。停用时去掉这次 `--patch`，或在支持动态配置的宿主里卸载对应 Loader entry。

## 实际覆盖与开销

- 同步回调只保存宿主提供的不可变引用到有界队列。JSON 编码、token 文件读取、HTTP 与重试在后续定时任务中发生；`session/event` 回调不等待网络，也不注册可能否决创建的 `session/created`。
- 默认每 100 ms 尝试一批，至多 100 个排队项、512 KiB 请求；队列最多 2,000 项，单事件上限 128 KiB。事件首次请求失败后最多重试 3 次；每次请求超时 1 秒，重试退避上限 5 秒。采集工作仍消耗少量同进程 CPU/内存，并非零开销。
- 失败后继续记录 agent 的执行；队列满、事件过大、重试耗尽会形成 gap。恢复连接后，保留下来的 gap 会送达界面。gap 聚合最多 256 个 session/reason 组合，超过上限或不可投递的异常 metadata 会写宿主诊断日志；这个内存队列不是持久消息代理。进程退出或插件卸载不会等待网络，会丢弃未送达数据并记日志。
- 每 5 秒空批心跳表示观察器在线，不能据此推断 agent 正在执行。每秒发现新活跃 session；没有事件且生存时间小于扫描间隔的 session 可能未被发现。
- 通过可选 `sessionQuery.observeSession(..., { projectionMode: 'none' })` 只读补采活跃 session，使用完释放 observation。每个 session 最多补最近 1,000 条，较早部分记 `backfill-limit`。没有 query 服务时，等待至多 5 秒后报告历史不可用，现场采集照常。不会打开冷 session、恢复执行或生成补完事件。
- 补采截止 seq 在首次发现时固定；此前的记录标 `historical: true`，现场 append 标 `false`。补采与现场传输可交错，记录器按原生 seq 展示；历史补采不发现场音。
- 透传原生 header、事件 type/seq/time/data，包括未知类型。hook 声音只有收到对应审计事件才会触发；dsh 的 SessionStart、部分 detached subagent hook 不提供逐 handler 审计。详见 [dsh 证据备忘录](research/platforms/dsh.md)。
- 插件只接受 loopback HTTP endpoint，禁止 redirect。原始事件经本机 HTTP 送入记录器后，由记录器的保存策略脱敏；不要把原始事件误认为已经在 dsh 插件内清洗。

可在 `config` 中覆盖：`flushIntervalMs`、`heartbeatMs`、`discoveryIntervalMs`、`maxQueueEvents`、`batchSize`、`maxEventBytes`、`maxBatchBytes`、`maxRetries`、`requestTimeoutMs`、`retryDelayMs`、`backfill`、`maxBackfillEvents`、`backfillWaitMs`。通常保留默认值即可；`backfill: false` 会明确记录历史未采集。

## 可复现的真实宿主验证

单元测试不需要 dsh：

```sh
node --test test/dsh-adapter.test.mjs
```

集成脚本使用真实 npm 发布的 Cordis Loader、dsh SessionStore、SessionQuery 和 AgentLoop，在隔离目录创建测试 session，不读取 `~/.dsh`、模型凭据或用户历史。模型响应由本地 scripted `LlmAdapter` 固定提供，工具执行、hook shell 与 agent 驱动均使用真实发布的宿主实现；没有外部模型请求或费用。准备独立依赖目录：

```sh
mkdir -p /tmp/agent-symphony-dsh-runtime
cd /tmp/agent-symphony-dsh-runtime
printf '{"private":true,"type":"module"}\n' > package.json
pnpm add --ignore-scripts @deepseek-ai/cordis@4.0.2 @deepseek-ai/dsh@0.1.6-alpha.2 @deepseek-ai/dsh-session@0.1.6-alpha.2 @deepseek-ai/dsh-scope@0.1.6-alpha.2 @deepseek-ai/dsh-session-query-sqlite@0.1.6-alpha.2
```

回到本仓库运行：

```sh
SYMPHONY_DSH_RUNTIME=/tmp/agent-symphony-dsh-runtime node scripts/test-dsh-integration.mjs
```

脚本包含两层真实宿主验证：

1. 真实 Loader 加载 ESM，已有活跃 session 只读补采，真实 append 事件与父子 metadata 保留，HTTP 503 时 commit 继续且重试有界，恢复后 gap 送达，卸载后监听和定时器停止。这部分使用测试 HTTP 接收端控制故障条件。
2. 真实 AgentLoop 收到用户消息，向本地 scripted provider 请求两次，实际调用一次 `symphony_probe` 工具。真实 `dsh-hooks-codex`、`dsh-bash-local`、`dsh-subprocess-local` 执行 `PreToolUse` 的 `printf '{}'` hook，退出码为 0。适配器经 `/api/ingest` 送到本项目 `src/server.mjs`，保存了 18 条原生事件，包含工具、hook 调用与结果；实际 `turn/end` 原因是 `{kind: 'completed'}`。

这是实际 agent turn 的离线联调，未运行用户生产 profile，也未验证外部模型服务。可选设置 `SYMPHONY_DSH_EVIDENCE=/absolute/path/turn.symphony.json` 保存这次真实 turn 的 Symphony 导出；source 标为 `dsh 实测 · 本地 scripted provider`，与演示数据区分。

另外已使用隔离 `DSH_HOME`、真实 dsh bin 的 `--profile headless --patch ... --dump-config` 验证上述 YAML 组合，绝对插件路径会解析为 `file:///.../adapters/dsh.mjs`。

验证基线与 API 来源见 [dsh 研究](research/platforms/dsh.md)；实现入口为 [adapter](../adapters/dsh.mjs)，复现脚本为 [integration script](../scripts/test-dsh-integration.mjs)。
