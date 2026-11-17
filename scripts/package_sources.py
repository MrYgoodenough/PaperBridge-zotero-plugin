"""Deliver pinned source archives, exact shipped source and build/notice evidence beside XPIs."""
import argparse
import csv
import hashlib
import io
import json
import posixpath
import re
import shutil
import stat
import subprocess
import tarfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

from package_inventory import collect_inventory

# Keep large upstream archives outside the addon and never import packaged Python.
ROOT = Path(__file__).resolve().parents[1]
# Match the sole manifest transformation made by build.py, without ignoring arbitrary URL changes.
REPOSITORY = "MrYgoodenough/PaperBridge-zotero-plugin"
# ZIP timestamps and modes are fixed so identical inputs produce identical bundles.
ZIP_DATE = (1980, 1, 1, 0, 0, 0)
# Interpret fixed source-file attributes consistently on Linux and Windows packagers.
ZIP_CREATE_SYSTEM = 3
# Stream archives rather than loading entire corresponding-source tarballs into RAM.
COPY_CHUNK = 1024 * 1024
# Retain shipped source and generated interfaces, but not bytecode or native binaries.
SOURCE_SUFFIXES = {".py", ".pyi", ".c", ".h", ".cc", ".cxx", ".cpp", ".hh", ".hxx", ".hpp",
                   ".inl", ".pyx", ".pxd", ".pxi", ".i", ".rs", ".f", ".f90"}
# RECORD may omit native ownership; inventory actual files independently as well.
NATIVE_PATTERN = re.compile(r"\.(?:so(?:\.\d+)*|dylib|dll|pyd|a|lib|exe)$", re.IGNORECASE)
# Recognize renamed SFNT/collection files as well as conventional font filenames.
FONT_SIGNATURES = {b"\x00\x01\x00\x00", b"OTTO", b"ttcf", b"wOFF", b"wOF2"}
# Keep tracked tests and developer docs referenced by build workflows and the README.
PROJECT_SOURCE_DIRS = ("addon", "backend", "scripts", ".github", "tests", "docs")
# Root metadata and explicit release guidance are also part of the delivered snapshot.
PROJECT_SOURCE_FILES = ("LICENSE", "NOTICE.md", "README.md", ".env.example", "pyproject.toml", "uv.lock",
                        "docs/licensing.md", "docs/linux-package-size.md", "docs/releasing.md",
                        "docs/source-delivery-readiness.md")


def digest(path):
    """Hash the actual file, not a checksum sidecar or package version."""
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def json_bytes(value):
    """Serialize reproducible UTF-8 evidence without timestamps or local output paths."""
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()


