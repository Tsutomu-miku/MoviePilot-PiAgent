# MoviePilot Pi Agent

使用 Pi SDK 的 TypeScript 个人媒体助手，以普通 MoviePilot 插件安装和管理。网页、飞书和 CLI 共用同一个 Agent 核心；MoviePilot 提供搜索、下载、订阅和媒体库能力，115 复用已有的 RSS 离线下载插件。

第一版已实现媒体搜索、条件筛选、资源预览与确认、MP/115 提交、下载与入库跟踪、原生订阅管理、长期偏好，以及三个 UI。模型固定为一个明确配置的 provider/model，不包含免费模型池或自动切换。

## 使用流程

1. 搜索媒体，选择正确的年份、类型和季号。
2. 搜索资源，继续补充清晰度、声道、音频、字幕、片源、容量、做种数或排除条件。
3. 选择资源和 MP/115 目的地，核对预览后确认。
4. 在任务页面查看实际进度。“已提交”“下载完成”“已入库”分别显示。

已有磁力链接或公开种子下载链接可直接使用“粘贴链接到 115”。支持每批 1–20 个链接，使用原有插件保存目录，不支持本地文件上传。

动画可以使用“蜜柑搜索”，或在对话中要求 Agent 搜索蜜柑。插件使用 MP 中启用的 MiKan / 蜜柑计划站点及其代理设置，直接按中文、原名或别名查询公开搜索 RSS，不经过媒体识别和 PT 资源匹配。可按字幕组、分辨率和字幕筛选，网页勾选资源后预览并确认推送到 115。返回数量代表本次 RSS 的条目，不代表站点全部资源。

Agent 选择蜜柑资源使用 `m1`、`m21` 等短引用，服务端映射到保存的种子 ID。同一搜索的引用在各页和重启后保持一致；更新搜索会使旧引用失效。网页和飞书按钮继续使用原有资源 ID。

“技能”页支持查看内置 Skill、新建个人 Skill、编辑和启用/停用。编辑内置技能会保存为个人版本，插件升级保留它。内容使用标准 `SKILL.md`，包含 `name`、`description` 和操作说明；实际业务能力由已有工具提供。启用后 Agent 可按需读取，也可点击“在对话中使用”明确选择。修改在下一轮生效，保留原有会话历史，网页和飞书共享同一用户的技能。个人文件位于 `agent-data/personal-skills/`，按用户隔离。

“本次要 4K”保留在当前会话；“以后默认 4K”才保存为长期偏好。网页偏好页可修改或清除默认条件。

网页对话按 Pi 的内容顺序显示模型返回的思考、中间回复和工具调用，完成后保存，刷新可继续查看。思考默认可见，可逐段折叠；工具行显示执行状态，展开后查看输入和结果。旧会话中保存的 Pi 过程也会按对应轮次恢复。正文支持 Markdown、列表和表格。搜索卡片默认显示摘要，点击展开操作；任务资源及整理明细默认收起，确认与取消按钮保持可见。浏览历史时，新输出不会强制跳到底部。

## 在 MoviePilot 安装

1. 把 `https://github.com/Tsutomu-miku/MoviePilot-PiAgent` 加入 MP 插件市场。
2. 安装 **Pi Agent 媒体助手**。
3. 在插件配置中填写一个明确的 Provider、模型 ID 和 API Key；自定义服务填写原有端点。
4. 启用并保存。首次启动自动下载经过 SHA-256 校验的 Node 与依赖，后续启动复用缓存。
5. 从插件状态页点击“打开 Pi Agent”。网页复用 MP 管理员登录，无需另一个访问令牌。

无需 SSH、单独 Docker 容器、额外端口映射或重复填写 MP 账号密码。插件通过 MP 自带 API Token 调用业务接口，沿用 MP 的 HTTP 代理和 GitHub 镜像设置。

当前 Release 提供 Linux x64 运行时，在 Debian 12 / MP 2.15.6 环境验证。运行时仍是一个由插件托管的 Node 进程；禁用插件时不运行。首次下载约 85 MiB，不在 MP 容器内执行 npm 安装或编译。`runtimes/` 保存带版本的运行时，`agent-data/` 保存 SQLite 和 Pi 会话，均位于 MP 的插件持久数据目录。

模型配置保存到 MP 插件配置；内部访问令牌仅供容器内通信，不放进网页、URL 或浏览器存储。插件停用、重载和 MP 正常关闭都会停止子进程；MP 意外退出后，Node 的父进程监测也会关闭服务。启动失败显示错误，不无限重启或自动重新提交下载。

## 单独运行（开发或独立部署）

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

## MoviePilot 接口

MP 原生插件由 Python 加载。`plugins.v2/piagentbridge` 管理版本化运行时、子进程和网页代理，同时提供业务查询接口。Agent 不占用 MP 的 Python 请求线程执行模型循环。

- `download_states` 查询指定 hash 的实际进度，包含已完成任务。
- `resolve_links` 复用 `CloudAutoSearch` 的种子解析方法，不提交下载。
- `mikan_search` 使用已配置站点的地址和代理读取公开搜索 RSS。
- 业务接口由 MP 的 Bearer 认证保护。
- `/ui/` 与其网页 API 使用 MP 资源 Cookie 的管理员认证；写请求校验同源，流式响应不缓冲。
- Node 仅监听容器内 `127.0.0.1:8787`，网页始终走 MP 已有端口。

