# dsh-plugin-tool-prefetch

DeepSeek Harness（dsh）插件：把 [agent-tool-acceleration](../mcp_prefetch_gateway)
的工具调用预测网关作为 Python sidecar 拉起，将其工具（`gw_predict_next` /
`gw_observe` / `gw_stats` / `gw_reset` + 代理的真实上游工具）**原生注册到
`ctx.tools`**——不是 MCP 服务器配置，是正经插件：在 Settings → Plugins 可见、
可启用/禁用（禁用即杀掉 sidecar）。

零 npm 依赖（纯 JS + `node:child_process`），预测由论文的 CT-GNN 模型提供
（CPU，~15 ms/次）。

## 安装

前置：本机有 agent-tool-acceleration 检出 + `.venv`（torch CPU 已装）+ 训练产物
（`data/processed/model_*.pt` / `graph_*.pkl`）。

```powershell
# 本地路径安装（开发/自用）
npx @deepseek-ai/dsh plugin --profile web add ./dsh-plugin-tool-prefetch

# 或从 GitHub（发布后）
npx @deepseek-ai/dsh plugin --profile web add github:<user>/dsh-plugin-tool-prefetch

# 重启 dsh web；Settings → Plugins 里应出现 tool-prefetch
npx @deepseek-ai/dsh web
```

## 配置

插件默认值写在 `cordis.patch.yml`（指向本仓库路径）。换机器/换配置：把该行
拷进你的 profile patch（`~/.dsh/profiles/web/cordis.patch.yml`）改值：

```yaml
- insert:
  - id: tool-prefetch
    name: dsh-plugin-tool-prefetch
    config:
      python: 'D:\path\to\.venv\Scripts\python.exe'
      repoRoot: 'D:\path\to\agent-tool-acceleration'
      gatewayConfig: 'mcp_prefetch_gateway/configs/tau_retail_gpt4o_real.yaml'
      toolPrefix: ''          # 注册名前缀，避免与其他插件重名
      initTimeoutMs: 60000    # sidecar 冷启动预算（torch+模型 ~20s）
      callTimeoutMs: 120000
```

## 行为要点

- **冷启动异步**：sidecar 启动 ~20 s，不阻塞 dsh；工具就绪后自动出现。
- **真实执行 + 自动对账**：代理工具真调上游（默认 τ-bench retail 真实数据库），
  每次调用自动写入 session 状态并对账上一条预测（`_gateway.session_id` 可选携带）。
- **数据飞轮**：所有真实调用自动落遥测 `step` 事件，攒够后
  `scripts/retrain_gateway.py` 一键再训换模型。
- **与 MCP 配置互斥**：若之前在 `cordis.patch.yml` 配过 `mcp-prefetch`
  （dsh-mcp-client 行），装本插件前删掉那行，避免 21 个工具注册两遍。

## 排障

| 症状 | 处置 |
|---|---|
| 工具一直不出现 | dsh 日志找 `[tool-prefetch]`；多半是 python 路径/产物路径错 |
| 验证 sidecar 本身 | `node dsh-plugin-tool-prefetch/smoke.mjs`（不起 dsh 全链自测）|
| 想换预测模型 | 改 `gatewayConfig` 指向别的 `configs/*.yaml` |

## 许可

MIT。预测器与数据来自本仓库论文项目（τ-bench 数据为 Sierra 官方开源实现）。