def safe_path(name):
    """Reject traversal, Windows paths and ambiguous archive member names."""
    if not name or "\\" in name or "\0" in name or ":" in name:
        raise ValueError(f"Unsafe archive path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError(f"Unsafe archive path: {name!r}")
    return path.as_posix()


def verify_archive(path, entry):
    """Verify pinned bytes, safe members and hashed source/build/license probes; never extract."""
    if digest(path) != entry["sha256"] or Path(path).stat().st_size != entry["bytes"]:
        raise ValueError(f"Source archive hash/size mismatch: {entry['id']}")
    found, names = {}, set()
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            for member in archive.infolist():
                name = safe_path(member.filename)
                if member.is_dir():
                    continue
                if name in names or stat.S_ISLNK(member.external_attr >> 16):
                    raise ValueError(f"Duplicate or linked ZIP source member: {name}")
                names.add(name)
                if name in entry["requiredMembers"]:
                    with archive.open(member) as stream:
                        found[name] = hashlib.file_digest(stream, "sha256").hexdigest()
        if found != entry["requiredMembers"]:
            raise ValueError(f"Missing or mismatched source/build/license probes: {entry['id']}")
        return {"memberCount": len(names), "requiredMembers": found, "status": "verified"}
    with tarfile.open(path, "r:*") as archive:
        for member in archive:
            name = safe_path(member.name)
            if member.isdir():
                continue
            if name in names:
                raise ValueError(f"Duplicate archive member: {name}")
            names.add(name)
            if member.issym() or member.islnk():
                # Relative links may stay inside the archive's single source root.
                target = member.linkname
                if "\\" in target or ":" in target or target.startswith("/"):
                    raise ValueError(f"Unsafe archive link: {name}")
                base = posixpath.dirname(name) if member.issym() else ""
                resolved = safe_path(posixpath.normpath(posixpath.join(base, target)))
                if resolved.split("/")[0] != name.split("/")[0]:
                    raise ValueError(f"Archive link escapes source root: {name}")
            elif not member.isfile():
                raise ValueError(f"Unsupported archive member: {name}")
            if name in entry["requiredMembers"]:
                if not member.isfile():
                    raise ValueError(f"Source probe is not a regular file: {name}")
                with archive.extractfile(member) as stream:
                    found[name] = hashlib.file_digest(stream, "sha256").hexdigest()
    if found != entry["requiredMembers"]:
        raise ValueError(f"Missing or mismatched source/build/license probes: {entry['id']}")
    return {"memberCount": len(names), "requiredMembers": found, "status": "verified"}


def obtain_archive(entry, cache, download):
    """Use pinned cache bytes, optionally downloading a public HTTPS archive atomically."""
    filename = safe_path(entry["filename"])
    if "/" in filename:
        raise ValueError("Source cache filenames must be basenames")
    path = cache / filename
    nested = cache / safe_path(entry["id"]) / filename
    if not path.exists() and nested.is_file():
        path = nested
    if not path.exists():
        local = entry.get("localArchive")
        if local and (ROOT / safe_path(local)).is_file():
            shutil.copyfile(ROOT / local, path)
        elif download:
            if not entry["url"].startswith("https://"):
                raise ValueError("Source downloads require public HTTPS URLs")
            temporary = path.with_name(path.name + ".part")
            try:
                with urllib.request.urlopen(entry["url"], timeout=120) as source, temporary.open("wb") as target:
                    shutil.copyfileobj(source, target, COPY_CHUNK)
                verify_archive(temporary, entry)
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
        else:
            raise FileNotFoundError(f"Missing source {path}; use --download or populate the cache")
    return path, verify_archive(path, entry)


def applicable(entry, inventory):
    """Select sources using this XPI's platform, interpreter mode and observed distributions."""
    runtime = inventory["runtime"]
    if runtime["platform"] not in entry["platforms"]:
        return False
    if entry.get("bundledPythonOnly") and runtime["pythonMode"] != "bundled":
        return False
    if entry.get("python") and runtime["python"] != entry["python"]:
        return False
    expected_python = entry.get("pythonVersions", {}).get(runtime["platform"])
    if expected_python and runtime["python"] != expected_python:
        return False
    dependencies = entry.get("dependencyChoices", [])
    if entry.get("dependency"):
        dependencies = [entry["dependency"]]
    return not dependencies or any(
        re.sub(r"[-_.]+", "-", item["name"]).lower() == dependency["name"]
        and item["version"] == dependency["version"]
        for dependency in dependencies for item in inventory["dependencies"])


def add_bytes(archive, name, contents, files):
    """Write one deterministic ZIP member and register its exact hash."""
    name = safe_path(name)
    if name in files:
        raise ValueError(f"Duplicate bundle member: {name}")
    info = zipfile.ZipInfo(name, ZIP_DATE)
    info.create_system = ZIP_CREATE_SYSTEM
    info.external_attr = 0o100644 << 16
    info.compress_type = zipfile.ZIP_DEFLATED
    archive.writestr(info, contents)
    files[name] = {"bytes": len(contents), "sha256": hashlib.sha256(contents).hexdigest()}


def add_file(archive, name, path, files):
    """Stream a verified archive into the ZIP without changing its compressed bytes."""
    name = safe_path(name)
    if name in files:
        raise ValueError(f"Duplicate bundle member: {name}")
    info = zipfile.ZipInfo(name, ZIP_DATE)
    info.create_system = ZIP_CREATE_SYSTEM
    info.external_attr = (0o100755 if Path(path).stat().st_mode & 0o111 else 0o100644) << 16
    # Upstream compressed archives are stored unchanged; project/build text is compressed.
    if not str(path).endswith((".tar.gz", ".tar.xz", ".tar.bz2", ".zip", ".crate")):
        info.compress_type = zipfile.ZIP_DEFLATED
    copied_hash, copied_bytes = hashlib.sha256(), 0
    with Path(path).open("rb") as source, archive.open(info, "w", force_zip64=True) as target:
        while chunk := source.read(COPY_CHUNK):
            target.write(chunk)
            copied_hash.update(chunk)
            copied_bytes += len(chunk)
    files[name] = {"bytes": copied_bytes, "sha256": copied_hash.hexdigest()}


def project_files():
    """Snapshot only project/build inputs; never include machine caches, credentials or agent history."""
    result = {ROOT / p for p in PROJECT_SOURCE_FILES}
    # Git's tracked allowlist avoids accidentally including untracked account/process files.
    tracked = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z", "--",
                                       *PROJECT_SOURCE_DIRS])
    result.update(ROOT / safe_path(p.decode("utf-8")) for p in tracked.split(b"\0") if p)
    result.add(ROOT / "scripts/package_sources.py")
    result.update((ROOT / "addon/licenses").rglob("*"))
    return sorted(path for path in result if path.is_file() and not path.is_symlink())


