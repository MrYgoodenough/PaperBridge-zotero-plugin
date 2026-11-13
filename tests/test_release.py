"""Verify tiny real build.py outputs and mocked public metadata without a network."""
from copy import deepcopy
import hashlib
from io import BytesIO
import json
from pathlib import Path
import platform
import runpy
import sys
from unittest.mock import Mock
from urllib.error import HTTPError
import zipfile

import pytest

# Import scripts without running build.py's command-line entry point.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import verify_release as verifier

# Host identities are simulated only for tiny temporary stages, not native builds.
HOSTS = (("linux", "x86_64", "linux-x64"), ("darwin", "arm64", "macos-arm64"),
         ("win32", "AMD64", "windows-x64"))


@pytest.fixture
def build_release(tmp_path, monkeypatch):
    """Run the unchanged builder on synthetic runtimes inside a disposable checkout."""
    files = {
        "scripts/build.py": (ROOT / "scripts/build.py").read_bytes(),
        "addon/manifest.json": (ROOT / "addon/manifest.json").read_bytes(),
        "addon/bootstrap.js": b"// Synthetic bootstrap.\n",
        "addon/content/runtime.js": b"// Synthetic runtime controller.\n",
        "addon/content/library.js": b"// Synthetic library controller.\n",
        "addon/content/tasks.js": b"// Synthetic task controller.\n",
        "addon/content/alignment.js": b"// Synthetic alignment controller.\n",
        "addon/content/paperbridge.js": b"// Synthetic addon.\n",
        "addon/content/annotations.js": b"// Synthetic annotation controller.\n",
        "LICENSE": b"Synthetic license.\n",
    }
    for source in (ROOT / "backend").glob("*.py"):
        files["backend/" + source.name] = f'"""Synthetic {source.name} module."""\n'.encode()
    for _, _, target in HOSTS:
        interpreter, packages = verifier.PLATFORMS[target]
        prefix = f".cache/package/{target}/"
        files.update({
            prefix + "runtime.json": json.dumps({
                "version": "0.0.0", "platform": target, "python": "3.12.0", "packages": []
            }).encode(),
            prefix + interpreter: b"Synthetic interpreter.\n",
            prefix + packages + "/native/module.bin": target.encode(),
            prefix + packages + "/certifi/cacert.pem": b"Synthetic public certificate.\n",
            prefix + packages + "/secrets.py": b"# Legitimate dependency module.\n",
            prefix + ".cache/babeldoc/models/layout.onnx": b"Synthetic model.\n",
            prefix + ".cache/babeldoc/tiktoken/vocabulary": b"Synthetic vocabulary.\n",
            prefix + ".cache/babeldoc/fonts/private.ttf": b"Not a distributable asset.\n",
        })
    for relative, contents in files.items():
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
    monkeypatch.syspath_prepend(str(ROOT / "scripts"))
    monkeypatch.setattr(verifier, "urlopen", Mock(side_effect=AssertionError("No external network in tests")))

    def build(host="linux", machine="x86_64", target="linux-x64", mode="bundled"):
        """Return explicit XPI, sidecar, feed and source-manifest fixture paths."""
        script = tmp_path / "scripts/build.py"
        with monkeypatch.context() as native:
            native.setattr(sys, "platform", host)
            native.setattr(platform, "machine", Mock(return_value=machine))
            native.setattr(sys, "argv", [str(script), "--python", mode])
            runpy.run_path(str(script), run_name="__main__")
        manifest = tmp_path / "addon/manifest.json"
        version = json.loads(manifest.read_bytes())["version"]
        suffix = "-local-python" if mode == "local" else ""
        xpi = tmp_path / "dist" / f"paperbridge-{version}-{target}{suffix}.xpi"
        feed = tmp_path / "dist/updates" / f"{target}{suffix}.json"
        return xpi, xpi.with_suffix(".xpi.sha256"), feed, manifest

    return build


def _refresh_hashes(artifacts):
    """Keep fixture sidecar/feed valid so archive mutations reach deeper checks."""
    xpi, sidecar, feed, _ = artifacts
    digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
    sidecar.write_text(f"{digest}  {xpi.name}\n", encoding="utf-8")
    draft = json.loads(feed.read_bytes())
    next(iter(draft["addons"].values()))["updates"][0]["update_hash"] = "sha256:" + digest
    feed.write_text(json.dumps(draft), encoding="utf-8")


def _rewrite_xpi(artifacts, *, replace=None, remove=()):
    """Rewrite only a tiny synthetic XPI, then refresh its advertised final hash."""
    with zipfile.ZipFile(artifacts[0]) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    entries.update(replace or {})
    for name in remove:
        entries.pop(name)
    with zipfile.ZipFile(artifacts[0], "w", zipfile.ZIP_DEFLATED) as archive:
        for name, contents in sorted(entries.items()):
            archive.writestr(name, contents)
    _refresh_hashes(artifacts)


