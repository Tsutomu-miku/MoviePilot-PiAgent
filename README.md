# MoviePilot Pi Agent

使用 Pi SDK 的 TypeScript 个人媒体助手。网页、飞书和 CLI 共用同一个 Agent 核心；MoviePilot 提供搜索、下载、订阅和媒体库能力，115 复用已有的 RSS 离线下载插件。

第一版已实现媒体搜索、条件筛选、资源预览与确认、MP/115 提交、下载与入库跟踪、原生订阅管理、长期偏好，以及三个 UI。模型固定为一个明确配置的 provider/model，不包含免费模型池或自动切换。

## 使用流程

1. 搜索媒体，选择正确的年份、类型和季号。
2. 搜索资源，继续补充清晰度、声道、音频、字幕、片源、容量、做种数或排除条件。
3. 选择资源和 MP/115 目的地，核对预览后确认。
4. 在任务页面查看实际进度。“已提交”“下载完成”“已入库”分别显示。

已有磁力链接或公开种子下载链接可直接使用“粘贴链接到 115”。支持每批 1–20 个链接，使用原有插件保存目录，不支持本地文件上传。

“本次要 4K”保留在当前会话；“以后默认 4K”才保存为长期偏好。网页偏好页可修改或清除默认条件。

## 运行

要求 Node.js **22.23.1 或更新版本**。推荐在现代 Linux 或提供的 Debian Bookworm 容器中运行，SQLite 驱动版本固定为 better-sqlite3 13.0.3。

```bash
npm ci
cp .env.example .env
# 填写访问令牌、明确的模型配置和 MoviePilot 凭据
npm run build
npm start
```

默认网页地址为 `http://127.0.0.1:8787`，用 `.env` 中的 `WEB_AUTH_TOKEN` 登录。开发使用 `npm run dev`，Vite 将 `/api` 转发到本地服务。

环境变量从项目根目录的 `.env` 加载。默认业务数据保存在根目录 `data/`。凭据、Pi JSONL 会话和 SQLite 数据均不进入 Git。

保留你已有的 npm 镜像和代理设置。项目不写死 registry，不替换模型端点。Node 使用 `--use-env-proxy`；飞书 WebSocket 使用相同的 HTTPS/HTTP 代理。配置 `NO_PROXY` 以直连 MoviePilot 等局域网服务。

自定义 OpenAI 兼容服务使用 `AGENT_BASE_URL`、`AGENT_PROVIDER`、`AGENT_MODEL`、`AGENT_API_KEY`；其实际上下文和输出限制由环境变量明确配置。Pi 原生 provider 可使用环境变量 API Key 或持久的 `data/pi/auth.json`，完整自定义模型配置也可放在 `data/pi/models.json`。

### Docker

```bash
docker compose up -d --build
```

Compose 使用 `.env` 和持久卷 `agent-data`。容器以 `node` 用户运行，端口 8787，数据位于 `/app/data`。镜像基于 Debian Bookworm。

构建时可以使用自己的 npm 配置：`docker build --secret id=npmrc,src=/你的路径/.npmrc .`。HTTP 代理按 Docker 自身的配置传入构建，不在 Dockerfile 中设置外部地址。

## MoviePilot 桥接插件

MP 原生插件仍由 Python 加载。`plugins.v2/piagentbridge` 只提供网页入口和缺失的查询/解析 API，不在 MP 进程内启动 Node。

将该目录复制到 MP 的 `/app/app/plugins/piagentbridge`，重载插件后在配置页启用并填写 Agent 网页地址。若仓库可被 MP 插件市场访问，也可按其常规市场流程使用 `package.v2.json`。私有仓库采用目录挂载或复制方式。

- `download_states` 查询指定 hash 的实际进度，包含已完成任务。
- `resolve_links` 复用 `CloudAutoSearch` 的种子解析方法，不提交下载。
- 两个接口都由 MP 的 Bearer 认证保护。

115 路由需要已有 **CloudAutoSearch 1.1.0 或更新版本**完成登录和保存目录配置，并需要 **P115StrmHelper** 查询实际离线任务。磁力链接可在 Agent 本地解析 BTIH；公开 torrent URL 通过桥接解析。需要站点 Cookie 的私有种子 URL 不作为公开链接推送到 115。

