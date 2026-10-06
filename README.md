# MoviePilot Pi Agent

基于 TypeScript 和 Pi 的个人 Agent，新建独立项目。飞书、网页和 CLI 是可替换的 UI；MoviePilot、115 和 Jellyfin 是业务集成。

当前版本是 **技术调研与可运行验证骨架**。尚未实现真实下载、完整飞书接入或网页聊天，也尚未部署到 MoviePilot。

## 技术结论

- Agent 主体可以使用 TypeScript，直接复用 Pi SDK 的模型接入、工具循环、会话持久化、Skill 和扩展机制。
- MoviePilot 原生后端插件由 Python 加载。独立 TS 服务可以直接调用已有 MP HTTP API；只有缺失能力和 MP 内嵌入口需要小型 Python 插件。
- 飞书官方 Node SDK 支持 TypeScript、长连接和消息 API。它属于 UI 接入层，不拥有 Agent 的业务上下文。
- 会话历史、用户长期偏好和下载任务分别保存。任务真实进度通过业务接口查询或事件更新。

详细依据、边界和实施顺序见 [调研与架构](docs/research.md)。

## 本轮验证目标

1. 使用发布版 Pi SDK，而不是自写 Agent 循环。
2. 自定义业务工具能够被模型调用。
3. 按需读取项目 Skill，启动时仅广告名称与描述。
4. 同一用户的同一会话连续补充条件，并在关闭、重新打开后恢复。
5. 不同会话隔离，重复输入不重复执行，同一会话串行处理。
6. 用户偏好独立持久化，跨 UI 使用统一会话 ID。

测试使用模拟模型流和模拟 MP 响应，不消耗模型额度，不发送飞书消息，不提交下载。

本轮 TypeScript 编译与 12 项回归全部通过；模型流使用 Pi 官方 faux provider，Agent 循环、工具调用和会话恢复使用真实 SDK。

## 开发

要求 Node.js >= 22.19；依赖版本和锁文件固定。

```bash
npm ci
npm test
cp .env.example .env
# 填写明确的模型名称和 API Key 后：
npm run build
node --env-file=.env dist/src/cli.js
```

凭据、Pi 会话文件和偏好数据写入本地 `data/`，均不进入 Git。

## 项目边界

```text
src/core/           Pi 运行时、统一交互接口、持久化状态
src/integrations/   MoviePilot HTTP 客户端与业务工具
src/ui/             UI 适配器
skills/             Agent 的业务操作说明
tests/              使用真实 Pi SDK 的离线回归
docs/               调研依据与架构决策
```

正式实施首先完成：媒体身份 → 条件筛选 → 资源预览与确认 → 下载任务跟踪。真实下载必须绑定已选择的资源快照和请求 ID；不能把模型生成的文本当作已完成的任务。