115 路由需要已有 **CloudAutoSearch 1.1.0 或更新版本**完成登录和保存目录配置，并需要 **P115StrmHelper** 查询实际离线任务。磁力链接可在 Agent 本地解析 BTIH；公开 torrent URL 通过桥接解析。需要站点 Cookie 的私有种子 URL 不作为公开链接推送到 115。

## 飞书和 CLI

MP 整理维护可在对话中说“查询最近的整理失败记录”。`moviepilot-maintenance` Skill 指导 Agent 查询失败原因、使用媒体搜索结果修正识别、补充季集号，再预览所选记录。网页支持勾选多条，飞书可直接说明记录 ID。确认一次后逐条执行，任务列表保留每条记录的完成、未受理或待核对结果。重启或超时不会自动重新整理可能已经转移的文件。

`core/system-prompt.ts` 只保留助手身份、工具事实与业务执行边界。Skill 说明业务工具的使用方式，回复话术和对话安排由 Agent 决定。

网页和飞书流式展示正文与执行进度，结果卡片在本轮完成后展示，确认卡片放在相关结果之后。同轮取消或替换的预览不会发出确认卡片。网页使用稳定消息 ID 衔接流式回复和历史记录，刷新时不重复插入卡片。飞书按聊天排队完成整轮正文与卡片投递，卡片关联对应的正文消息，后续回复、命令和任务通知不会插入这一轮中间。

媒体识别失败时，应先确定正确片名、年份和季集；重复原条件不一定解决问题。预览使用 MP 实际规划的目标名称，整理目录与规则由 MP 决定。整理完成不表示媒体服务器已经扫描完成。

扩展 MP 能力的开发步骤见 [adding-capabilities.md](docs/adding-capabilities.md)。Skill 保存业务流程说明；带类型的工具和服务实现实际能力。

在插件配置页启用飞书，填写应用凭据和允许使用的用户 `open_id`。使用同一个应用时，先停用旧 FeishuBot。群聊还需填写群 ID 白名单，并 @机器人。应用使用长连接，需订阅消息事件和卡片交互事件，开通消息发送、消息读取以及 CardKit 流式卡片权限。单独运行时使用 `.env` 中的 `FEISHU_*` 配置。

飞书后台的两个页签需要分别配置：在“事件与回调 → 事件配置”订阅 `im.message.receive_v1`；在“回调配置”选择长连接，并添加新版卡片回传交互 `card.action.trigger`，然后发布应用版本。只有消息订阅时，机器人能收到文字，按钮仍会提示未配置回调。参考[飞书长连接回调说明](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address)。

已有预览可以回复“立即执行吧”或“确认下载这 12 集到 115”等明确指令。过期预览允许重新创建。115 RSS 定时任务忙碌时，确认提交会等待最多两分钟；只有后端明确表示尚未受理时才继续尝试，结果不确定的请求保持待核对状态。后端返回的具体拒绝原因会保留在任务记录中。

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
ruff check plugins.v2 tests scripts
ruff format --check plugins.v2 tests scripts
python -m unittest discover -s tests/python -v
npm run package:plugin
python tests/runtime_process.py work/plugin-release/stage
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

`npm run package:plugin` 生成市场插件 ZIP、包含 Node 的平台运行时和校验清单。打包使用本机已经通过测试的 SQLite 原生模块，并验证打包后的 Pi 与 SQLite 可加载；生产环境不现场构建依赖。插件版本与运行时版本独立，ZIP 使用源码中固定的运行时版本和校验值。

发布新的运行时时，将运行时上传到其版本对应的 `PiAgentBridge_v版本` Release，并将生成的校验清单保存到插件源码目录后重新打包 ZIP。仅修改 Python 插件的补丁只发布新的 ZIP，保留原运行时清单，复用用户已下载的运行时。

新增能力应在 `capabilities/` 注册声明参数的工具，复用 Pi 执行循环；业务写操作由服务层执行确认和去重。新增 UI 只实现统一事件适配和认证映射，不维护另一份模型历史。Prettier、ESLint 与 Ruff 保持展开、可读的格式；不以减少代码行数为目标。

## 状态边界

提交超时、服务在提交中中断或后端确认格式不完整时，任务进入“待核对”，不会自动重试。相同请求 ID 只执行一次，确认按任务原子认领，已提交资源也禁止重新创建相同提交。

115 按准确 BTIH 跟踪整个批次，不能拿插件“最新一次提交”的结果替换另一个批次。下载器任务消失不能证明下载完成。媒体库原本已有内容，也不能证明本次下载已入库。

单个数据目录由一个服务实例独占。部署更新前关闭旧服务并备份完整 `data/`（SQLite 与 Pi 会话一起备份）。对“待核对”任务在 MP/115 后端人工确认，避免再次下载。

原生订阅管理不包括米柑 RSS；此项目不改变现有 STRM 生成、MP 整理或 Jellyfin 扫描配置。完成到入库的延迟取决于这些现有流程。播放链接只表示媒体库入口，未执行真实播放探测。

源码与离线链路已经实现；真实模型、飞书权限及生产下载仍需在部署环境完成联调。调研依据和架构取舍见 [research.md](docs/research.md)，协议和状态规则见 [architecture.md](docs/architecture.md)。
