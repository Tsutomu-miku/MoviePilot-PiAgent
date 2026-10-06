import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

ROOT = Path(__file__).resolve().parents[2]


class BridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        modules = {
            name: types.ModuleType(name)
            for name in (
                "app",
                "app.chain",
                "app.chain.download",
                "app.core",
                "app.core.plugin",
                "app.plugins",
                "app.plugins.cloudautosearch",
            )
        }
        modules["app.plugins"]._PluginBase = object
        modules["app.chain.download"].DownloadChain = Mock()
        modules["app.core.plugin"].PluginManager = Mock()
        modules["app.plugins.cloudautosearch"].validate_download_link = Mock()
        cls.module_patch = patch.dict(sys.modules, modules)
        cls.module_patch.start()
        spec = importlib.util.spec_from_file_location(
            "piagentbridge", ROOT / "plugins.v2/piagentbridge/__init__.py"
        )
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        cls.module_patch.stop()

    def setUp(self):
        self.plugin = self.module.PiAgentBridge()
        self.plugin.init_plugin({"enabled": True, "agent_url": "http://agent:8787"})
        self.module.DownloadChain.reset_mock()
        self.module.PluginManager.reset_mock()

    def test_download_state_uses_all_tasks_and_exact_hashes(self):
        torrents = [
            types.SimpleNamespace(hash="one", progress=100),
            types.SimpleNamespace(hash="two", progress=25),
            types.SimpleNamespace(hash="unrelated", progress=100),
        ]
        self.module.DownloadChain.return_value.list_torrents.return_value = torrents
        body = self.module.DownloadStatesRequest(hashes=["one", "two"], downloader="qb")
        result = self.plugin.download_states(body)
        self.assertEqual(
            result["data"],
            [
                {"hash": "one", "progress": 100, "completed": True},
                {"hash": "two", "progress": 25, "completed": False},
            ],
        )
        self.module.DownloadChain.return_value.list_torrents.assert_called_once_with(
            hashs=["one", "two"], downloader="qb"
        )

    def test_resolver_calls_existing_parser_without_submission(self):
        manager = self.module.PluginManager.return_value
        manager.get_plugin_attr.return_value = "1.1.0"
        manager.run_plugin_method.return_value = ("magnet:?xt=urn:btih:" + "A" * 40, "A" * 40)
        result = self.plugin.resolve_links(
            self.module.ResolveLinksRequest(links=["https://example.test/file.torrent"])
        )
        self.assertEqual(result["data"][0]["infoHash"], "a" * 40)
        manager.run_plugin_method.assert_called_once_with(
            "CloudAutoSearch",
            "_resolve_magnet",
            {"download_url": "https://example.test/file.torrent"},
        )

    def test_disabled_and_invalid_input_fail_explicitly(self):
        self.plugin.init_plugin({"enabled": False})
        with self.assertRaises(HTTPException) as error:
            self.plugin.download_states(self.module.DownloadStatesRequest(hashes=["one"]))
        self.assertEqual(error.exception.status_code, 503)
        with self.assertRaises(ValidationError):
            self.module.ResolveLinksRequest(links=[])
        with self.assertRaises(ValidationError):
            self.module.DownloadStatesRequest(hashes=["one"], guessed_hash="two")

    def test_native_fastapi_body_binding_and_bearer_metadata(self):
        self.module.DownloadChain.return_value.list_torrents.return_value = []
        app = FastAPI()
        for route in self.plugin.get_api():
            self.assertEqual(route["auth"], "bear")
            app.add_api_route(route["path"], route["endpoint"], methods=route["methods"])
        client = TestClient(app)
        self.assertEqual(
            client.post("/download_states", json={"hashes": ["one"]}).json(),
            {"success": True, "data": []},
        )
        self.assertEqual(client.post("/download_states", json={"hashes": []}).status_code, 422)
        self.assertEqual(
            client.post(
                "/download_states", json={"hashes": ["one"], "downloader": "qb"}
            ).status_code,
            200,
        )

    def test_page_links_to_service_without_credentials(self):
        page = self.plugin.get_page()
        button = page[0]["content"][-1]
        self.assertEqual(button["props"]["href"], "http://agent:8787")
        with self.assertRaises(ValueError):
            self.plugin.init_plugin({"agent_url": "javascript:alert(1)"})


if __name__ == "__main__":
    unittest.main()