def test_real_builder_outputs_pass_all_six_channels(build_release):
    """Match all platform/mode outputs and leave every explicit input untouched."""
    for host, machine, target in HOSTS:
        for mode in ("bundled", "local"):
            artifacts = build_release(host, machine, target, mode)
            before = [path.read_bytes() for path in artifacts]
            result = verifier.verify_release(*artifacts)
            assert (result["platform"], result["pythonMode"]) == (target, mode)
            assert result["sha256"] == hashlib.sha256(before[0]).hexdigest()
            assert result["buildId"]
            assert [path.read_bytes() for path in artifacts] == before
    verifier.urlopen.assert_not_called()


def test_sidecar_requires_final_xpi_hash_and_filename(build_release):
    """Reject stale/malformed sidecars while accepting normal text/binary records."""
    artifacts = build_release()
    xpi, sidecar, _, _ = artifacts
    original = sidecar.read_bytes()
    digest = hashlib.sha256(xpi.read_bytes()).hexdigest()
    for contents in (
        f"{'0' * 64}  {xpi.name}\n".encode(),
        f"{digest}  another.xpi\n".encode(),
        original + original,
        b"\xff",
    ):
        sidecar.write_bytes(contents)
        with pytest.raises(verifier.VerificationError, match="SHA-256 sidecar"):
            verifier.verify_release(*artifacts)
    sidecar.write_bytes(f"{digest.upper()} *{xpi.name}\r\n".encode())
    assert verifier.verify_release(*artifacts)["sha256"] == digest


def test_feed_matches_identity_hash_compatibility_and_channel(build_release):
    """Reject draft-feed drift instead of declaring an automatic update successful."""
    artifacts = build_release()
    _, _, feed, _ = artifacts
    original = json.loads(feed.read_bytes())
    addon_id = next(iter(original["addons"]))
    changes = (
        ("version", "9.9.9", "Feed version"),
        ("update_hash", "sha256:" + "0" * 64, "Feed SHA-256"),
        ("update_link", "https://example.invalid/other.xpi", "Feed update link"),
    )
    for key, value, message in changes:
        draft = deepcopy(original)
        draft["addons"][addon_id]["updates"][0][key] = value
        feed.write_text(json.dumps(draft), encoding="utf-8")
        with pytest.raises(verifier.VerificationError, match=message):
            verifier.verify_release(*artifacts)
    draft = deepcopy(original)
    draft["addons"]["wrong@addon"] = draft["addons"].pop(addon_id)
    feed.write_text(json.dumps(draft), encoding="utf-8")
    with pytest.raises(verifier.VerificationError, match="Feed addon ID"):
        verifier.verify_release(*artifacts)
    draft = deepcopy(original)
    draft["addons"][addon_id]["updates"][0]["applications"]["zotero"]["strict_max_version"] = "99.*"
    feed.write_text(json.dumps(draft), encoding="utf-8")
    with pytest.raises(verifier.VerificationError, match="Feed Zotero"):
        verifier.verify_release(*artifacts)
    feed.write_text(json.dumps(original), encoding="utf-8")
    other_feed = feed.with_name("linux-x64-local-python.json")
    other_feed.write_bytes(feed.read_bytes())
    with pytest.raises(verifier.VerificationError, match="Feed filename"):
        verifier.verify_release(artifacts[0], artifacts[1], other_feed, artifacts[3])