def project_snapshot(paths):
    """Disclose working-tree membership; a Git HEAD is not a claim that these bytes were committed."""
    included = {p.relative_to(ROOT).as_posix() for p in paths}
    tracked = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"])
    tracked = {p.decode("utf-8") for p in tracked.split(b"\0") if p}
    # A deleted tracked source must not disappear from an otherwise "committed" snapshot.
    missing = {p for p in tracked if p not in included and (
        p in PROJECT_SOURCE_FILES or p.split("/", 1)[0] in PROJECT_SOURCE_DIRS)}
    changed = subprocess.check_output(["git", "-C", str(ROOT), "diff", "HEAD", "--name-only", "-z"])
    changed = {p.decode("utf-8") for p in changed.split(b"\0") if p}
    untracked = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "--others",
                                         "--exclude-standard", "-z", "--", *PROJECT_SOURCE_DIRS])
    untracked = {p.decode("utf-8") for p in untracked.split(b"\0") if p}
    return {"gitHead": subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"]).decode().strip(),
            "membershipPolicy": "Tracked working-tree build/source/test files plus explicit delivery docs, package_sources.py and addon/licenses/; never agent history or arbitrary untracked files.",
            "includedUntrackedFiles": sorted(included - tracked),
            "modifiedTrackedFiles": sorted((included | missing) & changed),
            "missingTrackedFiles": sorted(missing),
            "excludedUntrackedSourceFiles": sorted(untracked - included),
            "fromCommitOnly": not (included - tracked or included & changed or missing)}


def record_members(shipped, folder, names):
    """Normalize Windows RECORD separators without relaxing XPI/archive path validation."""
    record = folder + "RECORD"
    if record not in names:
        return set()
    base = posixpath.dirname(folder.rstrip("/")) + "/"
    result = set()
    for row in csv.reader(io.StringIO(shipped.read(record).decode("utf-8-sig"))):
        if not row:
            continue
        name = safe_path(posixpath.normpath(base + row[0].replace("\\", "/")))
        if name.startswith(base) and name in names:
            result.add(name)
    return result


