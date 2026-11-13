"""Verify allowlisted real ZIP exports with synthetic data, never a user profile."""
import json
import os
import zipfile
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy

import pytest

from backend import diagnostics


@pytest.fixture(autouse=True)
def version_metadata(tmp_path, monkeypatch):
    """Use only temporary app metadata and mocked installed package versions."""
    root = tmp_path / "code"
    root.mkdir()
    (root / "pyproject.toml").write_text('[project]\nversion="0.3.2"\n', encoding="utf-8")
    monkeypatch.setattr(diagnostics, "_ROOT", root)
    monkeypatch.setattr(diagnostics.metadata, "version", lambda name: "0.6.4" if name == "babeldoc" else "1.26.7")


def read_bundle(path):
    """Check ZIP integrity and the sole allowlisted member before decoding JSON."""
    assert path.suffix == ".zip" and zipfile.is_zipfile(path)
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        assert archive.namelist() == ["diagnostics.json"]
        return json.loads(archive.read("diagnostics.json"))


def test_private_data_not_exported_or_read(tmp_path, monkeypatch):
    """Ignore secret-bearing folders and fields rather than trying to redact logs."""
    state = tmp_path / "state"
    state.mkdir()
    secrets = ["sk-synthetic-secret", "synthetic-bearer-token", "论文秘密正文", "/home/private/paper.pdf", "C:\\Users\\Private\\paper.pdf"]
    private = " ".join(secrets)
    for name in ("token", "source.pdf", "translated.pdf", "stderr.log", "logins.json", "key4.db"):
        (state / name).write_text(private, encoding="utf-8")
    monkeypatch.setenv("OPENAI_API_KEY", secrets[0])
    jobs = [{"state": "failed", "quality": {"status": "unusable", "reason": private},
             "id": private, "api_key": private, "config": {"token": private}, "error": private,
             "source_path": secrets[3], "output_path": secrets[4], "stage": private, "attempts": [{"stderr": private}]},
            {"state": "done", "quality": {"status": "complete"}},
            {"state": private, "quality": {"status": private}}]
    original = deepcopy(jobs)
    # A directory scan would fail even if its contents were later filtered out.
    monkeypatch.setattr(diagnostics.Path, "iterdir", lambda self: pytest.fail("must not scan state"))
    payload = read_bundle(diagnostics.create_bundle(jobs, state))
    assert set(payload) == {"schema_version", "versions", "platform", "tasks", "safety"}
    assert set(payload["versions"]) == {"paperbridge", "python", "babeldoc", "pymupdf"}
    assert payload["tasks"]["total"] == 3
    assert payload["tasks"]["states"]["failed"] == 1
    assert payload["tasks"]["states"]["done"] == 1
    assert payload["tasks"]["states"]["unknown"] == 1
    assert payload["tasks"]["quality"]["unusable"] == 1
    assert payload["tasks"]["quality"]["complete"] == 1
    assert payload["tasks"]["quality"]["unknown"] == 1
    encoded = json.dumps(payload, ensure_ascii=False)
    for secret in secrets + [str(tmp_path)]:
        assert secret not in encoded
    assert jobs == original
    for name in ("token", "source.pdf", "translated.pdf", "stderr.log", "logins.json", "key4.db"):
        assert (state / name).read_text(encoding="utf-8") == private


def test_store_contract_and_noncovering_export(tmp_path):
    """Support both list APIs and HTTP-list shape without replacing older exports."""
    class Store:
        """Return synthetic public jobs without any on-disk record reads."""
        # Warning text is private; only the number may leave the store.
        load_warnings = ["/home/private/damaged-record.json sk-fixture-secret"]

        def list_jobs(self):
            """Match the existing JobStore API."""
            return [{"state": "running", "quality": {"status": "partial"}}]

    class AlternateStore:
        """Support the proposed public list API."""
        def list(self):
            """Return the same public job shape."""
            return [{"state": "queued"}]

    first = diagnostics.create_bundle(Store(), tmp_path)
    original = first.read_bytes()
    second = diagnostics.create_bundle(AlternateStore(), tmp_path)
    third = diagnostics.create_bundle({"jobs": []}, tmp_path)
    assert len({first, second, third}) == 3
    assert first.read_bytes() == original
    assert first.parent == tmp_path / "diagnostics"
    assert read_bundle(first)["tasks"]["states"]["running"] == 1
    assert read_bundle(first)["safety"]["warning_count"] == 1
    assert "damaged-record" not in json.dumps(read_bundle(first))
    assert read_bundle(second)["tasks"]["states"]["queued"] == 1
    assert read_bundle(second)["safety"]["warning_count"] is None
    assert read_bundle(third)["tasks"]["total"] == 0
    if os.name != "nt":
        assert first.stat().st_mode & 0o777 == 0o600


def test_concurrent_exports_are_unique(tmp_path):
    """Reserve independent filenames even when multiple requests arrive together."""
    with ThreadPoolExecutor(max_workers=4) as pool:
        paths = list(pool.map(lambda _: diagnostics.create_bundle([], tmp_path), range(4)))
    assert len(set(paths)) == 4
    for path in paths:
        assert read_bundle(path)["tasks"]["total"] == 0


def test_failed_export_preserves_existing_bundle(tmp_path, monkeypatch):
    """Remove only a failed new ZIP, never an older diagnostic or task file."""
    existing = diagnostics.create_bundle([], tmp_path)
    original = existing.read_bytes()

    def fail_write(*args, **kwargs):
        """Simulate an export-specific disk failure."""
        raise OSError("synthetic write failure")

    monkeypatch.setattr(diagnostics.zipfile.ZipFile, "writestr", fail_write)
    with pytest.raises(OSError, match="synthetic"):
        diagnostics.create_bundle([], tmp_path)
    assert list(existing.parent.iterdir()) == [existing]
    assert existing.read_bytes() == original


def test_arbitrary_metadata_is_not_copied(tmp_path, monkeypatch):
    """Drop unknown platform values and metadata strings with private paths."""
    (diagnostics._ROOT / "installed.json").write_text('{"version":"/home/private/key"}', encoding="utf-8")
    monkeypatch.setattr(diagnostics.metadata, "version", lambda name: "sk-fixture-secret")
    monkeypatch.setattr(diagnostics.platform, "machine", lambda: "private-hostname")
    payload = read_bundle(diagnostics.create_bundle([{"state": [], "quality": {"status": {}}}], tmp_path))
    assert payload["versions"]["paperbridge"] == "unknown"
    assert payload["versions"]["babeldoc"] == "unknown"
    assert payload["platform"]["architecture"] == "other"
    assert "private" not in json.dumps(payload)


def test_explicit_warning_count_without_warning_text(tmp_path):
    """Support a detached job list while ignoring supplied raw warning messages."""
    bundle = diagnostics.create_bundle({"jobs": [], "warning_count": 3,
        "load_warnings": ["/home/private/broken.json sk-fixture-secret"]}, tmp_path)
    payload = read_bundle(bundle)
    assert payload["safety"]["warning_count"] == 3
    assert "private" not in json.dumps(payload)
    invalid = read_bundle(diagnostics.create_bundle({"jobs": [], "warning_count": "private-path"}, tmp_path))
    assert invalid["safety"]["warning_count"] is None
