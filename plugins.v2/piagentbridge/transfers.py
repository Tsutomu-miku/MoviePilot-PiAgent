import hashlib
import json
import re
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, PositiveInt


class TransferIdentification(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: Literal["themoviedb", "douban", "bangumi", "anilist"]
    id: str = Field(min_length=1, max_length=100)
    type: Literal["电影", "电视剧"]
    season: Optional[int] = Field(default=None, ge=0, le=100)
    episodes: Optional[List[PositiveInt]] = Field(default=None, min_length=1, max_length=1000)


class TransferPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    history_id: int = Field(gt=0)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    identification: Optional[TransferIdentification] = None


class TransferRetryRequest(TransferPreviewRequest):
    plan_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


def fingerprint(value) -> str:
    encoded = json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def failure_record(history_id: int):
    from app.db.transferhistory_oper import TransferHistoryOper

    history = TransferHistoryOper().get(history_id)
    if history is None:
        raise HTTPException(status_code=404, detail="整理记录不存在")
    if history.status:
        raise HTTPException(status_code=409, detail="只能重新整理失败记录")
    if not history.src_fileitem or not history.src:
        raise HTTPException(status_code=409, detail="整理记录缺少源文件信息")
    return history


def record_details(history_id: int) -> dict:
    history = failure_record(history_id)
    return {
        "id": str(history.id),
        "filename": Path(history.src).name,
        "title": history.title or "",
        "error": history.errmsg or "",
        "date": history.date or "",
        "revision": fingerprint(history.to_dict()),
        "sourceKey": fingerprint([history.src_storage, history.src]),
        "cleanupTarget": bool(history.dest_fileitem),
    }


def checked_record(body: TransferPreviewRequest):
    from app.db.transferhistory_oper import TransferHistoryOper

    history = failure_record(body.history_id)
    if fingerprint(history.to_dict()) != body.revision:
        raise HTTPException(status_code=409, detail="整理记录已变化，请重新预览")
    successes = TransferHistoryOper().list_success_by_src(history.src, history.src_storage)
    if successes:
        raise HTTPException(status_code=409, detail="源文件已有成功整理记录，请先核对 MP")
    return history


def historical_season(history) -> Optional[int]:
    if not history.seasons:
        return None
    match = re.fullmatch(r"S(\d+)", history.seasons)
    if match is None:
        raise HTTPException(status_code=422, detail="原记录包含多季，请明确指定季号")
    return int(match[1])


def historical_episodes(history) -> Optional[str]:
    if not history.episodes:
        return None
    match = re.fullmatch(r"E(\d+)(?:-E(\d+))?", history.episodes)
    if match is None:
        raise HTTPException(status_code=422, detail="原记录集号格式不明确，请重新指定集号")
    start = int(match[1])
    end = int(match[2]) if match[2] else start
    if end < start or end - start > 1000:
        raise HTTPException(status_code=422, detail="原记录集号范围无效")
    return ",".join(str(episode) for episode in range(start, end + 1))


def manual_transfer(history, identification: Optional[TransferIdentification], preview: bool):
    from app.chain.transfer import TransferChain
    from app.schemas import EpisodeFormat, FileItem
    from app.schemas.types import MediaType

    source = identification.source if identification else history.media_source
    media_id = identification.id if identification else history.media_id
    media_type = identification.type if identification else history.type
    season = (
        identification.season
        if identification and identification.season is not None
        else historical_season(history)
    )
    episodes = (
        ",".join(str(episode) for episode in identification.episodes)
        if identification and identification.episodes
        else historical_episodes(history)
    )
    if identification and identification.type == "电影":
        season = None
        episodes = None
    same_media = identification is None or (
        identification.source == history.media_source and identification.id == history.media_id
    )
    return TransferChain().manual_transfer(
        fileitem=FileItem(**history.src_fileitem),
        media_source=source,
        media_id=media_id,
        mtype=MediaType(media_type) if media_type else None,
        season=season,
        epformat=EpisodeFormat(detail=episodes) if episodes else None,
        episode_group=history.episode_group if same_media else None,
        transfer_type=history.mode,
        downloader=history.downloader,
        download_hash=history.download_hash,
        force=True,
        background=False,
        preview=preview,
        cleanup_dest_fileitem=FileItem(**history.dest_fileitem) if history.dest_fileitem else None,
    )


def transfer_plan(history, identification: Optional[TransferIdentification]) -> dict:
    success, details = manual_transfer(history, identification, preview=True)
    if not success:
        raise HTTPException(
            status_code=422,
            detail="MP 无法生成可执行整理预览，请核对媒体识别、源文件和目录配置",
        )
    items = details["items"]
    if (
        not items
        or len(items) > 200
        or any(not item["success"] or not item["target"] for item in items)
    ):
        raise HTTPException(status_code=422, detail="预览必须包含 1 至 200 个可成功整理的文件")
    plan = [
        {
            key: item[key]
            for key in (
                "source",
                "target",
                "target_dir",
                "type",
                "title",
                "season",
                "episode",
                "episode_end",
            )
        }
        for item in items
    ]
    return {
        "planHash": fingerprint(plan),
        "cleanupTarget": bool(history.dest_fileitem),
        "files": [
            {
                "sourceKey": fingerprint([history.src_storage, item["source"]]),
                "filename": Path(item["source"]).name,
                "targetFilename": Path(item["target"]).name,
                "title": item["title"] or "",
                "season": item["season"],
                "episode": item["episode"],
            }
            for item in items
        ],
    }


def preview_transfer(body: TransferPreviewRequest) -> dict:
    history = checked_record(body)
    return transfer_plan(history, body.identification)


def retry_transfer(body: TransferRetryRequest) -> dict:
    history = checked_record(body)
    plan = transfer_plan(history, body.identification)
    if plan["planHash"] != body.plan_hash:
        raise HTTPException(status_code=409, detail="整理目标或识别结果已变化，请重新预览")
    success, _details = manual_transfer(history, body.identification, preview=False)
    # A failed synchronous transfer may have moved some files. Its outcome is not a rejection.
    return {"completed": bool(success)}
