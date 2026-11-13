"""Run offline core or full-engine contracts without provider calls or external pytest plugins."""
import argparse
import ast
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile

# Resolve commands relative to this checkout, not the caller's working directory.
ROOT = Path(__file__).resolve().parents[1]
# Remove inherited runtime paths, pytest injections and common credential variables.
EXCLUDED_ENV = {
    "PYTHONHOME", "PYTHONPATH", "LD_LIBRARY_PATH", "LD_PRELOAD",
    "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES",
    "PYTEST_ADDOPTS", "PYTEST_PLUGINS", "SSH_AUTH_SOCK",
}
# Only loopback TCP is needed by the local HTTP service tests.
LOOPBACK = {"localhost", "127.0.0.1", "::1"}
# These modules require the pinned engine or scientific reference implementations.
FULL_ONLY_MODULES = (
    "test_compact_math.py", "test_deepseek.py", "test_engine_progress.py",
    "test_quality.py", "test_usage.py",
)
# The rest of provider inspection is lightweight; this test uses BabelDOC's real SDK adapter.
FULL_ONLY_CASES = ("test_verify_providers.py::test_one_request_each_and_original_error_sanitized",)


def clean_environment():
    """Keep host tooling usable while dropping credential and Python path inheritance."""
    env = {
        key: value for key, value in os.environ.items()
        if key not in EXCLUDED_ENV
        and not re.search(r"(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", key, re.I)
    }
    env.update(PYTEST_DISABLE_PLUGIN_AUTOLOAD="1", PYTHONNOUSERSITE="1", PYTHONUTF8="1")
    return env


def install_network_guard():
    """Block external DNS and socket connections in the pytest process, allowing loopback."""
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_getaddrinfo = socket.getaddrinfo

    def check_address(address):
        """Reject external Internet endpoints before DNS or connection attempts."""
        if isinstance(address, tuple) and str(address[0]).lower() not in LOOPBACK:
            raise RuntimeError("Offline tests cannot contact external endpoints")

    def connect(sock, address):
        """Permit local service tests but never connect to a provider."""
        check_address(address)
        return original_connect(sock, address)

    def connect_ex(sock, address):
        """Apply the same guard to non-raising socket connection calls."""
        check_address(address)
        return original_connect_ex(sock, address)

    def getaddrinfo(host, *args, **kwargs):
        """Prevent external DNS lookup while preserving loopback and passive bindings."""
        if host is not None:
            check_address((host,))
        return original_getaddrinfo(host, *args, **kwargs)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex
    socket.getaddrinfo = getaddrinfo


def run_python_tests(mode):
    """Use native temporary paths; lightweight needs only pytest, PyMuPDF and httpx."""
    install_network_guard()
    # Match `python -m pytest` imports without inheriting a host PYTHONPATH.
    sys.path.insert(0, str(ROOT))
    import pytest
    options = [str(ROOT / "tests"), "-q", "--rootdir", str(ROOT), "--confcutdir", str(ROOT),
               "-o", "addopts=", "-p", "no:cacheprovider"]
    if mode == "lightweight":
        print("Lightweight dependencies: pytest, PyMuPDF, httpx", flush=True)
        print("Full-only engine/scientific tests:", ", ".join(FULL_ONLY_MODULES + FULL_ONLY_CASES),
              flush=True)
        options.extend(f"--ignore={ROOT / 'tests' / name}" for name in FULL_ONLY_MODULES)
        # Pytest node IDs stay repository-relative with forward slashes on every OS.
        options.extend(f"--deselect=tests/{name}" for name in FULL_ONLY_CASES)
    # Do not reuse a checkout's previous basetemp, bundled runtime or another OS's paths.
    with tempfile.TemporaryDirectory(prefix="pb-offline-") as temporary:
        return pytest.main(options + ["--basetemp", str(Path(temporary) / "pytest")])


def main():
    """Run independent checks to completion and return failure if any contract fails."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("lightweight", "full"), default="full",
                        help="lightweight: core dependencies only; full: installed pinned-engine tests too")
    parser.add_argument("--python-tests", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.python_tests:
        # This private mode is normally entered through the clean child environment.
        env = clean_environment()
        os.environ.clear()
        os.environ.update(env)
        return run_python_tests(args.mode)

    env = clean_environment()
    failures = []
    for folder in ("backend", "scripts", "tests"):
        for path in sorted((ROOT / folder).rglob("*.py")):
            try:
                ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
            except (SyntaxError, UnicodeError) as error:
                failures.append(str(path.relative_to(ROOT)))
                print(error, file=sys.stderr)

    print(f"Offline mode: {args.mode}; Python {sys.version.split()[0]} on {sys.platform}", flush=True)
    commands = [[sys.executable, "-s", str(Path(__file__).resolve()),
                 "--python-tests", "--mode", args.mode]]
    for folder in ("addon", "tests"):
        commands.extend(
            ["node", "--check", str(path)]
            for path in sorted((ROOT / folder).rglob("*"))
            if path.suffix in {".js", ".cjs"}
        )
    # Discover new built-in Node suites without requiring a CI manifest update.
    commands.extend(["node", str(path)] for path in sorted((ROOT / "tests").glob("test_*.cjs")))
    for command in commands:
        print("Running:", " ".join(command), flush=True)
        try:
            result = subprocess.run(command, cwd=ROOT, env=env, check=False)
            if result.returncode:
                failures.append(" ".join(command))
        except OSError as error:
            failures.append(" ".join(command))
            print(error, file=sys.stderr)
    print(f"Offline contracts: {'FAILED' if failures else 'passed'}; {len(failures)} failures")
    return int(bool(failures))


if __name__ == "__main__":
    raise SystemExit(main())
