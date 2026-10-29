# dsh-plugin-tool-prefetch

DeepSeek Harness（dsh）插件：把 [agent-tool-acceleration](../mcp_prefetch_gateway)
的工具调用预测网关作为 Python sidecar 拉起，将其工具（`gw_predict_next` /
`gw_observe` / `gw_stats` / `gw_reset` + 代理的真实上游工具）**原生注册到
`ctx.tools`**——不是 MCP 服务器配置，是正经插件：在 Settings → Plugins 可见、
可启用/禁用（禁用即杀掉 sidecar）。

零 npm 依赖（纯 JS + `node:child_process`），预测由论文的 CT-GNN 模型提供
（CPU，~15 ms/次）。

## 这个仓库包含什么 / 不包含什么

**本仓只有"桥"（约 8 KB JS）**，不含预测、采集、训练的实现——它们在配套的
网关项目 [agent-tool-acceleration](https://github.com/Liman-cmd/agent-tool-acceleration)：

| 能力 | 在哪 | 本仓有吗 |
|---|---|---|
| 插件壳（拉起 sidecar、原生注册工具、转发调用）| `index.js`（本仓）| ✅ |
| 预测（CT-GNN / markov 冷启动）| 网关 `mcp_prefetch_gateway/` | ❌ 需配套项目 |
| 数据采集（step 事件 → 遥测）| 网关 `server.py` + `telemetry.py` | ❌ 需配套项目 |
| 训练 / 再训（飞轮）| `scripts/retrain_gateway.py` + `src/train.py` | ❌ 需配套项目 |

**因此：只装本插件跑不起来。** 完整依赖见下节。

## 安装

### 完整依赖（缺一不可）

| 依赖 | 说明 |
|---|---|
| 网关项目 | `agent-tool-acceleration` 检出（**目前私有**，需权限）|
| Python 环境 | `.venv` + `pip install -r requirements.txt`（torch 等，CPU 版即可）|
| **模型产物** | `data/processed/model_*.pt` + `graph_*.pkl`（**被 gitignore，不在任何仓里**）|
| **轨迹文件** | `data/processed/trajectories_*.jsonl`——⚠️ 不只是训练用：网关启动时要拿它拟合 BM25 词表 |
| τ-bench 环境 | `data/raw/tau-bench`（真实零售数据库，`git clone https://github.com/sierra-research/tau-bench`）|

有权限的人 → 跑 `scripts/setup_gateway.ps1` 一条命令备齐环境。

### 装插件

```powershell
# 从 GitHub（推荐）
npx @deepseek-ai/dsh plugin --profile web add github:Liman-cmd/dsh-plugin-tool-prefetch

# 或本地路径（开发）
npx @deepseek-ai/dsh plugin --profile web add ./dsh-plugin-tool-prefetch

# 重启 dsh web；Settings → Plugins 里应出现 tool-prefetch
npx @deepseek-ai/dsh web
```

> ⚠️ 本插件未附带预训练模型的可分发形态。换成**你自己的工具场景**时，retail 模型
> 不适用——需要用你自己的数据重训（见"数据飞轮"），或先跑 `markov` 冷启动模式
> （`predict.mode: markov`，零训练即可用）。

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
- **数据飞轮**：所有真实调用自动落遥测 `step` 事件。查看采集进度：
  `python -m mcp_prefetch_gateway.cli status --config <gateway yaml>`（会告诉你
  距首次可训还差几条轨迹、按近期速率预计几天）；攒够后
  `python scripts/retrain_gateway.py ...` 一键再训换模型。

  **要不要训 GNN？** 先看任务类型（论文结论）：短流程、无上下文依赖的任务，
  `markov` 计数通常就够了，GNN 未必更好；多轮、上下文相关的任务 GNN 才显著领先。
  所以对很多场景，"自己的模型"这个目标本身是多余的——计数版已随使用变准。
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