def test_runtime_identity_and_new_modules_are_required(build_release):
    """Detect stale identities, mismatched runtime metadata and missing new modules."""
    for key, value, message in (
        ("version", "9.9.9", "Runtime version"),
        ("platform", "windows-x64", "Runtime platform"),
        ("pythonMode", "unknown", "Runtime pythonMode"),
        ("pythonMode", "local", "XPI filename"),
        ("payloadSha256", "", "Runtime payloadSha256"),
        ("buildId", "0" * 64, "Runtime buildId"),
    ):
        artifacts = build_release()
        member = "runtime/linux-x64/runtime.json"
        with zipfile.ZipFile(artifacts[0]) as archive:
            metadata = json.loads(archive.read(member))
        metadata[key] = value
        _rewrite_xpi(artifacts, replace={member: json.dumps(metadata).encode()})
        with pytest.raises(verifier.VerificationError, match=message):
            verifier.verify_release(*artifacts)
    for member in ("content/annotations.js", "runtime/linux-x64/backend/errors.py",
                   "runtime/linux-x64/backend/diagnostics.py", "runtime/linux-x64/python/bin/python3.12"):
        artifacts = build_release()
        _rewrite_xpi(artifacts, remove=(member,))
        with pytest.raises(verifier.VerificationError, match="Required module|interpreter presence"):
            verifier.verify_release(*artifacts)
    artifacts = build_release()
    _rewrite_xpi(artifacts, replace={"runtime/linux-x64/backend/diagnostics.py": b"# Changed after build.\n"})
    with pytest.raises(verifier.VerificationError, match="Runtime buildId"):
        verifier.verify_release(*artifacts)
    for key, value, message in (("id", "wrong@addon", "Built addon ID"),
                                ("update_url", "https://example.invalid/feed.json", "Addon update URL")):
        artifacts = build_release()
        with zipfile.ZipFile(artifacts[0]) as archive:
            manifest = json.loads(archive.read("manifest.json"))
        manifest["applications"]["zotero"][key] = value
        _rewrite_xpi(artifacts, replace={"manifest.json": json.dumps(manifest).encode()})
        with pytest.raises(verifier.VerificationError, match=message):
            verifier.verify_release(*artifacts)


def test_private_entries_and_mixed_runtimes_fail(build_release):
    """Permit packaged assets/public certificates, but not local state or mode leaks."""
    for name in (
        ".env", "runtime/linux-x64/backend/credentials-local.json", "runtime/linux-x64/key4.db",
        "runtime/linux-x64/backend/service.log", "runtime/linux-x64/backend/__pycache__/server.pyc",
        "runtime/linux-x64/.cache/babeldoc/fonts/user.ttf", "runtime/linux-x64/.cache/babeldoc/models/.env",
        "runtime/linux-x64/private.pem", "../outside.txt", "runtime/windows-x64/extra.bin",
    ):
        artifacts = build_release()
        _rewrite_xpi(artifacts, replace={name: b"Synthetic private data; never a real credential.\n"})
        with pytest.raises(verifier.VerificationError, match="must not ship|unsafe archive path|another platform"):
            verifier.verify_release(*artifacts)
    artifacts = build_release(mode="local")
    _rewrite_xpi(artifacts, replace={"runtime/linux-x64/python/bin/python3.12": b"Interpreter leak.\n"})
    with pytest.raises(verifier.VerificationError, match="Local-Python XPI"):
        verifier.verify_release(*artifacts)
    artifacts = build_release()
    with pytest.warns(UserWarning, match="Duplicate name"):
        with zipfile.ZipFile(artifacts[0], "a") as archive:
            archive.writestr("LICENSE", b"Duplicate.\n")
    _refresh_hashes(artifacts)
    with pytest.raises(verifier.VerificationError, match="duplicate archive entries"):
        verifier.verify_release(*artifacts)


