"""Keep the opt-in metadata helper compatible with the production Zotero manifest."""

import json
from pathlib import Path
import runpy
from types import SimpleNamespace
import zipfile

# Load the real preparation entry point without running its CLI or touching a daily profile.
ROOT = Path(__file__).resolve().parents[1]


def test_metadata_helper_has_required_native_manifest(tmp_path):
    """Keep required update_url and production compatibility in the natively installed helper."""
    profile, data = tmp_path / "profile", tmp_path / "data"
    profile.mkdir()
    data.mkdir()
    (data / "zotero.sqlite").touch()
    options = SimpleNamespace(
        profile=profile, data=data, account="fixture-account", run_id="metadata-compatibility",
        phase="metadata-produce", version="0.3.6", label="", output_dir=tmp_path / "output",
        allow_library_file_sync=False, keep_open=False, cases=None, index=None, xpi=None,
    )
    prepare = runpy.run_path(str(ROOT / "scripts/prepare_account_sync.py"))["prepare"]
    result = prepare(options)
    expected = json.loads((ROOT / "addon/manifest.json").read_text(encoding="utf-8"))["applications"]["zotero"]
    with zipfile.ZipFile(result["helper"]) as archive:
        actual = json.loads(archive.read("manifest.json"))["applications"]["zotero"]
    for field in ("strict_min_version", "strict_max_version"):
        assert actual[field] == expected[field]
    assert actual["update_url"] == "https://example.invalid/paperbridge-account-tests.json"
    config = json.loads(Path(result["config"]).read_text(encoding="utf-8"))
    assert config["allowLibraryFileSync"] is False
    assert not list(profile.iterdir())
