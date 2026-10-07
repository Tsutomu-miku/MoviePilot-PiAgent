import hashlib
import json
import logging
import os
import platform
import secrets
import shutil
import signal
import subprocess
import tarfile
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Callable, Dict, Optional
from urllib.request import ProxyHandler, build_opener

import requests

RUNTIME_VERSION = "1.1.2"
RUNTIME_PORT = 8787


def extract_runtime(archive: Path, destination: Path):
    """Validate the complete archive before writing files or internal workspace links."""
    base = destination.resolve()
    with tarfile.open(archive, "r:gz") as package:
        for member in package.getmembers():
            target = (base / member.name).resolve()
            if target != base and base not in target.parents:
                raise ValueError("运行时压缩包包含越界路径")
            if member.issym() or member.islnk():
                link_base = target.parent if member.issym() else base
                link = (link_base / member.linkname).resolve()
                if link != base and base not in link.parents:
                    raise ValueError("运行时压缩包包含越界链接")
            elif not (member.isfile() or member.isdir()):
                raise ValueError("运行时压缩包包含不支持的文件类型")
        package.extractall(base)


class RuntimeInstaller:
    def __init__(self, plugin_dir: Path, data_dir: Path, proxy: Optional[dict], github_proxy: str):
        self.plugin_dir = plugin_dir
        self.data_dir = data_dir
        self.proxy = proxy
        self.github_proxy = github_proxy

    def ensure(self, stopped: threading.Event) -> Path:
        arch = {"x86_64": "x64", "aarch64": "arm64"}.get(platform.machine())
        if platform.system() != "Linux" or arch is None:
            raise RuntimeError("插件内置运行时支持 Linux x64 和 arm64")
        manifest_path = self.plugin_dir / "runtime-manifest.json"
        if not manifest_path.exists():
            raise RuntimeError("请安装完整的插件 Release，当前安装缺少运行时清单")
        manifest = json.loads(manifest_path.read_text())
        if manifest["version"] != RUNTIME_VERSION:
            raise RuntimeError("插件与运行时清单的版本不一致")
        platform_name = "linux-" + arch
        if platform_name not in manifest["platforms"]:
            raise RuntimeError("当前 Release 尚未提供 %s 运行时" % platform_name)
        artifact = manifest["platforms"][platform_name]
        runtime = self.data_dir / "runtimes" / RUNTIME_VERSION
        marker = runtime / ".installed.json"
        if marker.exists() and json.loads(marker.read_text())["sha256"] == artifact["sha256"]:
            return runtime

        runtime.parent.mkdir(parents=True, exist_ok=True)
        archive = runtime.parent / (RUNTIME_VERSION + ".tar.gz.part")
        staging = runtime.parent / (RUNTIME_VERSION + ".staging")
        url = artifact["url"]
        if self.github_proxy:
            url = self.github_proxy.rstrip("/") + "/" + url
        try:
            digest = hashlib.sha256()
            with requests.get(url, proxies=self.proxy, stream=True, timeout=(10, 30)) as response:
                response.raise_for_status()
                with archive.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        if stopped.is_set():
                            raise InterruptedError("运行时安装已取消")
                        digest.update(chunk)
                        output.write(chunk)
            if digest.hexdigest() != artifact["sha256"]:
                raise ValueError("运行时下载校验失败")
            if stopped.is_set():
                raise InterruptedError("运行时安装已取消")
            shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir()
            extract_runtime(archive, staging)
            (staging / "bin/node").chmod(0o755)
            (staging / ".installed.json").write_text(json.dumps({"sha256": artifact["sha256"]}))
            if runtime.exists():
                shutil.rmtree(runtime)
            staging.rename(runtime)
            return runtime
        finally:
            archive.unlink(missing_ok=True)
            shutil.rmtree(staging, ignore_errors=True)


class ManagedRuntime:
    def __init__(
        self, data_dir: Path, installer: RuntimeInstaller, on_error: Callable[[str], None]
    ):
        self.data_dir = data_dir
        self.installer = installer
        self.on_error = on_error
        self.base_url = "http://127.0.0.1:" + str(RUNTIME_PORT)
        self.state = "disabled"
        self.error = ""
        self._stopped = threading.Event()
        self._thread = None
        self._process = None
        self._lock = threading.Lock()
        self._local_http = build_opener(ProxyHandler({}))
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.chmod(0o700)
        token_path = self.data_dir / "runtime-token"
        if not token_path.exists():
            token_path.write_text(secrets.token_urlsafe(32))
            token_path.chmod(0o600)
        self.token = token_path.read_text().strip()

    def start(self, environment: Dict[str, str]):
        if self._thread and self._thread.is_alive():
            raise RuntimeError("上一个 Agent 进程尚未停止")
        self.error = ""
        self.state = "installing"
        self._stopped.clear()
        self._thread = threading.Thread(target=self._run, args=(environment,), daemon=True)
        self._thread.start()

    def _run(self, environment: Dict[str, str]):
        handler = RotatingFileHandler(
            self.data_dir / "runtime.log", maxBytes=10 * 1024 * 1024, backupCount=2
        )
        reader = None
        try:
            runtime = self.installer.ensure(self._stopped)
            if self._stopped.is_set():
                return
            self.state = "starting"
            env = {
                **os.environ,
                **environment,
                "HOST": "127.0.0.1",
                "PORT": str(RUNTIME_PORT),
                "AGENT_DATA_DIR": str(self.data_dir / "agent-data"),
                "WEB_AUTH_TOKEN": self.token,
                "AGENT_PARENT_PID": str(os.getpid()),
                "NODE_ENV": "production",
            }
            with self._lock:
                if self._stopped.is_set():
                    return
                self._process = subprocess.Popen(
                    [str(runtime / "bin/node"), "--use-env-proxy", "dist/src/server.js"],
                    cwd=runtime / "apps/api",
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    start_new_session=True,
                )
            process = self._process
            reader = threading.Thread(target=self._read_log, args=(process, handler), daemon=True)
            reader.start()
            deadline = time.monotonic() + 60
            while not self._stopped.is_set() and process.poll() is None:
                try:
                    with self._local_http.open(
                        self.base_url + "/api/health", timeout=1
                    ) as response:
                        ready = json.load(response).get("status") == "ok"
                    if ready:
                        self.state = "running"
                        break
                except OSError:
                    # The process is starting; readiness is bounded and never causes a resubmission.
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError("Agent 启动超过 60 秒，请检查 runtime.log")
                self._stopped.wait(0.5)
            while not self._stopped.is_set() and process.poll() is None:
                self._stopped.wait(1)
            if not self._stopped.is_set():
                raise RuntimeError("Agent 进程退出（%s），请检查 runtime.log" % process.returncode)
        except Exception as error:
            if not self._stopped.is_set():
                self.error = str(error)
                self.state = "error"
                self.on_error(self.error)
        finally:
            self._stop_process()
            if reader:
                reader.join(timeout=3)
            handler.close()
            if self._stopped.is_set():
                self.state = "disabled"

    @staticmethod
    def _read_log(process, handler):
        for line in process.stdout:
            handler.emit(
                logging.LogRecord("pi-agent", logging.INFO, "", 0, line.rstrip(), (), None)
            )
        process.stdout.close()

    def _stop_process(self):
        with self._lock:
            process = self._process
            if process is None or process.poll() is not None:
                return
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=35)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)

    def stop(self):
        self._stopped.set()
        self._stop_process()
        if self._thread:
            self._thread.join(timeout=45)
            if self._thread.is_alive():
                raise RuntimeError("Agent 安装线程尚未停止")
        self.state = "disabled"
