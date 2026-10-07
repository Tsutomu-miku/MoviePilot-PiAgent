# 添加 Agent 能力

Pi 负责模型工具循环和会话。Skill 按需提供业务流程；工具负责声明参数；服务处理业务规则；后端适配器校验外部协议；网页与飞书展示同一份结果。

以 MP 整理维护为例：

- `skills/moviepilot-maintenance/SKILL.md` 描述查询、修正识别、选择、预览、确认和核对结果的步骤。
- `capabilities/moviepilot.ts` 注册 `get_transfer_failures`、`identify_transfer_records` 和 `prepare_transfer_retry`。工具没有任意 URL、文件路径或命令参数。
- `services/transfer-service.ts` 保存当前查询页和识别提案，限制选择范围，调用 MP 的真实预览并排除重复源文件。
- `TaskService` 复用统一确认入口，逐条保存整理批次结果。提交结果不确定时保留待核对状态。
- `integrations/transfers.ts` 声明外部协议，`MoviePilotClient` 只在边界验证响应。
- Python 桥接通过 MP 的公开 `TransferChain.manual_transfer` 接口执行。提交前重新核对原记录与预览，目录和命名由 MP 规划。
- `packages/contracts` 定义统一结果和用户操作。网页组件与飞书卡片使用相同 ID 和确认令牌。

新增只读查询时，先确认目标 MP 版本的真实接口，在适配器中声明响应类型，再注册工具。工具应返回完成任务所需的事实，避免把凭据、完整文件对象或原始后端负载交给模型。

新增写操作时，定义提案内容、实际执行结果以及不确定状态。复用后续确认和持久化规则，先实现预览和去重，再实现执行。调用失败不能自动换一套协议或再次执行。批量操作要保存每个条目的结果，不能把部分失败显示为整批完成。

最后添加 Skill、代表性端到端测试和必要的 UI。测试使用真实 Pi SDK 的 faux provider 及假后端；生产验证只查询和预览，实际业务写操作由用户选择并确认。