def native_evidence(shipped, inventory, spec):
    """Associate notices with hashed native bytes; source-tree delivery is not XPI inclusion."""
    prefix = f"runtime/{inventory['runtime']['platform']}/"
    result = []
    for entry in spec.get("nativeEvidence", []):
        if not applicable(entry, inventory):
            continue
        artifacts, notices = [], []
        for item in entry["artifacts"]:
            name = prefix + safe_path(item["path"])
            data = shipped.read(name) if name in shipped.namelist() else None
            artifacts.append({**item, "matches": data is not None
                              and hashlib.sha256(data).hexdigest() == item["sha256"]
                              and (not item.get("bytes") or len(data) == item["bytes"])})
        for item in entry["files"]:
            name = safe_path(item["path"])
            local = ROOT / "addon" / name
            data = shipped.read(name) if name in shipped.namelist() else None
            notices.append({**item, "sourceTreeMatches": local.is_file() and digest(local) == item["sha256"],
                            "shippedMatches": data is not None
                            and hashlib.sha256(data).hexdigest() == item["sha256"]})
        result.append({**entry, "artifacts": artifacts, "files": notices,
                       "artifactStatus": "matched" if artifacts and all(i["matches"] for i in artifacts)
                       else "missing_or_changed",
                       "sourceTreeNoticesMatch": bool(notices) and all(i["sourceTreeMatches"] for i in notices),
                       "shippedNoticesMatch": bool(notices) and all(i["shippedMatches"] for i in notices)})
    return result


def project_source_matches(name, data, path, metadata):
    """Match exact source bytes or build.py's explicit platform/mode manifest transformation."""
    if not path.is_file():
        return False
    if name != "manifest.json":
        return hashlib.sha256(data).hexdigest() == digest(path)
    expected = json.loads(path.read_bytes())
    suffix = "-local-python" if metadata["pythonMode"] == "local" else ""
    expected["applications"]["zotero"]["update_url"] = (
        f"https://raw.githubusercontent.com/{REPOSITORY}/master/updates/{metadata['platform']}{suffix}.json"
    )
    return json.loads(data) == expected


