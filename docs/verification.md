# Agent Symphony 0.1.0 · dsh 验证记录

日期：2026-09-21。环境：macOS arm64，Node 24.18.0，pnpm 11.14.0。宿主基线：npm 发布的 `@deepseek-ai/dsh@0.1.6-alpha.2`、Cordis 4.0.2。

## 已验证

| 层次 | 方法 | 结果 |
| --- | --- | --- |
| 核心行为 | `pnpm test` | 35 项通过：原生 payload、调用/skill/hook 关联、未知 JSON、去重冲突、SQLite 持久化与跨连接失效、严格导入、HTTP 边界、采集队列/重试/卸载 |
| 浏览器 | `pnpm test:browser` | 7 项通过：桌面与 390px、原始证据、skill/失败筛选、配声保存、实际 Web Audio 节点调度、切换取消回放、历史静默、音频上传、有限现场模拟、每 session 视图恢复、同名同 ID 跨来源、1,005 条记录分页 |
| 宿主核心 | `pnpm test:integration` 第一段 | 真实 published Cordis Loader 加载观察器，SessionStore/Query 补采与 live append，HTTP 503 不阻止宿主 commit，有限重试与 gap，卸载清理 |
| 实际 agent turn | 同一脚本第二段 | 本地 scripted LlmAdapter 驱动实际 AgentLoop；两次模型请求，一次工具执行，一次真实 Codex bridge shell hook。经本项目 server 保存 18 条原生事件，终止原因为 `{kind:'completed'}` |
| 启动配置 | 隔离 `DSH_HOME` 的真实 dsh `--profile headless --patch ... --dump-config` | 顶层 `- insert:` 被正确组合；插件绝对路径解析为 file URL |
| 静态检查 | `pnpm check`、`git diff --check`、本地 Markdown 链接检查 | 通过 |

浏览器测试实际观察 AudioScheduledSourceNode.start 被调用，并验证切换后的历史导入没有新增调度。它验证音频功能，不替代人对音色舒适程度或听觉辨识度的评价。

## 调查发现与修复

- Node 的公开 zstd 单次解码仅消费首帧，且可接受截断前缀。导入现按 dsh 官方扫描逻辑检查完整帧，再逐帧解码；有完整的拼接帧和损坏输入测试。
- 运行中的 server 与 CLI 导入会同时访问 SQLite。缓存现用 `PRAGMA data_version` 检测外部连接写入，避免计数已更新而时间线／导出仍是旧内容。
- 未知插件的 JSON payload 不必是对象；null、数组和标量会保留，不能拒绝整批邻近事件。
- Hook 配对改为一次原生 ID 索引。10,000 条 hook 事件的本机对照，领域规范化由约 685 ms 降至约 13 ms；完整 store 在已有 10,000 条事件上追加并重建关联约 30 ms。属于本机样本，不是普遍延迟保证。
- 每个 session 保存自己的筛选、详情和滚动状态。同名同原生 ID 的来源通过 source ID 与内部 key 区分；回放不随切换恢复。

## 可查看的成果

- [桌面时间线](../outputs/dsh-workbench-desktop.png)
- [声音设置](../outputs/dsh-sound-settings.png)
- [390px 布局](../outputs/dsh-workbench-mobile.png)
- [真实宿主联调脚本](../scripts/test-dsh-integration.mjs)

当前保留运行的 4317 实例使用仓库 `.symphony/`，含 3 份标为演示的模拟记录及一份标为导入的真实 dsh 联调记录，总计 4 个 session、70 条事件。实际记录不进入 Git。

## 验证边界

没有调用远端付费模型，没有读取或修改用户的 `~/.dsh`、凭据或既有生产 profile。实际联调使用固定响应的本地模型适配器；真实 agent loop、工具和 hook shell 都由发布的 dsh 实现执行。

事件目录覆盖并不意味着每个类型均在真实 agent 样本中触发。SessionStart 与 detached subagent hook 的逐 handler 审计缺口保留；插件内存队列在进程退出时不作阻塞 flush，未送达部分仍可能丢失。详见 [接入指南](dsh-setup.md)。
