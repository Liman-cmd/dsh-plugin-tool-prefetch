# 拦截器探针（v2 验证）

用一次探针实测，回答三个决定架构的问题：

1. **dsh 会触发 `tools/pre-execute` / `tools/result` 钩子吗？**（文档只给了类型签名，没给注册示例）
2. **`exec.agent` 里有什么？能不能拿到用户消息文本？**（决定 interceptor 模式能否采全信号）
3. **有没有 agent/session 事件能直接给用户输入？**（第二条获取路径）

## 怎么跑（3 步）

```powershell
# ① 把插件配置的 mode 改成 probe
notepad "$env:USERPROFILE\.dsh\profiles\web\cordis.patch.yml"
#    在 tool-prefetch 那行下把 mode: 'tools' 改成 mode: 'probe'

# ② 重启 dsh
npx @deepseek-ai/dsh web

# ③ 在对话里让它调一两个工具（例如查订单），然后看日志
Get-Content D:\code\my_job\agent-tool-acceleration\mcp_prefetch_gateway\logs\probe.log -Tail 20
```

## 怎么读结果

| 看到 | 含义 | 下一步 |
|---|---|---|
| `pre_execute` 行 + `userTextFound: true` + `userTextFrom: agent.session.messages[n]` | ✅ 钩子可用**且**能拿用户消息 | interceptor 采全信号，我用这个路径实现 |
| `pre_execute` 行 + `userTextFound: false` | ✅ 钩子可用，但 agent 没暴露 messages | 看 `agentDeep` 里有什么；退用 `both` 模式补用户消息 |
| 有 `agent_event` 行 | ✅ 有别的路径能拿用户输入 | 改用事件监听补信号 |
| 只有 `probe_start`，无 `pre_execute` | ❌ 钩子没触发 | 我换注册方式（`ctx.tools.xxx` 挂载 / 换事件名）|
| 没有 probe.log | ❌ 插件没重载 | 看 dsh 启动日志找 `[tool-prefetch]` 报错 |

## 探针的安全保证

- **纯观察**：`next()` 原样透传（本地实测 0ms），不改任何调用行为
- **不 spawn sidecar**（probe 模式不依赖 Python，python 路径错了也能跑）
- **写日志有 try/catch**：钩子内部任何异常都不会影响工具执行
- **深挖有边界**：对象遍历限深 4 层、每层限 40 键、检测循环引用

## 关键日志字段说明

```jsonc
{
  "event": "pre_execute",
  "name": "get_order_details",          // 工具名
  "args": { "order_id": "#W5918442" },  // 参数
  "hasAgent": true,
  "agentKeys": ["id", "session"],       // agent 顶层属性名
  "userTextFound": true,                // ★ 是否找到用户消息
  "userTextFrom": "agent.session.messages[1]",  // ★ 从哪找到的
  "userText": "I want to cancel ...",   // ★ 用户消息原文
  "agentDeep": { ... }                  // 首次调用时的完整结构快照
}
```
