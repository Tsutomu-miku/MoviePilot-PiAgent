from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

from app.chain.download import DownloadChain
from app.core.plugin import PluginManager
from app.plugins import _PluginBase
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field


class ResolveLinksRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    links: List[str] = Field(min_length=1, max_length=20)


class DownloadStatesRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hashes: List[str] = Field(min_length=1, max_length=100)
    downloader: Optional[str] = None


class PiAgentBridge(_PluginBase):
    plugin_name = "Pi Agent 桥接"
    plugin_desc = "连接独立的 TypeScript Pi Agent，提供下载状态与种子链接解析。"
    plugin_icon = "ChatGPT_A.png"
    plugin_version = "1.0.0"
    plugin_author = "Tsutomu-miku"
    author_url = "https://github.com/Tsutomu-miku"
    plugin_config_prefix = "piagentbridge_"
    plugin_order = 30
    auth_level = 1

    def init_plugin(self, config: Optional[dict] = None):
        values = config or {}
        self._enabled = values.get("enabled", False)
        self._agent_url = values.get("agent_url", "")
        if self._agent_url:
            parsed = urlsplit(self._agent_url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError("Agent 地址必须是 HTTP 或 HTTPS URL")

    def get_state(self) -> bool:
        return self._enabled

    def stop_service(self):
        # This plugin has no threads, subprocesses or background services.
        pass

    @staticmethod
    def get_command() -> List[Dict[str, Any]]:
        return []

    def get_api(self) -> List[Dict[str, Any]]:
        return [
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
        ]

    def _require_enabled(self):
        if not self._enabled:
            raise HTTPException(status_code=503, detail="请先启用 Pi Agent 桥接插件")

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
                                "props": {"model": "enabled", "label": "启用桥接 API"},
                            }
                        ],
                    },
                    {
                        "component": "VCol",
                        "props": {"cols": 12},
                        "content": [
                            {
                                "component": "VTextField",
                                "props": {
                                    "model": "agent_url",
                                    "label": "Agent 网页地址",
                                    "placeholder": "http://服务器地址:8787",
                                    "hint": "独立部署 Node.js 服务；这里仅提供入口和桥接 API。",
                                    "persistent-hint": True,
                                },
                            }
                        ],
                    },
                ],
            },
        ], {"enabled": False, "agent_url": ""}

    def get_page(self) -> List[dict]:
        content = [
            {
                "component": "VAlert",
                "props": {"type": "info", "variant": "tonal"},
                "text": "Agent 的会话、偏好和任务保存在独立服务中。飞书和网页共用同一核心。",
            },
            {
                "component": "VChip",
                "props": {"color": "success" if self._enabled else "warning"},
                "text": "桥接 API 已启用" if self._enabled else "桥接 API 未启用",
            },
        ]
        if self._agent_url:
            content.append(
                {
                    "component": "VBtn",
                    "props": {"href": self._agent_url, "target": "_blank", "color": "primary"},
                    "text": "打开 Pi Agent",
                }
            )
        return [{"component": "VContainer", "content": content}]
