import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from app.chain.download import DownloadChain
from app.core.config import settings
from app.core.plugin import PluginManager
from app.core.security import verify_resource_token
from app.log import logger
from app.plugins import _PluginBase
from app.schemas import TokenPayload
from fastapi import Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import PluginConfig
from .hosted import proxy_request
from .runtime import ManagedRuntime, RuntimeInstaller
from .transfers import (
    TransferPreviewRequest,
    TransferRetryRequest,
    preview_transfer,
    record_details,
    retry_transfer,
)


class ResolveLinksRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    links: List[str] = Field(min_length=1, max_length=20)


class DownloadStatesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hashes: List[str] = Field(min_length=1, max_length=100)
    downloader: Optional[str] = None


class PiAgentBridge(_PluginBase):
    plugin_name = "Pi Agent 媒体助手"
    plugin_desc = "安装、配置和管理 Pi 媒体助手；网页、飞书共用同一个会话核心。"
    plugin_icon = "ChatGPT_A.png"
    plugin_version = "1.2.2"
    plugin_author = "Tsutomu-miku"
    author_url = "https://github.com/Tsutomu-miku"
    plugin_config_prefix = "piagentbridge_"
    plugin_order = 30
    auth_level = 1
    _runtime = None
    _configuration_error = ""

    def init_plugin(self, config: Optional[dict] = None):
        self.stop_service()
        self._runtime = None
        self._enabled = False
        self._configuration_error = ""
        try:
            values = PluginConfig.model_validate(config or {})
        except ValidationError as error:
            issues = error.errors(include_input=False, include_url=False, include_context=False)
            self._configuration_error = "；".join(issue["msg"] for issue in issues)
            logger.error("Pi Agent 配置已保存，未启动：%s" % self._configuration_error)
            return
        self._config = values
        self._enabled = values.enabled
        data_dir = self.get_data_path()
        installer = RuntimeInstaller(
            Path(__file__).parent, data_dir, settings.PROXY, settings.GITHUB_PROXY
        )
        self._runtime = ManagedRuntime(data_dir, installer, lambda error: logger.error(error))
        if values.enabled:
            environment = values.agent_environment()
            environment.update(
                {
                    "MOVIEPILOT_URL": "http://127.0.0.1:%s%s/"
                    % (settings.PORT, settings.API_V1_STR),
                    "MOVIEPILOT_API_KEY": settings.API_TOKEN,
                    "NO_PROXY": ",".join(
                        filter(
                            None,
                            [
                                os.getenv("NO_PROXY", os.getenv("no_proxy", "")),
                                "localhost,127.0.0.1",
                            ],
                        )
                    ),
                }
            )
            if settings.PROXY_HOST:
                environment["HTTP_PROXY"] = settings.PROXY_HOST
                environment["HTTPS_PROXY"] = settings.PROXY_HOST
            self._runtime.start(environment)

    def get_state(self) -> bool:
        return self._enabled

    def stop_service(self):
        if self._runtime:
            self._runtime.stop()

    @staticmethod
    def get_command() -> List[Dict[str, Any]]:
        return []

    def get_api(self) -> List[Dict[str, Any]]:
        return [
            {
                "path": "/transfer_history/{history_id}",
                "endpoint": self.transfer_record,
                "methods": ["GET"],
                "auth": "bear",
                "summary": "读取指定失败整理记录",
            },
            {
                "path": "/transfer_retry/preview",
                "endpoint": self.preview_transfer,
                "methods": ["POST"],
                "auth": "bear",
                "summary": "预览失败记录的重新整理计划",
            },
            {
                "path": "/transfer_retry",
                "endpoint": self.retry_transfer,
                "methods": ["POST"],
                "auth": "bear",
                "summary": "按已确认的预览同步重新整理失败记录",
            },
            {
                "path": "/download_states",
                "endpoint": self.download_states,
                "methods": ["POST"],
                "auth": "bear",
                "summary": "查询指定任务的实际下载进度（含已完成任务）",
            },
            {
                "path": "/resolve_links",
                "endpoint": self.resolve_links,
                "methods": ["POST"],
                "auth": "bear",
                "summary": "解析公开种子链接为磁力链接与 BTIH",
            },
            {
                "path": "/ui",
                "endpoint": self.open_ui,
                "methods": ["GET"],
                "allow_anonymous": True,
                "summary": "打开 Pi Agent 网页（MoviePilot 管理员认证）",
            },
            {
                "path": "/ui/{path:path}",
                "endpoint": self.ui_proxy,
                "methods": ["GET", "POST", "PUT", "DELETE"],
                "allow_anonymous": True,
                "summary": "Pi Agent 网页与流式 API（MoviePilot 管理员认证）",
            },
        ]

    def open_ui(self, request: Request, user: TokenPayload = Depends(verify_resource_token)):
        if not user.super_user:
            raise HTTPException(status_code=403, detail="Pi Agent 仅供管理员使用")
        return RedirectResponse(str(request.url.replace(path=request.url.path + "/")))

    async def ui_proxy(
        self, path: str, request: Request, user: TokenPayload = Depends(verify_resource_token)
    ):
        return await proxy_request(self._runtime, path, request, user)

    def _require_enabled(self):
        if not self._enabled:
            raise HTTPException(status_code=503, detail="请先启用 Pi Agent 桥接插件")

    def transfer_record(self, history_id: int) -> dict:
        self._require_enabled()
        return {"success": True, "data": record_details(history_id)}

    def preview_transfer(self, body: TransferPreviewRequest) -> dict:
        self._require_enabled()
        return {"success": True, "data": preview_transfer(body)}

    def retry_transfer(self, body: TransferRetryRequest) -> dict:
        self._require_enabled()
        return {"success": True, "data": retry_transfer(body)}

    def download_states(self, body: DownloadStatesRequest) -> dict:
        self._require_enabled()
        torrents = DownloadChain().list_torrents(
            hashs=body.hashes,
            downloader=body.downloader,
        )
        states = []
        for torrent in torrents:
            if torrent.hash in body.hashes:
                progress = torrent.progress if torrent.progress is not None else 0.0
                states.append(
                    {
                        "hash": torrent.hash,
                        "progress": progress,
                        "completed": progress >= 100,
                    }
                )
        return {"success": True, "data": states}

    def resolve_links(self, body: ResolveLinksRequest) -> dict:
        self._require_enabled()
        manager = PluginManager()
        if manager.get_plugin_attr("CloudAutoSearch", "plugin_version") is None:
            raise HTTPException(
                status_code=503, detail="请安装并配置 115 RSS 离线下载 1.1.0 或更新版本"
            )
        # This explicit dependency supplies the same parser used by manual submission.
        from app.plugins.cloudautosearch import validate_download_link

        result = []
        for link in body.links:
            try:
                validate_download_link(link)
            except ValueError as error:
                raise HTTPException(status_code=422, detail=str(error)) from error
            resolved = manager.run_plugin_method(
                "CloudAutoSearch",
                "_resolve_magnet",
                {"download_url": link},
            )
            if resolved is None:
                raise HTTPException(status_code=503, detail="115 插件未提供约定的链接解析方法")
            magnet, info_hash = resolved
            if not magnet or not info_hash:
                raise HTTPException(
                    status_code=422, detail="无法解析种子链接，请使用公开链接或磁力链接"
                )
            result.append({"magnet": magnet, "infoHash": info_hash.lower()})
        return {"success": True, "data": result}

    def get_form(self) -> Tuple[List[dict], Dict[str, Any]]:
        return [
            {
                "component": "VRow",
                "content": [
                    {
                        "component": "VCol",
                        "props": {"cols": 12},
                        "content": [
                            {
                                "component": "VSwitch",
                                "props": {"model": "enabled", "label": "启用 Pi Agent"},
                            }
                        ],
                    },
                    {
                        "component": "VCol",
                        "props": {"cols": 12},
                        "content": [
                            {
                                "component": "VAlert",
                                "props": {"type": "info", "variant": "tonal"},
                                "text": (
                                    "插件自动安装并管理运行时，无需 SSH、独立容器或额外端口。"
                                    "首次启用会下载运行时，沿用 MP 的代理配置。"
                                ),
                            }
                        ],
                    },
                    *[
                        {"component": "VCol", "props": {"cols": 12, "md": 6}, "content": [field]}
                        for field in self._configuration_fields()
                    ],
                ],
            },
        ], PluginConfig().model_dump()

    @staticmethod
    def _configuration_fields():
        specifications = [
            (
                "provider",
                "Pi Provider",
                "例如 openai、anthropic、openrouter；自定义服务请填写独立名称。",
                False,
            ),
            ("model", "模型 ID", "使用一个明确的模型，不自动选择或切换免费模型。", False),
            ("api_key", "模型 API Key", "仅保存在 MP 插件配置中。", True),
            (
                "base_url",
                "自定义模型端点（可选）",
                "保留你的服务地址；Pi 原生 Provider 可留空。",
                False,
            ),
            ("context_window", "上下文窗口", "自定义模型的实际上下文 token 限制。", False),
            ("max_tokens", "最大输出 token", "自定义模型的实际输出限制。", False),
            (
                "feishu_app_id",
                "飞书 App ID",
                "启用前请关闭旧 FeishuBot，避免同一个应用被重复消费。",
                False,
            ),
            ("feishu_app_secret", "飞书 App Secret", "使用应用长连接，无需公网回调地址。", True),
            (
                "feishu_open_ids",
                "允许使用的 open_id",
                "启用飞书时必填；ou_ 开头的用户 ID，多个用逗号分隔。",
                False,
            ),
            ("feishu_group_ids", "允许使用的群 ID", "逗号分隔；留空时禁用群聊。", False),
        ]
        fields = [
            {"component": "VSwitch", "props": {"model": "feishu_enabled", "label": "启用飞书界面"}}
        ]
        for model, label, hint, secret in specifications:
            fields.append(
                {
                    "component": "VTextField",
                    "props": {
                        "model": model,
                        "label": label,
                        "hint": hint,
                        "persistent-hint": True,
                        "type": "password"
                        if secret
                        else ("number" if model in ("context_window", "max_tokens") else "text"),
                    },
                }
            )
        return fields

    def get_page(self) -> List[dict]:
        state = "configuration_error" if self._configuration_error else self._runtime.state
        content = [
            {
                "component": "VAlert",
                "props": {"type": "info", "variant": "tonal"},
                "text": (
                    "插件管理 Pi 运行时。会话、偏好和任务保存在 MP 配置目录，"
                    "网页与飞书共用同一核心。"
                ),
            },
            {
                "component": "VChip",
                "props": {"color": "success" if state == "running" else "warning"},
                "text": {
                    "disabled": "未启用，请先配置模型",
                    "installing": "正在安装运行时",
                    "starting": "正在启动",
                    "running": "运行中",
                    "error": "启动失败",
                    "configuration_error": "配置已保存，尚未启动",
                }[state],
            },
        ]
        if self._configuration_error:
            content.append(
                {
                    "component": "VAlert",
                    "props": {"type": "error"},
                    "text": self._configuration_error,
                }
            )
        if self._runtime and self._runtime.error:
            content.append(
                {"component": "VAlert", "props": {"type": "error"}, "text": self._runtime.error}
            )
        if state == "running":
            content.append(
                {
                    "component": "VBtn",
                    "props": {
                        "href": settings.API_V1_STR + "/plugin/PiAgentBridge/ui/",
                        "target": "_blank",
                        "color": "primary",
                    },
                    "text": "打开 Pi Agent",
                }
            )
        return [{"component": "VContainer", "content": content}]
