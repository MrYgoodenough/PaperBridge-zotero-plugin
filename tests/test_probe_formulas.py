"""Check only explicit page selection, read-only output and offline socket contracts."""
import subprocess
import sys
from pathlib import Path

# Invoke the developer CLI without importing the heavy inference dependencies.
ROOT = Path(__file__).resolve().parents[1]


def run_cli(*arguments):
    """Run a fresh bytecode-free probe process with captured diagnostics."""
    return subprocess.run([sys.executable, "-B", str(ROOT / "scripts" / "probe_formulas.py"),
                           *map(str, arguments)], capture_output=True, text=True, timeout=20)


def test_pages_are_explicit_and_nonnegative(tmp_path):
    """Never substitute all pages for missing or negative zero-based selections."""
    output = tmp_path / "probe.json"
    result = run_cli("missing.pdf", "--output", output)
    assert result.returncode == 2 and "--pages" in result.stderr
    result = run_cli("missing.pdf", "--pages", -1, "--output", output)
    assert result.returncode == 2 and "nonnegative" in result.stderr
    assert not output.exists()


def test_output_cannot_overwrite_or_enter_source_cache(tmp_path):
    """Reject unsafe outputs before loading dependencies or creating probe scratch."""
    output = tmp_path / "existing.json"
    output.write_text("keep", encoding="utf-8")
    result = run_cli("missing.pdf", "--pages", 0, "--output", output)
    assert result.returncode == 2 and "never overwritten" in result.stderr
    assert output.read_text(encoding="utf-8") == "keep"
    cache = tmp_path / "source-cache"
    result = run_cli("missing.pdf", "--pages", 0, "--cache-dir", cache,
                     "--output", cache / "probe.json")
    assert result.returncode == 2 and "outside" in result.stderr
    assert not cache.exists()


def test_network_guard_blocks_dns_tcp_and_udp():
    """Exercise the real audit guard in a child so it cannot leak into other tests."""
    code = f"""
import socket
import sys
sys.path.insert(0, {str(ROOT / 'scripts')!r})
from probe_formulas import install_network_guard
install_network_guard()
with socket.socket() as tcp, socket.socket(type=socket.SOCK_DGRAM) as udp:
    attempts = [
        (socket.getaddrinfo, ('example.invalid', 443)),
        (tcp.connect, (('127.0.0.1', 9),)),
        (tcp.connect_ex, (('127.0.0.1', 9),)),
        (udp.sendto, (b'probe', ('127.0.0.1', 9))),
    ]
    for operation, arguments in attempts:
        try:
            operation(*arguments)
        except RuntimeError as error:
            assert 'Outbound network is disabled' in str(error)
        else:
            raise AssertionError('Network operation was not blocked')
"""
    result = subprocess.run([sys.executable, "-B", "-c", code], capture_output=True,
                            text=True, timeout=20)
    assert result.returncode == 0, result.stderr
