# TypeScript 与 Pi 接入调研

调研日期：2026-10-06。项目位于 WSL `/home/tsutomu/workspace/MoviePilot-PiAgent`。

## 结论

采用独立 TypeScript Agent 服务，直接嵌入 Pi SDK。飞书是 UI 适配器之一；MoviePilot 是业务后端。先复用 MP 原生 HTTP API，按需增加小型 Python 插件，避免在 MP 插件里安装 Node 并管理子进程。

最初创建技术验证骨架，验证发布版 SDK 的能力与边界。2026-10-07 已完成独立服务、三个 UI、媒体/115 业务链与 Python 桥接源码；线上机器人尚未替换，测试不调用真实模型或提交下载。

## 已查证的技术边界

| 项目              | 证据                                                                                                              | 决策                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Pi TypeScript SDK | 官方 SDK 支持 Node/Bun 进程内调用，自定义工具、资源加载器和持久会话                                               | 直接使用 SDK，不通过终端界面驱动                |
| Pi 发布包         | npm 官方注册表：`@earendil-works/pi-coding-agent@1.0.4`，Node >= 22.19；旧 `@mariozechner/pi-coding-agent` 已弃用 | 锁定 1.0.4 和 lockfile，不混用旧 namespace 示例 |
| MP 原生插件后端   | `_PluginBase` 为 Python 抽象基类；`ModuleHelper` 使用 Python importlib 加载插件                                   | 纯 TS 后端不能作为原生插件直接安装              |
| MP 前端           | 原生插件提供 vue 渲染模式；与后端语言限制独立                                                                     | 后续可以提供 TS/Vue 内嵌入口                    |
| 飞书              | 官方 `@larksuiteoapi/node-sdk` 支持 TS、消息 API、WSClient                                                        | 飞书接入使用独立 UI 模块，统一生命周期          |
| 运行环境          | WSL 实测 Node 22.23.1                                                                                             | 可以运行发布版 SDK                              |

官方来源：

