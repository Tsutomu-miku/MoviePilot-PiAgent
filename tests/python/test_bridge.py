import importlib.util
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import BaseModel, ValidationError

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
                "app.core.config",
                "app.core.security",
                "app.plugins",
                "app.plugins.cloudautosearch",
                "app.log",
                "app.schemas",
            )
        }
        modules["app.plugins"]._PluginBase = object
        modules["app.chain.download"].DownloadChain = Mock()
        modules["app.core.plugin"].PluginManager = Mock()
        modules["app.plugins.cloudautosearch"].validate_download_link = Mock()
        modules["app.core.config"].settings = types.SimpleNamespace(
            PROXY=None,
            GITHUB_PROXY="",
            PORT=3001,
            API_V1_STR="/api/v1",
            API_TOKEN="mp-api-key",
            PROXY_HOST="",
        )
        modules["app.log"].logger = Mock()

        class TokenPayload(BaseModel):
            super_user: bool

        def resource_user(request: Request):
            cookie = request.cookies.get("MoviePilot")
            if not cookie:
                raise HTTPException(status_code=401, detail="请先登录 MoviePilot")
            return TokenPayload(super_user=cookie == "admin")

        modules["app.schemas"].TokenPayload = TokenPayload
        modules["app.core.security"].verify_resource_token = resource_user
        cls.module_patch = patch.dict(sys.modules, modules)
        cls.module_patch.start()
        spec = importlib.util.spec_from_file_location(
            "piagentbridge", ROOT / "plugins.v2/piagentbridge/__init__.py"
        )
        cls.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.module
        spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        cls.module_patch.stop()

    def setUp(self):
        self.plugin = self.module.PiAgentBridge()
        self.data_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.data_dir.cleanup)
        self.plugin.get_data_path = lambda: Path(self.data_dir.name)
        self.runtime_patch = patch.object(self.module, "ManagedRuntime")
        runtime = self.runtime_patch.start().return_value
        self.addCleanup(self.runtime_patch.stop)
        runtime.state = "disabled"
        runtime.error = ""
        self.plugin.init_plugin(
            {"enabled": True, "model": "configured-model", "api_key": "model-key"}
        )
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
            if route["path"].startswith("/ui"):
                self.assertTrue(route["allow_anonymous"])
            else:
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
        with patch.object(
            self.module, "search_mikan", return_value={"received": 0, "items": []}
        ) as search:
            result = client.post("/mikan_search", json={"keyword": "花织", "group": "喵萌奶茶屋"})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(search.call_args.args[0].keyword, "花织")
            self.assertEqual(client.post("/mikan_search", json={"keyword": ""}).status_code, 422)

    def test_page_links_to_moviepilot_without_credentials(self):
        self.plugin._runtime.state = "running"
        page = self.plugin.get_page()
        button = page[0]["content"][-1]
        self.assertEqual(button["props"]["href"], "/api/v1/plugin/PiAgentBridge/ui/")
        self.plugin.init_plugin({"enabled": True})
        self.assertFalse(self.plugin.get_state())
        self.assertIn("启用前请填写", self.plugin._configuration_error)
        self.plugin.init_plugin({"base_url": "javascript:alert(1)"})
        self.assertIn("HTTP", self.plugin._configuration_error)

    def test_invalid_saved_configuration_stops_old_runtime_and_never_logs_credentials(self):
        previous = self.plugin._runtime
        configuration = {
            "enabled": True,
            "model": "configured-model",
            "api_key": "private-model-key",
            "feishu_enabled": True,
            "feishu_app_id": "cli_example",
            "feishu_app_secret": "private-app-secret",
            "feishu_open_ids": "",
        }
        self.plugin.init_plugin(configuration)
        previous.stop.assert_called_once()
        self.assertFalse(self.plugin.get_state())
        self.assertIsNone(self.plugin._runtime)
        page = str(self.plugin.get_page())
        self.assertIn("允许使用的 open_id", page)
        self.assertNotIn(configuration["api_key"], page)
        self.assertNotIn(configuration["feishu_app_secret"], page)
        self.assertNotIn(configuration["api_key"], str(self.module.logger.error.call_args))
        self.assertNotIn(
            configuration["feishu_app_secret"], str(self.module.logger.error.call_args)
        )

    def test_mp_save_endpoint_can_store_incomplete_settings_without_a_server_error(self):
        saved = []
        app = FastAPI()

        @app.put("/plugin/PiAgentBridge")
        def save_configuration(configuration: dict):
            saved.append(configuration)
            self.plugin.init_plugin(configuration)
            return {"success": True}

        client = TestClient(app)
        configuration = {
            "enabled": True,
            "model": "configured-model",
            "api_key": "model-key",
            "feishu_enabled": True,
            "feishu_app_id": "cli_example",
            "feishu_app_secret": "app-secret",
        }
        response = client.put("/plugin/PiAgentBridge", json=configuration)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(saved, [configuration])
        self.assertFalse(self.plugin.get_state())
        configuration["feishu_open_ids"] = "ou_owner"
        self.assertEqual(client.put("/plugin/PiAgentBridge", json=configuration).status_code, 200)
        self.assertTrue(self.plugin.get_state())
        self.assertEqual(self.plugin._configuration_error, "")

    def test_hosted_routes_require_moviepilot_admin_cookie(self):
        app = FastAPI()
        for route in self.plugin.get_api():
            app.add_api_route(route["path"], route["endpoint"], methods=route["methods"])
        client = TestClient(app)
        self.assertEqual(client.get("/ui", follow_redirects=False).status_code, 401)
        client.cookies.set("MoviePilot", "reader")
        self.assertEqual(client.get("/ui", follow_redirects=False).status_code, 403)
        client.cookies.set("MoviePilot", "admin")
        response = client.get("/ui", follow_redirects=False)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response.headers["location"], "http://testserver/ui/")

    def test_managed_environment_uses_mp_integration_key_and_stops_on_reconfigure(self):
        environment = self.plugin._runtime.start.call_args.args[0]
        self.assertEqual(environment["MOVIEPILOT_API_KEY"], "mp-api-key")
        self.assertEqual(environment["MOVIEPILOT_URL"], "http://127.0.0.1:3001/api/v1/")
        self.assertNotIn("MOVIEPILOT_PASSWORD", environment)
        runtime = self.plugin._runtime
        self.plugin.init_plugin({"enabled": False})
        runtime.stop.assert_called_once()


if __name__ == "__main__":
    unittest.main()