def shipped_evidence(xpi, inventory, archive, files, spec):
    """Retain exact shipped sources/notices and report font blobs without redistributing them."""
    prefix = f"runtime/{inventory['runtime']['platform']}/"
    # Compare complete build.py membership, not only modules still present in the XPI.
    local_sources = {}
    for folder, base in ((ROOT / "addon", ""), (ROOT / "backend", prefix + "backend/")):
        for path in folder.rglob("*"):
            if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc":
                local_sources[base + path.relative_to(folder).as_posix()] = path
    project_sources = set(local_sources)
    selected = {item["path"] for item in inventory["sourceModules"]}
    fonts, mismatches, native_files = [], [], []
    with zipfile.ZipFile(xpi) as shipped:
        names = {safe_path(item.filename) for item in shipped.infolist() if not item.is_dir()}
        if len(names) != sum(not item.is_dir() for item in shipped.infolist()):
            raise ValueError("Duplicate XPI members are not supported")
        project_sources.update(n for n in names if n.startswith(prefix + "backend/")
                               or not n.startswith("runtime/") and n not in {"LICENSE", "NOTICE.md"})
        mismatches.extend(sorted(project_sources - names))
        # Asset membership is compared too, while retention still excludes native/font blobs.
        for name in sorted(project_sources & names):
            local = local_sources.get(name)
            if local is None or not project_source_matches(name, shipped.read(name), local, inventory["runtime"]):
                mismatches.append(name)
        # All delivered Python/C interfaces are useful modification evidence, not just GPL RECORD rows.
        selected.update(n for n in names if n.startswith(prefix) and Path(n).suffix in SOURCE_SUFFIXES)
        selected.add(prefix + "runtime.json")
        owners = {}
        for dependency in inventory["dependencies"]:
            metadata = dependency.get("metadataPath")
            if metadata:
                folder = metadata.removesuffix("METADATA")
                selected.update(n for n in names if n.startswith(folder))
                for name in record_members(shipped, folder, names):
                    owners.setdefault(name, []).append(dependency["name"])
            selected.update(item["path"] for item in dependency["license"]["files"])
        selected.update(n for n in names if n.startswith("licenses/") or n in {"LICENSE", "NOTICE.md"})
        for name in sorted(selected & names):
            data = shipped.read(name)
            add_bytes(archive, f"shipped/{xpi.name}/{name}", data, files)
        for name in sorted(names):
            # Cache asset names may have no extension; magic is a public format header.
            if NATIVE_PATTERN.search(name) or name in {prefix + "python/bin/python3.12"}:
                data = shipped.read(name)
                native_files.append({"path": name, "bytes": len(data),
                                     "sha256": hashlib.sha256(data).hexdigest(),
                                     "recordOwners": owners.get(name, [])})
            if name.startswith("licenses/") or NATIVE_PATTERN.search(name):
                continue
            with shipped.open(name) as stream:
                header = stream.read(4)
            if header in FONT_SIGNATURES or Path(name).suffix.lower() in {".ttf", ".ttc", ".otf", ".otc", ".woff", ".woff2"}:
                data = shipped.read(name)
                sha = hashlib.sha256(data).hexdigest()
                known = [f for f in spec.get("fontEvidence", []) if f["sha256"] == sha]
                fonts.append({"path": name, "bytes": len(data), "sha256": sha,
                              "identityEvidence": known, "redistributionPermission": "unknown"})
        attribution = native_evidence(shipped, inventory, spec)
        # Check all retained licenses, not only newly added supplemental notices.
        delivery_files = [ROOT / "LICENSE", ROOT / "NOTICE.md"]
        delivery_files += [p for p in (ROOT / "addon/licenses").rglob("*") if p.is_file()]
        missing_delivery = []
        for local in sorted(delivery_files):
            name = local.relative_to(ROOT).as_posix().removeprefix("addon/")
            if name not in names or hashlib.sha256(shipped.read(name)).hexdigest() != digest(local):
                missing_delivery.append(name)
    return {"projectSourceSnapshotMismatches": sorted(mismatches), "fonts": fonts,
            "projectSourceComparison": "Complete addon/backend membership and exact bytes except manifest.json: "
                                       "build.py platform/mode update_url and JSON serialization; all other fields must match.",
            "nativeFiles": native_files, "nativeAttribution": attribution,
            "deliveryFilesMissingOrChanged": missing_delivery,
            "fontScope": "Standalone font blobs only; compiled MuPDF fonts are covered by source notices, not binary extraction."}


