import hashlib
import importlib.util
import io
import json
import tarfile
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "managed_runtime", ROOT / "plugins.v2/piagentbridge/runtime.py"
)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, entries):
        path = self.root / "runtime.tar.gz"
        with tarfile.open(path, "w:gz") as package:
            for name, content in entries:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                package.addfile(member, io.BytesIO(content))
        return path

    def test_archive_rejects_traversal_before_writing_any_files(self):
        path = self.archive([("bin/node", b"runtime"), ("../escape", b"bad")])
        output = self.root / "installed"
        output.mkdir()
        with self.assertRaises(ValueError):
            runtime.extract_runtime(path, output)
        self.assertEqual(list(output.iterdir()), [])

    def test_archive_rejects_external_links(self):
        path = self.root / "bad-link.tar.gz"
        with tarfile.open(path, "w:gz") as package:
            member = tarfile.TarInfo("node_modules/external")
            member.type = tarfile.SYMTYPE
            member.linkname = "../../../escape"
            package.addfile(member)
        with self.assertRaises(ValueError):
            runtime.extract_runtime(path, self.root / "installed")

    @patch.object(runtime.platform, "machine", return_value="x86_64")
    def test_install_checks_hash_uses_configured_proxy_and_reuses_runtime(self, _machine):
        path = self.archive([("bin/node", b"runtime")])
        content = path.read_bytes()
        plugin = self.root / "plugin"
        plugin.mkdir()
        manifest = {
            "version": runtime.RUNTIME_VERSION,
            "platforms": {
                "linux-x64": {
                    "url": "https://github.com/owner/repo/runtime.tar.gz",
                    "sha256": hashlib.sha256(content).hexdigest(),
                }
            },
        }
        (plugin / "runtime-manifest.json").write_text(json.dumps(manifest))
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = [content]
        proxy = {"https": "http://configured-proxy:7890"}
        installer = runtime.RuntimeInstaller(
            plugin, self.root / "data", proxy, "https://mirror.example/"
        )
        with patch.object(runtime.requests, "get", return_value=response) as download:
            directory = installer.ensure(threading.Event())
            self.assertEqual((directory / "bin/node").read_bytes(), b"runtime")
            self.assertEqual(installer.ensure(threading.Event()), directory)
            download.assert_called_once()
            self.assertEqual(download.call_args.kwargs["proxies"], proxy)
            self.assertTrue(
                download.call_args.args[0].startswith("https://mirror.example/https://github.com/")
            )
        self.assertFalse(list((self.root / "data/runtimes").glob("*.part")))

    @patch.object(runtime.platform, "machine", return_value="x86_64")
    def test_hash_mismatch_does_not_activate_download(self, _machine):
        plugin = self.root / "plugin"
        plugin.mkdir()
        (plugin / "runtime-manifest.json").write_text(
            json.dumps(
                {
                    "version": runtime.RUNTIME_VERSION,
                    "platforms": {
                        "linux-x64": {"url": "https://example.test/runtime", "sha256": "wrong"}
                    },
                }
            )
        )
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.iter_content.return_value = [b"untrusted"]
        installer = runtime.RuntimeInstaller(plugin, self.root / "data", None, "")
        with patch.object(runtime.requests, "get", return_value=response):
            with self.assertRaises(ValueError):
                installer.ensure(threading.Event())
        self.assertFalse((self.root / "data/runtimes" / runtime.RUNTIME_VERSION).exists())

    def test_runtime_token_is_private_and_stable_across_plugin_reload(self):
        installer = Mock()
        first = runtime.ManagedRuntime(self.root / "data", installer, Mock())
        second = runtime.ManagedRuntime(self.root / "data", installer, Mock())
        self.assertEqual(first.token, second.token)
        self.assertGreaterEqual(len(first.token), 32)
        self.assertEqual((self.root / "data/runtime-token").stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