- [Pi SDK](https://pi.dev/docs/latest/sdk)
- [Pi 发布包与引擎限制](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/package.json)
- [npm Pi 注册表](https://registry.npmjs.org/@earendil-works%2fpi-coding-agent)
- [MP 插件基类](https://github.com/jxxghp/MoviePilot/blob/v2/app/plugins/__init__.py)
- [MP 模块加载器](https://github.com/jxxghp/MoviePilot/blob/v2/app/helper/module.py)
- [飞书 Node SDK](https://github.com/larksuite/node-sdk)

## Pi 各层的选择

| 选项                  | 收益与边界                                                               | 本项目选择                                         |
| --------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| pi-agent-core         | 轻量工具循环、状态和输入队列；Skill 发现、会话存储等仍需自行装配         | 初版不直接以此为主体                               |
| pi-coding-agent SDK   | 已装配 Skill、会话管理、上下文压缩和扩展；可以指定业务工具集合           | 本轮验证并采用                                     |
| Pi Durable            | 持久化会话与任务、SQLite/JSONL、恢复未完成提交；工具需声明是否可安全重放 | 后续长任务阶段单独评估，不把两套运行时同时接进初版 |
| pi-server / pi-client | 官方实验性服务与多 UI 会话附件机制；服务管理及业务协议仍由应用提供       | 暂不作为第一版服务协议依赖                         |
| RPC 子进程            | 可以由 Python 驱动 Pi，适合过渡                                          | 增加进程生命周期与协议管理，优先独立 TS 服务       |

第一版限制为项目业务工具和限定范围的 Skill 读取工具。SDK 默认的通用文件写入和 Bash 工具不启用。Skill 本身是说明，下载确认、资源身份检查和重复提交防护由业务代码执行。

发布版 SDK 实测：默认 Skill 提示与内置 read 工具绑定。使用受限的 `read_skill` 工具时，本项目复用资源加载器发现 Skill，并显式把名称与描述放入提示；完整正文仅在工具调用后进入上下文。自定义工具使用 SDK 的参数校验和执行循环。

来源：[Skills](https://pi.dev/docs/latest/skills)、[Extensions](https://pi.dev/docs/latest/extensions)、[Durable](https://github.com/earendil-works/pi/tree/main/packages/durable)、[实验性 Server](https://github.com/earendil-works/pi/tree/main/packages/server)、[RPC](https://pi.dev/docs/latest/rpc)。

## 实际 MoviePilot 接入

通过现有用户授权进行只读探测，并从运行中的 MP 读取实际路由源码。确认媒体搜索接口要求 title，正在下载接口返回成功，CloudAutoSearch 手动推送状态接口可访问。线上 OpenAPI 未开放，采用实际源码核对请求结构；未发起真实下载。

| 能力         | 实际接口                                            | 注意事项                                         |
| ------------ | --------------------------------------------------- | ------------------------------------------------ |
| 搜索媒体     | `GET /api/v1/media/search?title=...`                | 保存来源、媒体 ID、类型、年份，避免只取第一项    |
| 精确搜索资源 | `GET /api/v1/search/media/{mediaid}`                | 支持来源前缀 ID、季等参数；保存本次响应快照      |
| 模糊搜索资源 | `GET /api/v1/search/title?keyword=...`              | 无 keyword 会取站点首页资源，不用于健康检查      |
| 提交下载     | `POST /api/v1/download/`                            | 传媒体与资源对象；返回 download_id               |
| 查询正在下载 | `GET /api/v1/download/`                             | 不包含所有已完成、入库、可播放状态               |
| 115 链接提交 | `POST /api/v1/plugin/CloudAutoSearch/manual_submit` | 已有插件可复用；成功表示受理或提交，不代表完成   |
| 115 提交状态 | `GET /api/v1/plugin/CloudAutoSearch/manual_status`  | 目前保存最新手动批次，Agent 需留存自己的请求记录 |

MP 的 `/search/last` 和 `/search/last/context` 使用全局最近搜索缓存。新 Agent 不以它们作为某个用户的权威搜索结果，使用自己的会话资源快照。

MP 已有内置 Agent 和 Web 会话接口。Pi 直接调用媒体/下载业务接口，不把整段聊天交给第二个 Agent 处理，避免再次出现两套上下文和任务生命周期。

MP 公共源码：[媒体 API](https://github.com/jxxghp/MoviePilot/blob/v2/app/api/endpoints/media.py)、[搜索 API](https://github.com/jxxghp/MoviePilot/blob/v2/app/api/endpoints/search.py)、[下载 API](https://github.com/jxxghp/MoviePilot/blob/v2/app/api/endpoints/download.py)。

## 多 UI 与状态

统一输入包含 requestId、已认证用户 ID、conversationId、文本或结构化交互。UI 把平台用户映射成核心用户，不允许模型决定归属。输出包含文本、候选项、确认请求、工具进度和任务状态，各 UI 自行渲染。

- 用户偏好按用户保存，跨 UI 共享；一次性条件属于当前任务。
- 会话按用户和 conversationId 隔离；从另一个 UI 继续需要明确选择同一 conversationId。
- 同一会话串行；不同会话可以独立处理。引用消息和卡片变化不创建新的会话。
- 消息 requestId 去重。收到消息后快速确认接收，长时间模型处理留在 Agent 队列。
- 下载任务绑定真实资源快照和后端任务 ID；阶段至少区分待确认、已提交、下载中、下载完成、已入库。
- 重启恢复会话不等于重复下载安全。后端执行结果不确定时先核对任务，不能自动重放提交请求。

## 记忆

会话由 Pi SessionManager 保存。用户偏好和业务任务采用 SQLite 结构化存储；初版无需向量数据库。明确的“以后默认……”才写长期偏好，并保留修改来源。

任务状态来自业务后端，不从会话摘要推断。Pi Durable 的恢复功能也不能替代 115 或下载器对外部请求的去重与结果核对。

## 最初的实施顺序

1. 本轮：创建独立项目，验证真实 Pi SDK、Skill、工具调用、连续消息、隔离与恢复；提供 CLI 骨架和 MP 只读工具。
2. 首条业务链：准确选择媒体 → 结构化筛选 → 资源快照预览 → 确认下载 → 查询后端进度。
3. 接飞书 UI；测试快速接收、重复事件、连续条件补充、旧卡片、连接关闭与重连。
4. 接 115 路由和完成/入库状态；再提供网页 UI 与 MP 内嵌入口。

是否采用 Durable、原生事件桥和完整 UI 协议，依据第 2 阶段实际需要决定。先把单 Agent 的一条业务链跑通。

## 初始技术验证（历史记录）

使用 npm 发布版 Pi 1.0.4 的 ModelRuntime、SessionManager、DefaultResourceLoader 和官方 faux provider，执行离线模型流；不是模拟整个 Agent 实现。

回归覆盖业务工具完整调用、Skill 按需读取、连续条件补充、不同 UI 共用会话、用户/会话隔离、重启恢复、重复事件去重、模型中断后不自动重放、单实例目录所有权及停止后的迟到消息。飞书 1.74.0 发布包的 LarkChannel、发送/流式方法和 disconnect 生命周期可导入并通过离线验证；尚未测试真实网络连接、消息和卡片。

TypeScript 编译与 12 项回归全部通过。Node 22.23.1 的内置 SQLite 会显示实验性提示；当前骨架可运行，正式运行环境与 SQLite 驱动仍需在部署阶段固定。CLI 是开发入口；后台 HTTP 服务、网页与完整飞书适配器尚未实现。MP Bearer Token 当前由环境传入，正式接入需补登录续期或专用桥接认证。

## 正式实现

已按上述顺序完成 Fastify 服务、React/Vite/TanStack Query 网页、Feishu LarkChannel 适配器、共享 HTTP CLI、媒体资源与订阅工具、独立结构化偏好、原子确认和实际任务跟踪。SQLite 改用 Drizzle + better-sqlite3，并增加 MP 登录续期和版本化迁移。

当前架构和验证命令以 README.md、architecture.md 为准。初始骨架的 12 项测试是历史结果；完整回归包含真实 Pi 工具循环、HTTP、飞书上下文、资源筛选、提交确认和状态证据，另有浏览器与 Python FastAPI 桥接测试。真实网络飞书连接和生产下载留待部署联调。
