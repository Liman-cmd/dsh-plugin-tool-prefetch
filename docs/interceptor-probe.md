# 拦截器探针（v2 验证）—— 结论已定稿

用一次探针实测，回答三个决定架构的问题。三个问题现已全部有答案，roster 保留作复现记录。

## 答案

| 问题 | 结论 | 证据 |
|---|---|---|
| dsh 会触发 `tools/pre-execute` / `tools/result` 吗？ | ✅ **会**。两个钩子都触发，`next()` 透传耗时 0–1ms | `probe.log` 的 `pre_execute` / `result` 各一条；`interceptor-smoke.mjs` 实测 0ms |
| `exec.agent` 里有什么？ | `agent.id`（会话标识，如 `session-2b6a8f43-…`）、`agent.session.log`（事件数组）、`agent.session.derived`、`agent.options.{provider,model}` | probe.log 的 `agentId` / `sessionKeys` |
| 能拿到用户消息吗？ | ✅ **能**，但不是从 `messages[]`，而是从 **`agent.session.log[]`** 的 `user/message` 事件 | 下面第 3 节 |

## 1. 用户消息在哪

`agent.session.log` 是**全量 surface 事件数组**，与磁盘上的
`%USERPROFILE%\.dsh\sessions\<cwd>\<session-id>\session.v4.jsonl.zstd` 同源。真人输入长这样：

```jsonc
{ "type": "user/message", "seq": 27, "time": 1793278646222,
  "data": {
    "role": "user",
    "source": { "kind": "user", "rpcId": "…", "clientTimeZone": "Asia/Shanghai" },
    "content": [ { "type": "text", "text": "读一下 …/AGENTS.md 的前 10 行" } ]
  } }
```

## 2. 陷阱：注入内容也是 `role: "user"`

同一个 session 里这些事件的 `type` 和 `role` **完全一样**，只有 `source.kind` 不同：

| seq | type | role | `data.source.kind` | 内容 |
|---|---|---|---|---|
| 9 | `user/message` | user | **`user`** | ← 真人输入 |
| 10 | `user/message` | user | `agent-instructions` | AGENTS.md 注入 |
| 11 | `user/message` | user | `runtime-context` | 运行时快照 |
| 12 | `user/message` | user | `skill-catalog` | skill 列表 |
| 13 | `user/message` | user | `time-context` | 时间上下文 |

**只按 `role === 'user'` 过滤会拿到系统提醒。** 且注入种类会随 dsh 加功能而增加——
所以实现用**白名单**：只有 `source.kind === 'user'` 才算真人输入（`isHumanTurn()`）。
回退分支只在事件完全没有 `source` 时才看 `role`（兼容手造的旧日志）。

## 3. 怎么复现这次验证

```powershell
# ① 让插件配置走 probe
#    自有 cordis.patch.yml 里 mode: 'probe'（当前生效值）

# ② 重启 dsh
npx @deepseek-ai/dsh web

# ③ 在对话里调一个工具，然后看日志
Get-Content D:\code\my_job\agent-tool-acceleration\mcp_prefetch_gateway\logs\probe.log -Tail 3
```

`pre_execute` 行应含：

```jsonc
{
  "event": "pre_execute", "n": 1, "v": 3, "name": "read",
  "agentId": "session-2b6a8f43-…",
  "sessionUserFound": true,
  "sessionUserFrom": "agent.session.log[28]",
  "sessionUserKind": "user",
  "sessionUserText": "读一下 D:\\…\\AGENTS.md 的前 10 行",
  "sessionProbes": { "log": { "len": 39, "sampleTypes": ["assistant/message", "step/end", "turn/end"] } }
}
```

> 离线复现不需要起 dsh：`node dsh-plugin-tool-prefetch/session-extract-test.mjs`
> 直接解压 `session.v4.jsonl.zstd` 的**多帧 zstd**，把真实事件喂给同一提取器并断言
> 找到真人输入、拒绝注入内容（不带参数时自动取最新的 session 日志）。

## 4. 探针的安全保证

- **纯观察**：`next()` 原样透传（实测 0ms），不改任何调用行为
- **不 spawn sidecar**（probe 模式不依赖 Python，python 路径错了也能跑）
- **写日志有 try/catch**：钩子内部任何异常都不影响工具执行
- **属性访问有 try/catch**：`session` 上的 getter 抛异常也不崩（已单测）
- `probe-local.mjs` 跑完会删掉 probe.log，避免污染真实运行

## 5. 这些结论用在哪

`index.js` 的 `SessionScope.userMsgFor()` 在 interceptor / both 模式下调用同一套
`isHumanTurn()` + `extractUserText()`，把用户文本随 `gw_predict_next` / `gw_observe`
一起送给网关（结果见 `interceptor-smoke.mjs`：`user_msg` 逐 step 送达且无注入泄漏）。
按 agent.id 缓存、仅在 log 长度变化时重扫，避免每次工具调用都遍历整个事件数组。