def test_cli_distinguishes_local_public_and_untested_updates(build_release, monkeypatch, capsys):
    """Mock only public GET/HEAD responses; never download an XPI or use credentials."""
    artifacts = build_release()
    result = verifier.verify_release(*artifacts)
    argv = ["--xpi", str(artifacts[0]), "--sha256", str(artifacts[1]), "--feed", str(artifacts[2]),
            "--source-manifest", str(artifacts[3])]
    capsys.readouterr()
    assert verifier.main(argv) == 0
    output = capsys.readouterr()
    assert "LOCAL-CONSISTENT" in output.out and "PUBLICATION-NOT-CHECKED" in output.out
    assert "AUTOMATIC-UPDATE-NOT-TESTED" in output.out and not output.err
    verifier.urlopen.assert_not_called()
    checksum = artifacts[1].read_bytes()
    release = {
        "tag_name": "v" + result["version"], "draft": False, "published_at": "2026-01-01T00:00:00Z",
        "assets": [
            {"name": result["xpiName"], "state": "uploaded", "browser_download_url": result["updateLink"],
             "size": result["xpiSize"], "digest": "sha256:" + result["sha256"]},
            {"name": result["xpiName"] + ".sha256", "state": "uploaded",
             "browser_download_url": result["updateLink"] + ".sha256", "size": len(checksum),
             "digest": "sha256:" + hashlib.sha256(checksum).hexdigest()},
        ],
    }
    calls = []
    public_feed = deepcopy(result["feed"])
    # Missing resources must identify the failed publication step, not another channel.
    http_failures = {}

    def public_response(request, timeout):
        """Serve bounded in-memory responses and assert read-only/auth-free requests."""
        url, method = request.full_url, request.get_method()
        calls.append((url, method))
        assert method in {"GET", "HEAD"} and timeout == verifier.HTTP_TIMEOUT
        assert not request.has_header("Authorization")
        if url in http_failures:
            raise HTTPError(url, http_failures[url], "Not Found", {}, None)
        if url == result["updateUrl"]:
            contents = json.dumps(public_feed).encode()
        elif url.startswith("https://api.github.com/repos/"):
            contents = json.dumps(release).encode()
        elif url == result["updateLink"] + ".sha256":
            contents = checksum
        else:
            assert url == result["updateLink"] and method == "HEAD"
            contents = b""
        response = BytesIO(contents)
        response.status = 200
        return response

    monkeypatch.setattr(verifier, "urlopen", public_response)
    assert verifier.main(argv + ["--online"]) == 0
    output = capsys.readouterr()
    assert "PUBLISHED-METADATA-VERIFIED" in output.out and not output.err
    assert "AUTOMATIC-UPDATE-NOT-TESTED" in output.out
    assert [method for _, method in calls] == ["GET", "GET", "HEAD", "GET"]
    api_url = calls[1][0]
    assert api_url.endswith("/releases/tags/v" + result["version"])
    for url, label, hint in (
        (result["updateUrl"], "master/updates/linux-x64.json", "dist/updates contains local drafts only"),
        (api_url, "GitHub release metadata for v" + result["version"], "exact tag is publicly readable"),
        (result["updateLink"], "Public XPI " + result["xpiName"], "exact-tag XPI download"),
        (result["updateLink"] + ".sha256", "Public checksum " + result["xpiName"], "separately uploaded"),
    ):
        http_failures[url] = 404
        assert verifier.main(argv + ["--online"]) == 1
        output = capsys.readouterr()
        assert "PUBLICATION-NOT-VERIFIED" in output.err and "HTTP 404" in output.err
        assert label in output.err and hint in output.err
        assert "PUBLISHED-METADATA-VERIFIED" not in output.out
        http_failures.clear()
    assert not any("/releases/latest" in url for url, _ in calls)
    xpi_asset = release["assets"].pop(0)
    assert verifier.main(argv + ["--online"]) == 1
    output = capsys.readouterr()
    assert result["xpiName"] in output.err and "GitHub release v" + result["version"] in output.err
    assert "not a per-platform fallback" in output.err
    release["assets"].insert(0, xpi_asset)
    release["assets"][0]["digest"] = None
    assert verifier.main(argv + ["--online"]) == 1
    output = capsys.readouterr()
    assert "LOCAL-CONSISTENT" in output.out and "PUBLISHED-METADATA-VERIFIED" not in output.out
    assert "PUBLICATION-NOT-VERIFIED" in output.err and "missing or mismatched" in output.err
    release["assets"][0]["digest"] = "sha256:" + result["sha256"]
    next(iter(public_feed["addons"].values()))["updates"][0]["update_hash"] = "sha256:" + "0" * 64
    assert verifier.main(argv + ["--online"]) == 1
    output = capsys.readouterr()
    assert "Public feed differs" in output.err and "version " + result["version"] in output.err
    assert "do not overwrite it" in output.err
    for older_version in ("0.0.1", None):
        public_feed = deepcopy(result["feed"])
        public_updates = next(iter(public_feed["addons"].values()))["updates"]
        if older_version is None:
            public_updates.clear()
        else:
            public_updates[0]["version"] = older_version
        assert verifier.main(argv + ["--online"]) == 1
        output = capsys.readouterr()
        assert "PUBLICATION-NOT-VERIFIED" in output.err and "do not overwrite it" in output.err
        assert "PUBLISHED-METADATA-VERIFIED" not in output.out
    public_feed = deepcopy(result["feed"])
    release["draft"] = True
    assert verifier.main(argv + ["--online"]) == 1
    assert "not publicly published" in capsys.readouterr().err
    release["draft"] = False
    release["assets"][1]["digest"] = None
    assert verifier.main(argv + ["--online"]) == 1
    assert "checksum asset size/digest" in capsys.readouterr().err


@pytest.mark.parametrize("status", (403, 404))
def test_public_http_errors_do_not_echo_request_or_response(monkeypatch, status):
    """Keep resource labels useful without leaking signed redirects or error bodies."""
    private_url = "https://example.invalid/asset?token=private-request-token"
    monkeypatch.setattr(verifier, "urlopen", Mock(side_effect=HTTPError(
        private_url, status, "private-response-body", {}, BytesIO(b"private-response-body"),
    )))
    with pytest.raises(verifier.VerificationError) as error:
        verifier._read_public(private_url, label="Public checksum", missing_hint="Upload the matching sidecar.")
    message = str(error.value)
    assert "Public checksum" in message and f"HTTP {status}" in message
    assert ("Upload the matching sidecar." in message) == (status == 404)
    assert private_url not in message and "private-response" not in message