def build_bundle(xpis, output, cache, download, manifest_path):
    """Bind verified upstream archives and available build inputs to freshly hashed XPIs."""
    spec = json.loads(manifest_path.read_text(encoding="utf-8"))
    if spec["schemaVersion"] != 1:
        raise ValueError("Unsupported source-manifest schema")
    xpis = sorted((Path(p).resolve() for p in xpis), key=lambda p: p.name)
    if len({p.name for p in xpis}) != len(xpis) or output.resolve() in xpis:
        raise ValueError("XPI names must be unique and output must be separate")
    inventories = [(p, collect_inventory(p)) for p in xpis]
    cache.mkdir(parents=True, exist_ok=True)
    sources = []
    for entry in sorted(spec["archives"], key=lambda e: e["id"]):
        matches = [p.name for p, inv in inventories if applicable(entry, inv)]
        if matches:
            path, verified = obtain_archive(entry, cache, download)
            sources.append((entry, path, verified, matches))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".part")
    files = {}
    project = project_files()
    result = {"schemaVersion": 1, "licenseCompliance": "unknown", "correspondingSourceStatus": "partial",
              "sourceDeliveryStatus": "verified_archives_and_files", "publicReleaseReady": False,
              "scope": spec["scope"], "sourceManifestSha256": digest(manifest_path),
              "blockers": list(spec["blockers"]), "evidenceLimits": spec.get("evidenceLimits", []),
              "releaseObligations": spec.get("releaseObligations", []),
              "projectSnapshot": project_snapshot(project), "buildInputs": [], "sources": [], "xpis": []}
    try:
        with zipfile.ZipFile(temporary, "w", allowZip64=True) as archive:
            add_file(archive, "source-manifest.json", manifest_path, files)
            add_bytes(archive, "README.md", (
                "# PaperBridge source-delivery candidate\n\n"
                "This ZIP accompanies only the XPI hashes in bundle-manifest.json; it contains no XPI.\n"
                "It is verified source/evidence delivery, not a written offer or legal clearance.\n"
                "upstream/ retains complete pinned public source archives, including populated MuPDF trees.\n"
                "project/ retains current project/build sources; shipped/ retains the exact delivered sources,\n"
                "interfaces, notices and metadata even when the current project differs.\n"
                "build-inputs/ preserves available local build configuration; xpis/ has fresh byte inventories.\n"
                "Read project/docs/licensing.md for build instructions, limits and release obligations.\n"
                "Verify with: python -B project/scripts/package_sources.py --verify <this-zip>\n"
                "The files index excludes bundle-manifest.json itself; GitHub's asset digest binds the public ZIP.\n"
                "The generated .sha256 file is for local verification only, not a release asset.\n"
            ).encode(), files)
            for entry, path, verified, matches in sources:
                name = f"upstream/{entry['id']}/{entry['filename']}"
                add_file(archive, name, path, files)
                if files[name]["sha256"] != entry["sha256"]:
                    raise ValueError(f"Source changed during packaging: {entry['id']}")
                result["sources"].append({**entry, "bundlePath": name, "verification": verified,
                                          "appliesToXpis": matches, "binaryRebuildVerified": False})
            for path in project:
                add_file(archive, "project/" + path.relative_to(ROOT).as_posix(), path, files)
            for item in spec.get("localBuildInputs", []):
                if item.get("platforms") and not any(
                    inv["runtime"]["platform"] in item["platforms"] for _, inv in inventories
                ):
                    continue
                candidates = [ROOT / safe_path(item["path"])]
                if item.get("bundledCopyPath"):
                    candidates.append(ROOT / safe_path(item["bundledCopyPath"]))
                # A pinned staged copy preserves original configuration when the private cache is absent.
                path = next((p for p in candidates if p.is_file() and digest(p) == item["sha256"]
                             and ("bytes" not in item or p.stat().st_size == item["bytes"])), None)
                if path is not None:
                    name = "build-inputs/" + safe_path(item["path"])
                    add_file(archive, name, path, files)
                    if files[name]["sha256"] != item["sha256"]:
                        raise ValueError(f"Build input changed during packaging: {item['path']}")
                    result["buildInputs"].append({**item, "bundlePath": name})
                else:
                    result["blockers"].append(f"Build input missing or changed: {item['path']}")
            for xpi, inventory in inventories:
                evidence = shipped_evidence(xpi, inventory, archive, files, spec)
                add_bytes(archive, f"xpis/{xpi.name}.inventory.json", json_bytes(inventory), files)
                if digest(xpi) != inventory["archive"]["sha256"]:
                    raise ValueError(f"XPI changed during source packaging: {xpi.name}")
                covered = {e.get("dependency", {}).get("name") for e, _, _, matches in sources if xpi.name in matches}
                for dependency in inventory["dependencies"]:
                    name = re.sub(r"[-_.]+", "-", dependency["name"]).lower()
                    declared = json.dumps(dependency["license"]["fields"]) + str(dependency["license"]["classifiers"])
                    if (name in spec["copyleftPackages"] or "GPL" in declared) and name not in covered:
                        result["blockers"].append(f"No pinned corresponding source for {xpi.name}: {name} {dependency['version']}")
                if evidence["fonts"]:
                    result["blockers"].append(f"Standalone font redistribution permissions need byte-specific review: {xpi.name}")
                if evidence["projectSourceSnapshotMismatches"]:
                    result["blockers"].append(f"Current project/build snapshot differs from shipped sources: {xpi.name}; exact shipped copies retained")
                if evidence["deliveryFilesMissingOrChanged"]:
                    result["blockers"].append(f"Rebuild/ship updated notices and source manifest: {xpi.name}; "
                                              f"{len(evidence['deliveryFilesMissingOrChanged'])} delivery files missing or changed")
                for entry in evidence["nativeAttribution"]:
                    if entry["artifactStatus"] != "matched" or not entry["sourceTreeNoticesMatch"]:
                        result["blockers"].append(f"Native attribution missing or changed: {xpi.name}: {entry['id']}")
                result["xpis"].append({"name": xpi.name, **inventory["archive"], "runtime": inventory["runtime"], **evidence})
            result["blockers"] = sorted(set(result["blockers"]))
            result["files"] = files
            add_bytes(archive, "bundle-manifest.json", json_bytes(result), {})
        verify_bundle(temporary)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)
    output.with_name(output.name + ".manifest.json").write_bytes(json_bytes(result))
    output.with_name(output.name + ".sha256").write_text(f"{digest(output)}  {output.name}\n", encoding="utf-8", newline="\n")
    return result


