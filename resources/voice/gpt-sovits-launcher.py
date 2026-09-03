#!/usr/bin/env python3
"""Nacime-owned GPT-SoVITS launcher.

Runs an existing, unmodified GPT-SoVITS ``api_v2.py`` using that installation's
bundled Python runtime.  Once the requested loopback port really accepts a TCP
connection, prints the ASCII handshake consumed by ``local-process.ts``:

    REAL_PORT_FOUND:<port>

This file lives in Nacime resources; it never writes to the GPT-SoVITS install.
The Node parent kills the whole process tree on shutdown (Windows taskkill /T).
"""

from __future__ import annotations

import argparse
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-script", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--root", required=True)
    parser.add_argument("--jieba-resources", required=True)
    return parser.parse_args()


def port_is_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.25):
            return True
    except OSError:
        return False


def prepare_jieba_overlay(root: str, resources: str) -> str:
    """Builds a temporary package overlay without touching the user install.

    The inspected 0.53 integrated runtime is missing ``jieba_fast/dict.txt``
    and ``analyse/idf.txt``. Import fails before GPT-SoVITS can start. Copy the
    installed package to a temp directory and fill only those MIT-licensed data
    files from Nacime resources; the compiled extension remains in the bundled
    runtime's site-packages.
    """
    source = os.path.join(root, "runtime", "Lib", "site-packages", "jieba_fast")
    if not os.path.isdir(source):
        raise FileNotFoundError("jieba_fast package missing from GPT-SoVITS runtime")
    overlay_root = tempfile.mkdtemp(prefix="nacime-gpt-sovits-")
    target = os.path.join(overlay_root, "jieba_fast")
    shutil.copytree(source, target)
    shutil.copy2(os.path.join(resources, "dict.txt"), os.path.join(target, "dict.txt"))
    analyse = os.path.join(target, "analyse")
    os.makedirs(analyse, exist_ok=True)
    shutil.copy2(os.path.join(resources, "analyse", "idf.txt"), os.path.join(analyse, "idf.txt"))
    return overlay_root


def main() -> int:
    args = parse_args()
    overlay_root = prepare_jieba_overlay(args.root, args.jieba_resources)
    # The bundled embedded Python has python39._pth, which ignores PYTHONPATH even
    # with `import site`. Inject the overlay into sys.path in a tiny -c bootstrap,
    # then run the untouched official api_v2.py via runpy. `-I` remains enabled.
    bootstrap = (
        "import runpy,sys; "
        "overlay=sys.argv.pop(1); script=sys.argv[1]; sys.argv=sys.argv[1:]; "
        "sys.path.insert(0, overlay); "
        "runpy.run_path(script, run_name='__main__')"
    )
    command = [
        sys.executable,
        "-I",
        "-c",
        bootstrap,
        overlay_root,
        args.api_script,
        "-a",
        "127.0.0.1",
        "-p",
        str(args.port),
        "-c",
        args.config,
    ]
    # Inherit stdout/stderr so Node drains the official API logs. windowsHide is
    # owned by Node's spawn options; no shell/batch layer is involved.
    child = subprocess.Popen(command, cwd=args.root, env=os.environ.copy())
    try:
        while child.poll() is None:
            if port_is_open(args.port):
                print(f"REAL_PORT_FOUND:{args.port}", flush=True)
                return child.wait()
            time.sleep(0.2)
        return int(child.returncode or 0)
    except KeyboardInterrupt:
        return 130
    finally:
        if child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
        shutil.rmtree(overlay_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
