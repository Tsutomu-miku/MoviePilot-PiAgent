import hashlib
import xml.etree.ElementTree as ET
from typing import List, Optional
from urllib.parse import urlencode, urljoin

import requests
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field


class MikanSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    keyword: str = Field(min_length=1, max_length=120)
    group: Optional[str] = Field(default=None, min_length=1, max_length=120)


def parse_releases(xml: bytes) -> List[dict]:
    namespace = {"torrent": "https://mikanani.me/0.1/"}
    root = ET.fromstring(xml)
    if root.tag != "rss" or root.find("channel") is None:
        raise ValueError("蜜柑响应不是 RSS")
    releases = []
    for item in root.findall("./channel/item"):
        title = item.findtext("title", "").strip()
        source_url = item.findtext("link", "").strip()
        enclosure = item.find("enclosure")
        if not title or not source_url or enclosure is None:
            raise ValueError("蜜柑 RSS 条目缺少标题、详情或种子链接")
        download_url = enclosure.get("url", "").strip()
        if not download_url or enclosure.get("type") != "application/x-bittorrent":
            raise ValueError("蜜柑 RSS 条目缺少公开种子")
        releases.append(
            {
                "id": hashlib.sha256(download_url.encode()).hexdigest(),
                "title": title,
                "sourceUrl": source_url,
                "downloadUrl": download_url,
                "size": int(enclosure.get("length", "0")),
                "publishedAt": item.findtext("torrent:torrent/torrent:pubDate", "", namespace),
            }
        )
    return list({release["id"]: release for release in releases}.values())


def read_search(query: MikanSearchRequest, base_url: str, proxy: Optional[dict]) -> dict:
    searchstr = " ".join(filter(None, [query.keyword, query.group]))
    with requests.Session() as session:
        session.trust_env = False
        try:
            response = session.get(
                urljoin(base_url, "RSS/Search"),
                params={"searchstr": searchstr},
                proxies=proxy,
                timeout=(10, 30),
                allow_redirects=False,
            )
            response.raise_for_status()
            items = parse_releases(response.content)
        except requests.RequestException as error:
            raise HTTPException(
                status_code=502, detail="蜜柑搜索连接失败，请检查站点和代理"
            ) from error
        except (ET.ParseError, ValueError) as error:
            raise HTTPException(status_code=502, detail="蜜柑未返回有效的资源 RSS") from error
    return {
        "searchUrl": urljoin(base_url, "Home/Search") + "?" + urlencode({"searchstr": searchstr}),
        "received": len(items),
        "items": items,
    }


def search_mikan(query: MikanSearchRequest) -> dict:
    from app.core.config import settings
    from app.db.site_oper import SiteOper

    sites = [
        site
        for site in SiteOper().list()
        if site.is_active and site.name.casefold() in ("mikan", "蜜柑计划")
    ]
    if len(sites) != 1:
        raise HTTPException(status_code=409, detail="请在 MP 启用一个名为 MiKan 或蜜柑计划的站点")
    site = sites[0]
    return read_search(query, site.url, settings.PROXY if site.proxy else None)
