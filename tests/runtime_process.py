"""Exercise the shipped Node process without sending model, MP or Feishu requests."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib.request import ProxyHandler, Request, build_opener

ROOT = Path(__file__).resolve().parents[1]
STAGE = Path(sys.argv.pop(1)).resolve()
spec = importlib.util.spec_from_file_location(
    "managed_runtime", ROOT / "plugins.v2/piagentbridge/runtime.py"
)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class PackagedInstaller:
    def ensure(self, stopped):
        return STAGE


class RuntimeProcessTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary.name)
        self.errors = []
        self.manager = runtime.ManagedRuntime(
            self.data_dir / "data", PackagedInstaller(), self.errors.append
        )
        self.environment = {
            "AGENT_PROVIDER": "offline-process-test",
            "AGENT_MODEL": "offline-model",
            "AGENT_API_KEY": "offline-test-key",
            "AGENT_BASE_URL": "http://127.0.0.1:9/v1",
            "MOVIEPILOT_URL": "http://127.0.0.1:9/api/v1/",
            "MOVIEPILOT_API_KEY": "offline-mp-key",
            "NO_PROXY": "localhost,127.0.0.1",
        }
        self.http = build_opener(ProxyHandler({}))

    def tearDown(self):
        self.manager.stop()
        self.temporary.cleanup()

    def ready(self):
        deadline = time.monotonic() + 15
        while self.manager.state not in ("running", "error") and time.monotonic() < deadline:
            time.sleep(0.1)
        self.assertEqual(self.manager.state, "running", self.manager.error)

    def request(self, path, body=None):
        request = Request(
            self.manager.base_url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={
                "Authorization": "Bearer " + self.manager.token,
                "Content-Type": "application/json",
            },
        )
        with self.http.open(request, timeout=5) as response:
            return json.load(response)

    def test_plugin_reload_stops_old_process_and_preserves_history(self):
        self.manager.start(self.environment)
        self.ready()
        conversation = self.request("/api/conversations", {"title": "Lifecycle verification"})
        old_process = self.manager._process
        self.manager.stop()
        self.assertEqual(old_process.poll(), 0)
        self.manager.start(self.environment)
        self.ready()
        self.assertTrue(
            any(item["id"] == conversation["id"] for item in self.request("/api/conversations"))
        )
        self.assertNotEqual(self.manager._process.pid, old_process.pid)
        self.assertEqual(self.errors, [])

    def test_parent_watchdog_closes_the_server_when_mp_parent_disappears(self):
        environment = {
            **os.environ,
            **self.environment,
            "HOST": "127.0.0.1",
            "PORT": "8787",
            "WEB_AUTH_TOKEN": self.manager.token,
            "AGENT_DATA_DIR": str(self.data_dir / "watchdog-data"),
            "AGENT_PARENT_PID": "9999999",
        }
        log_path = self.data_dir / "watchdog.log"
        with log_path.open("w") as log:
            process = subprocess.Popen(
                [str(STAGE / "bin/node"), "--use-env-proxy", "dist/src/server.js"],
                cwd=STAGE / "apps/api",
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                deadline = time.monotonic() + 4
                started = False
                while not started and process.poll() is None and time.monotonic() < deadline:
                    try:
                        with self.http.open(
                            self.manager.base_url + "/api/health", timeout=1
                        ) as response:
                            started = json.load(response)["status"] == "ok"
                    except OSError:
                        time.sleep(0.1)
                self.assertTrue(started, log_path.read_text())
                process.wait(timeout=12)
                self.assertEqual(process.returncode, 0, log_path.read_text())
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
