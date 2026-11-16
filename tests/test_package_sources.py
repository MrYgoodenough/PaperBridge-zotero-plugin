"""Check tracked source membership and exact addon/backend bindings without native execution."""
from io import BytesIO
import json
import sys
from pathlib import Path
import zipfile

import pytest

# Import the source packager without executing its command-line entry point.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import package_sources


def test_project_snapshot_includes_build_tests_without_private_untracked_files(tmp_path, monkeypatch):
    """Keep workflow test inputs and disclose unstaged tests without copying private artifacts."""
    tracked = [".github/workflows/release-candidate.yml", "scripts/check_offline.py",
               "tests/test_release.py", "tests/test_runtime.cjs", "docs/engine-and-alignment.md",
               "addon/content/ui.css"]
    untracked = "tests/test_unstaged.py"
    changed = []
    for name in tracked + [untracked, "agent/codex/private.json", ".runtime/private.json"]:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("Synthetic source-packaging membership input.\n")

    def git_output(command):
        """Simulate Git membership only; never initialize or mutate a repository."""
        scopes = command[command.index("--") + 1:] if "--" in command else []
        if "rev-parse" in command:
            return b"synthetic-head\n"
        if "diff" in command:
            return b"\0".join(name.encode() for name in changed)
        candidates = [untracked] if "--others" in command else tracked
        selected = [name for name in candidates if not scopes or
                    any(name.startswith(scope + "/") for scope in scopes)]
        return b"\0".join(name.encode() for name in selected) + b"\0"

    monkeypatch.setattr(package_sources, "ROOT", tmp_path)
    monkeypatch.setattr(package_sources.subprocess, "check_output", git_output)
    paths = package_sources.project_files()
    included = {path.relative_to(tmp_path).as_posix() for path in paths}
    assert set(tracked) <= included
    assert untracked not in included
    assert not any(name.startswith(("agent/", ".runtime/")) for name in included)
    snapshot = package_sources.project_snapshot(paths)
    assert snapshot["excludedUntrackedSourceFiles"] == [untracked]
    assert snapshot["fromCommitOnly"] is True
    deleted = "addon/content/ui.css"
    (tmp_path / deleted).unlink()
    changed.append(deleted)
    snapshot = package_sources.project_snapshot(package_sources.project_files())
    assert snapshot["missingTrackedFiles"] == [deleted]
    assert snapshot["modifiedTrackedFiles"] == [deleted]
    assert snapshot["fromCommitOnly"] is False


@pytest.mark.parametrize("change,expected", (
    ("none", []), ("missing_addon", ["content/paperbridge.js"]),
    ("missing_backend", ["runtime/linux-x64/backend/server.py"]),
    ("missing_asset", ["content/ui.css"]), ("changed_asset", ["content/ui.css"]),
    ("extra_asset", ["content/obsolete.svg"]),
))
def test_shipped_sources_match_complete_project_membership(tmp_path, monkeypatch, change, expected):
    """Report missing/current and obsolete shipped files, including non-Python frontend assets."""
    prefix = "runtime/linux-x64/"
    local_files = {"addon/content/paperbridge.js": b"// Synthetic addon.\n",
                   "addon/content/ui.css": b"/* Synthetic styles. */\n",
                   "backend/server.py": b'"""Synthetic backend."""\n',
                   "LICENSE": b"Synthetic notice.\n"}
    for name, data in local_files.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    shipped_files = {name.removeprefix("addon/") if name.startswith("addon/") else
                     prefix + name if name.startswith("backend/") else name: data
                     for name, data in local_files.items()}
    if change.startswith("missing_"):
        del shipped_files[expected[0]]
    elif change != "none":
        shipped_files[expected[0]] = b"Synthetic changed or obsolete asset.\n"
    xpi = tmp_path / "evidence.xpi"
    with zipfile.ZipFile(xpi, "w") as archive:
        archive.writestr(prefix + "runtime.json", json.dumps({"platform": "linux-x64", "pythonMode": "bundled"}))
        for name, data in shipped_files.items():
            archive.writestr(name, data)
    monkeypatch.setattr(package_sources, "ROOT", tmp_path)
    inventory = package_sources.collect_inventory(xpi)
    with zipfile.ZipFile(BytesIO(), "w") as archive:
        evidence = package_sources.shipped_evidence(xpi, inventory, archive, {}, {})
    assert evidence["projectSourceSnapshotMismatches"] == expected