## 飞书和 CLI

开启 `FEISHU_ENABLED`，配置应用凭据和允许使用的用户 `open_id`。群聊还需填写群 ID 白名单，并 @机器人。应用使用长连接，需订阅消息事件和卡片交互事件，开通消息发送、消息读取以及 CardKit 流式卡片权限。

飞书按 `chat_id + sender open_id` 保存当前会话绑定。回复根消息和卡片变化不会生成新会话。

- `/new`：新建会话。
- `/sessions`：列出会话。
- `/use <conversationId>`：继续网页或其他 UI 的已有会话。
- `/tasks`、`/subscriptions`：查看任务和 MP 原生订阅。
- `/help`：查看命令。

网页侧可查看会话 ID（侧栏会话的提示）。旧会话卡片必须先显式切回原会话；旧搜索结果不能确认新的资源。

```bash
npm run cli -w @mp-pi/api
# 指定已有会话：
AGENT_CONVERSATION_ID=会话UUID npm run cli -w @mp-pi/api
```

CLI 连接同一个 HTTP 服务，不另起一个拥有相同数据目录的 Agent。`AGENT_URL` 可指定服务地址。

## 开发与验证

```bash
npm run format
npm run format:check
npm run lint
npm run check
npm test
npm run build
npx playwright install chromium
npm run test:e2e
python -m pip install -r requirements-dev.txt
ruff check plugins.v2 tests/python
ruff format --check plugins.v2 tests/python
python -m unittest discover -s tests/python -v
```

测试通过真实 Pi SDK 的官方 faux provider 执行工具循环和恢复逻辑，使用假 MP 后端和假飞书传输。浏览器测试连接完整 Fastify 服务和构建后的 React 页面。测试不调用真实模型、不发送飞书消息、不提交实际下载。

```text
apps/api/src/core/          Pi 会话、请求队列、持久化和工具执行上下文
apps/api/src/capabilities/  Skill、偏好、媒体和任务工具集合
apps/api/src/domain/        强类型资源、筛选与链接解析
apps/api/src/services/      搜索快照、确认与任务跟踪
apps/api/src/integrations/  MoviePilot 外部协议边界
apps/api/src/http/          Fastify API 与认证
apps/api/src/ui/            飞书适配器、卡片与事件缓冲
apps/api/skills/            按需加载的操作说明
apps/web/                  React + Vite + TanStack Query
packages/contracts/        两端共享的 Zod 协议与 SSE 解码
plugins.v2/piagentbridge/   小型 MP Python 桥接
```

新增能力应在 `capabilities/` 注册声明参数的工具，复用 Pi 执行循环；业务写操作由服务层执行确认和去重。新增 UI 只实现统一事件适配和认证映射，不维护另一份模型历史。Prettier、ESLint 与 Ruff 保持展开、可读的格式；不以减少代码行数为目标。

## 状态边界

提交超时、服务在提交中中断或后端确认格式不完整时，任务进入“待核对”，不会自动重试。相同请求 ID 只执行一次，确认按任务原子认领，已提交资源也禁止重新创建相同提交。

115 按准确 BTIH 跟踪整个批次，不能拿插件“最新一次提交”的结果替换另一个批次。下载器任务消失不能证明下载完成。媒体库原本已有内容，也不能证明本次下载已入库。

单个数据目录由一个服务实例独占。部署更新前关闭旧服务并备份完整 `data/`（SQLite 与 Pi 会话一起备份）。对“待核对”任务在 MP/115 后端人工确认，避免再次下载。

原生订阅管理不包括米柑 RSS；此项目不改变现有 STRM 生成、MP 整理或 Jellyfin 扫描配置。完成到入库的延迟取决于这些现有流程。播放链接只表示媒体库入口，未执行真实播放探测。

源码与离线链路已经实现；真实模型、飞书权限及生产下载仍需在部署环境完成联调。调研依据和架构取舍见 [research.md](docs/research.md)，协议和状态规则见 [architecture.md](docs/architecture.md)。
