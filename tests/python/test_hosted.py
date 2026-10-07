import importlib.util
import json
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "hosted_proxy", ROOT / "plugins.v2/piagentbridge/hosted.py"
)
hosted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hosted)


class HostedTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.runtime = types.SimpleNamespace(
            state="running", token="internal-secret", base_url="http://node.test"
        )

        async def upstream(request):
            self.requests.append(request)
            if request.url.path == "/":
                return httpx.Response(
                    200,
                    text="<html><head></head><body></body></html>",
                    headers={"content-type": "text/html"},
                )
            return httpx.Response(
                200,
                content=b'data: {"type":"text","text":"ok"}\n\n',
                headers={"content-type": "text/event-stream"},
            )

        self.transport = httpx.MockTransport(upstream)
        self.original_client = httpx.AsyncClient
        app = FastAPI()

        @app.api_route("/ui/{path:path}", methods=["GET", "POST", "PUT"])
        async def endpoint(path: str, request: Request):
            user = types.SimpleNamespace(super_user=request.headers.get("x-test-role") == "admin")
            return await hosted.proxy_request(self.runtime, path, request, user)

        self.client = TestClient(app)

    def client_factory(self, **kwargs):
        return self.original_client(transport=self.transport, **kwargs)

    def test_html_reuses_mp_login_without_exposing_runtime_token(self):
        with patch.object(hosted.httpx, "AsyncClient", side_effect=self.client_factory):
            response = self.client.get(
                "/ui/", headers={"x-test-role": "admin", "cookie": "MoviePilot=private"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertIn('name="pi-agent-host"', response.text)
        self.assertNotIn(self.runtime.token, response.text)
        self.assertNotIn("cookie", self.requests[0].headers)
        self.assertEqual(self.requests[0].headers["authorization"], "Bearer " + self.runtime.token)

    def test_non_admin_cross_origin_and_absolute_paths_are_rejected(self):
        self.assertEqual(self.client.get("/ui/").status_code, 403)
        headers = {"x-test-role": "admin", "origin": "https://foreign.example"}
        self.assertEqual(
            self.client.post("/ui/api/conversations", json={}, headers=headers).status_code, 403
        )
        self.assertEqual(
            self.client.get("/ui//foreign.example", headers={"x-test-role": "admin"}).status_code,
            404,
        )
        self.assertEqual(self.requests, [])

    def test_same_origin_stream_preserves_body_and_headers(self):
        with patch.object(hosted.httpx, "AsyncClient", side_effect=self.client_factory):
            response = self.client.post(
                "/ui/api/conversations",
                json={"title": "new"},
                headers={"x-test-role": "admin", "origin": "http://testserver"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-accel-buffering"], "no")
        self.assertEqual(response.headers["content-type"], "text/event-stream")
        self.assertIn('"text":"ok"', response.text)
        self.assertEqual(json.loads(self.requests[0].content), {"title": "new"})


if __name__ == "__main__":
    unittest.main()
