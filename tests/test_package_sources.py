"""Check that source delivery retains the tracked tests used by the shipped build workflow."""
import sys
from pathlib import Path

# Import the source packager without executing its command-line entry point.
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import package_sources


def test_project_snapshot_includes_build_tests_without_private_untracked_files(tmp_path, monkeypatch):
    """Keep workflow test inputs and disclose unstaged tests without copying private artifacts."""
    tracked = [".github/workflows/release-candidate.yml", "scripts/check_offline.py",
               "tests/test_release.py", "tests/test_runtime.cjs", "docs/engine-and-alignment.md"]
    untracked = "tests/test_unstaged.py"
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
            return b""
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
