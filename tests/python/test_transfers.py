import importlib.util
import sys
import types
import unittest
from enum import Enum
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "transfer_bridge", ROOT / "plugins.v2/piagentbridge/transfers.py"
)
transfers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfers)


class FileItem(BaseModel):
    storage: str
    path: str


class EpisodeFormat(BaseModel):
    detail: str


class MediaType(Enum):
    MOVIE = "电影"
    TV = "电视剧"


class TransferTests(unittest.TestCase):
    def setUp(self):
        self.history = types.SimpleNamespace(
            id=101,
            src="/private/downloads/episode.mkv",
            src_storage="local",
            src_fileitem={"storage": "local", "path": "/private/downloads/episode.mkv"},
            dest_fileitem=None,
            status=False,
            title=None,
            errmsg="未识别到媒体信息",
            date="2026-10-07 12:00:00",
            media_source=None,
            media_id=None,
            type=None,
            seasons="S01",
            episodes="E01-E02",
            episode_group=None,
            mode=None,
            downloader="configured-downloader",
            download_hash="known-hash",
        )
        self.history.to_dict = lambda: {
            "id": 101,
            "src": self.history.src,
            "status": self.history.status,
        }
        self.oper = Mock()
        self.oper.get.return_value = self.history
        self.oper.list_success_by_src.return_value = []
        self.chain = Mock()
        self.item = {
            "source": self.history.src,
            "target": "/private/library/Show/episode.mkv",
            "target_dir": "/private/library/Show",
            "success": True,
            "type": "电视剧",
            "title": "Show",
            "season": 1,
            "episode": 1,
            "episode_end": 2,
        }
        self.chain.manual_transfer.return_value = (True, {"items": [self.item]})
        modules = {}
        for name in (
            "app",
            "app.db",
            "app.db.transferhistory_oper",
            "app.chain",
            "app.chain.transfer",
            "app.schemas",
            "app.schemas.types",
        ):
            modules[name] = types.ModuleType(name)
        modules["app.db.transferhistory_oper"].TransferHistoryOper = lambda: self.oper
        modules["app.chain.transfer"].TransferChain = lambda: self.chain
        modules["app.schemas"].FileItem = FileItem
        modules["app.schemas"].EpisodeFormat = EpisodeFormat
        modules["app.schemas.types"].MediaType = MediaType
        self.modules = patch.dict(sys.modules, modules)
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.request = transfers.TransferPreviewRequest(
            history_id=101, revision=transfers.fingerprint(self.history.to_dict())
        )

    def test_record_and_preview_expose_names_without_private_paths(self):
        record = transfers.record_details(101)
        plan = transfers.preview_transfer(self.request)
        self.assertEqual(record["filename"], "episode.mkv")
        self.assertNotIn("/private", str(record) + str(plan))
        arguments = self.chain.manual_transfer.call_args.kwargs
        self.assertTrue(arguments["preview"])
        self.assertFalse(arguments["background"])
        self.assertEqual(arguments["download_hash"], "known-hash")
        self.assertEqual(arguments["epformat"].detail, "1,2")

    def test_record_revision_and_successful_sources_reject_retries_before_writes(self):
        self.history.status = True
        with self.assertRaises(HTTPException):
            transfers.preview_transfer(self.request)
        self.history.status = False
        self.oper.list_success_by_src.return_value = [object()]
        with self.assertRaises(HTTPException):
            transfers.preview_transfer(self.request)
        self.chain.manual_transfer.assert_not_called()

    def test_changed_plan_cannot_execute(self):
        request = transfers.TransferRetryRequest(**self.request.model_dump(), plan_hash="0" * 64)
        with self.assertRaises(HTTPException):
            transfers.retry_transfer(request)
        self.assertEqual(self.chain.manual_transfer.call_count, 1)
        self.assertTrue(self.chain.manual_transfer.call_args.kwargs["preview"])

    def test_confirmed_plan_executes_once_with_selected_identification(self):
        identification = transfers.TransferIdentification(
            source="themoviedb", id="123", type="电视剧", season=2, episodes=[3]
        )
        self.request.identification = identification
        plan = transfers.preview_transfer(self.request)
        self.chain.manual_transfer.reset_mock()
        self.chain.manual_transfer.side_effect = [(True, {"items": [self.item]}), (True, "")]
        result = transfers.retry_transfer(
            transfers.TransferRetryRequest(**self.request.model_dump(), plan_hash=plan["planHash"])
        )
        self.assertTrue(result["completed"])
        self.assertEqual(self.chain.manual_transfer.call_count, 2)
        arguments = self.chain.manual_transfer.call_args.kwargs
        self.assertFalse(arguments["preview"])
        self.assertEqual(arguments["media_source"], "themoviedb")
        self.assertEqual(arguments["media_id"], "123")
        self.assertEqual(arguments["season"], 2)
        self.assertEqual(arguments["epformat"].detail, "3")

    def test_partial_execution_is_an_uncertain_outcome_not_a_rejection(self):
        plan = transfers.preview_transfer(self.request)
        self.chain.manual_transfer.side_effect = [
            (True, {"items": [self.item]}),
            (False, "partial failure"),
        ]
        result = transfers.retry_transfer(
            transfers.TransferRetryRequest(**self.request.model_dump(), plan_hash=plan["planHash"])
        )
        self.assertFalse(result["completed"])

    def test_failed_previews_never_execute(self):
        self.chain.manual_transfer.return_value = (False, {"items": []})
        with self.assertRaises(HTTPException):
            transfers.preview_transfer(self.request)
        self.assertTrue(self.chain.manual_transfer.call_args.kwargs["preview"])
