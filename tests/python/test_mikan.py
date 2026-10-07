import hashlib
import importlib.util
import sys
import types
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from fastapi import HTTPException
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "mikan_bridge", ROOT / "plugins.v2/piagentbridge/mikan.py"
)
mikan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mikan)

RSS = """<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:torrent="https://mikanani.me/0.1/"><channel><title>蜜柑计划</title>
<item><title>【字幕组】花织 [01][1080p][简体]</title>
<link>https://mikan.example/Home/Episode/abc</link>
<torrent:torrent><torrent:contentLength>524288000</torrent:contentLength><torrent:pubDate>2026-10-07T12:30:00</torrent:pubDate></torrent:torrent>
<enclosure type="application/x-bittorrent" length="524288000"
url="https://mikan.example/Download/abc.torrent" /></item>
</channel></rss>""".encode()


class MikanTests(unittest.TestCase):
    def test_rss_preserves_release_metadata_and_deduplicates_torrent_urls(self):
        items = mikan.parse_releases(RSS)
        self.assertEqual(len(items), 1)
        release = items[0]
        self.assertEqual(release["id"], hashlib.sha256(release["downloadUrl"].encode()).hexdigest())
        self.assertEqual(release["size"], 524288000)
        self.assertEqual(release["publishedAt"], "2026-10-07T12:30:00")
        self.assertIn("花织", release["title"])
        duplicated = RSS.replace(
            b"</channel>", RSS[RSS.index(b"<item>") : RSS.index(b"</item>") + 7] + b"</channel>"
        )
        self.assertEqual(mikan.parse_releases(duplicated), items)
        self.assertEqual(mikan.parse_releases(b"<rss><channel /></rss>"), [])
        with self.assertRaises(ValueError):
            mikan.parse_releases(b"<html>blocked</html>")

    def test_search_preserves_chinese_and_group_and_uses_only_configured_proxy(self):
        session = Mock()
        session.get.return_value.content = RSS
        proxy = {"http": "http://proxy:7890", "https": "http://proxy:7890"}
        with patch.object(mikan.requests, "Session") as constructor:
            constructor.return_value.__enter__.return_value = session
            result = mikan.read_search(
                mikan.MikanSearchRequest(keyword=" 花织 ", group="喵萌奶茶屋"),
                "https://mikan.example/",
                proxy,
            )
            session.get.assert_called_once_with(
                "https://mikan.example/RSS/Search",
                params={"searchstr": "花织 喵萌奶茶屋"},
                proxies=proxy,
                timeout=(10, 30),
                allow_redirects=False,
            )
            self.assertFalse(session.trust_env)
            self.assertEqual(result["received"], 1)
            self.assertTrue(
                result["searchUrl"].startswith("https://mikan.example/Home/Search?searchstr=")
            )
            mikan.read_search(
                mikan.MikanSearchRequest(keyword="原名"), "https://mikan.example/", None
            )
            self.assertIsNone(session.get.call_args.kwargs["proxies"])

    def test_native_site_configuration_controls_endpoint_and_proxy(self):
        settings = types.SimpleNamespace(PROXY={"https": "http://configured:7890"})
        site = types.SimpleNamespace(
            is_active=True, name="MiKan", proxy=1, url="https://configured-mikan.example/"
        )
        oper = Mock()
        oper.list.return_value = [site, types.SimpleNamespace(is_active=False, name="MiKan")]
        modules = {
            name: types.ModuleType(name)
            for name in ("app", "app.core", "app.core.config", "app.db", "app.db.site_oper")
        }
        modules["app.core.config"].settings = settings
        modules["app.db.site_oper"].SiteOper = lambda: oper
        query = mikan.MikanSearchRequest(keyword="花织")
        with ExitStack() as stack:
            stack.enter_context(patch.dict(sys.modules, modules))
            read = stack.enter_context(
                patch.object(mikan, "read_search", return_value={"items": []})
            )
            mikan.search_mikan(query)
            read.assert_called_once_with(query, site.url, settings.PROXY)
            site.proxy = 0
            mikan.search_mikan(query)
            self.assertIsNone(read.call_args.args[2])
            oper.list.return_value = []
            with self.assertRaises(HTTPException) as error:
                mikan.search_mikan(query)
            self.assertEqual(error.exception.status_code, 409)

    def test_bad_feed_or_network_failure_is_explicit_and_input_does_not_accept_guessed_fields(self):
        query = mikan.MikanSearchRequest(keyword="花织")
        with patch.object(mikan.requests, "Session") as constructor:
            session = constructor.return_value.__enter__.return_value
            session.get.side_effect = requests.ConnectionError("private proxy credentials")
            with self.assertRaises(HTTPException) as error:
                mikan.read_search(query, "https://mikan.example/", None)
            self.assertEqual(error.exception.status_code, 502)
            self.assertNotIn("private", error.exception.detail)
            session.get.side_effect = None
            session.get.return_value.content = b"<rss><channel><item /></channel></rss>"
            with self.assertRaises(HTTPException) as error:
                mikan.read_search(query, "https://mikan.example/", None)
            self.assertEqual(error.exception.status_code, 502)
        with self.assertRaises(ValidationError):
            mikan.MikanSearchRequest(keyword="")
        with self.assertRaises(ValidationError):
            mikan.MikanSearchRequest(keyword="花织", english_title="unwanted")


if __name__ == "__main__":
    unittest.main()
