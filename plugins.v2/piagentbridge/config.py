from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, model_validator


class PluginConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool = False
    provider: str = "openai"
    model: str = ""
    api_key: str = ""
    base_url: str = ""
    context_window: int = Field(default=128000, gt=0)
    max_tokens: int = Field(default=8192, gt=0)
    feishu_enabled: bool = False
    feishu_app_id: str = ""
    feishu_app_secret: str = ""
    feishu_open_ids: str = ""
    feishu_group_ids: str = ""

    @model_validator(mode="after")
    def validate_enabled_settings(self):
        if self.enabled and not (self.provider.strip() and self.model.strip() and self.api_key):
            raise ValueError("启用前请填写模型 Provider、模型 ID 和 API Key")
        if self.base_url:
            parsed = urlsplit(self.base_url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                raise ValueError("模型端点必须是 HTTP 或 HTTPS 地址")
        if self.feishu_enabled and not (self.feishu_app_id and self.feishu_app_secret):
            raise ValueError("启用飞书需要填写 App ID 和 App Secret")
        if self.feishu_enabled and not self.feishu_open_ids.strip():
            raise ValueError("启用了飞书，请填写“允许使用的 open_id”（ou_ 开头的用户 ID）")
        return self

    def agent_environment(self):
        values = {
            "AGENT_PROVIDER": self.provider,
            "AGENT_MODEL": self.model,
            "AGENT_API_KEY": self.api_key,
            "AGENT_CONTEXT_WINDOW": str(self.context_window),
            "AGENT_MAX_TOKENS": str(self.max_tokens),
            "FEISHU_ENABLED": str(self.feishu_enabled).lower(),
            "FEISHU_ALLOWED_OPEN_IDS": self.feishu_open_ids,
            "FEISHU_ALLOWED_GROUP_IDS": self.feishu_group_ids,
        }
        if self.base_url:
            values["AGENT_BASE_URL"] = self.base_url
        if self.feishu_enabled:
            values["FEISHU_APP_ID"] = self.feishu_app_id
            values["FEISHU_APP_SECRET"] = self.feishu_app_secret
        return values