def verify_bundle(path):
    """Rehash every indexed ZIP member without extracting archives or executing packaged code."""
    with zipfile.ZipFile(path) as archive:
        result = json.loads(archive.read("bundle-manifest.json"))
        names = [safe_path(n) for n in archive.namelist()]
        if len(set(names)) != len(names) or set(names) != set(result["files"]) | {"bundle-manifest.json"}:
            raise ValueError("Source bundle has duplicate, missing or unindexed members")
        for name, expected in result["files"].items():
            with archive.open(name) as stream:
                actual = hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != expected["sha256"] or archive.getinfo(name).file_size != expected["bytes"]:
                raise ValueError(f"Source bundle hash/size mismatch: {name}")
        if result["files"]["source-manifest.json"]["sha256"] != result["sourceManifestSha256"]:
            raise ValueError("Source manifest does not match the bundle declaration")
    return result


def main():
    """Create a source-delivery candidate; an emitted ZIP does not authorize publication."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xpi", action="append", type=Path, help="Completed XPI; repeat for each platform/mode")
    parser.add_argument("--output", type=Path, help="Separate source-delivery ZIP (never an XPI)")
    parser.add_argument("--cache", type=Path, default=ROOT / "agent/codex/package-source-cache")
    parser.add_argument("--manifest", type=Path, default=ROOT / "addon/licenses/source-manifest.json")
    parser.add_argument("--download", action="store_true", help="Download missing pinned public source archives")
    parser.add_argument("--verify", type=Path, help="Only rehash an existing bundle; no downloads or extraction")
    args = parser.parse_args()
    if args.verify:
        result = verify_bundle(args.verify)
        print(json.dumps({"output": str(args.verify), "sha256": digest(args.verify),
                          "filesVerified": len(result["files"]), "sources": len(result["sources"]),
                          "licenseCompliance": result["licenseCompliance"]}, indent=2))
        return
    if not args.xpi or not args.output:
        parser.error("--xpi and --output are required unless --verify is used")
    result = build_bundle(args.xpi, args.output, args.cache, args.download, args.manifest)
    print(json.dumps({"output": str(args.output), "sha256": digest(args.output),
                      "sources": len(result["sources"]), "licenseCompliance": result["licenseCompliance"],
                      "correspondingSourceStatus": result["correspondingSourceStatus"],
                      "blockers": result["blockers"]}, indent=2))


if __name__ == "__main__":
    main()
