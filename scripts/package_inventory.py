"""Summarize completed XPI bytes and shipped license evidence without compliance claims."""
import csv
from email.parser import BytesParser
import hashlib
from io import StringIO
import json
from pathlib import Path
import posixpath
import re
import zipfile

# Inventory revisions are independent of addon and runtime versions.
SCHEMA_VERSION = 1
# File names identify evidence only, never a license or redistribution permission.
LICENSE_NAMES = ("license", "licence", "copying", "notice", "copyright", "thirdpartynotice")
# Only PaperBridge sources, not dependency sources, belong in the module summary.
ADDON_SOURCE_SUFFIXES = {".js", ".xhtml", ".json"}


def _package_name(name):
    """Match wheel and runtime-manifest names using Python distribution spelling rules."""
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def _license_evidence(archive, folder, metadata=None, *, recursive=True):
    """Locate declared/discovered files and retain metadata fields without interpreting them."""
    names = {entry.filename for entry in archive.infolist() if not entry.is_dir()}
    fields = {}
    for field in ("License", "License-Expression"):
        value = str(metadata.get(field, "")).strip() if metadata is not None else ""
        fields[field] = value if value and value.lower() not in {"unknown", "none", "n/a"} else "unknown"
    classifiers = [value for value in metadata.get_all("Classifier", [])
                   if value.startswith("License ::")] if metadata is not None else []
    declared = metadata.get_all("License-File", []) if metadata is not None else []
    files = {name for name in names if folder is not None and name.startswith(folder)
             and (recursive or "/" not in name[len(folder):]) and (
                 Path(name).name.lower().startswith(LICENSE_NAMES) or "/licenses/" in "/" + name.lower())}
    record_status = "not_applicable"
    if metadata is not None and folder is not None:
        # RECORD associates module-local notices with this distribution, not its neighbours.
        record_status = "unknown"
        if folder + "RECORD" in names:
            site_packages = folder.rsplit("/", 2)[0] + "/"
            try:
                rows = csv.reader(StringIO(archive.read(folder + "RECORD").decode("utf-8")))
                for row in rows:
                    if not row:
                        continue
                    name = posixpath.normpath(site_packages + row[0])
                    if name in names and name.startswith(site_packages) and (
                            Path(name).name.lower().startswith(LICENSE_NAMES) or "/licenses/" in name.lower()):
                        files.add(name)
                record_status = "read"
            except (UnicodeError, csv.Error):
                pass
    missing = []
    for relative in declared:
        candidates = {folder + relative, folder + "licenses/" + relative} if folder is not None else set()
        located = candidates & names
        files.update(located)
        if not located:
            missing.append(relative)
    evidence = [{"path": name, "bytes": archive.getinfo(name).file_size,
                 "sha256": hashlib.sha256(archive.read(name)).hexdigest()} for name in sorted(files)]
    reported = any(value != "unknown" for value in fields.values()) or classifiers or any(item["bytes"] for item in evidence)
    return {"status": "reported" if reported else "unknown", "fields": fields,
            "classifiers": classifiers, "files": evidence, "missingDeclaredFiles": missing,
            "recordStatus": record_status}


def size_trend(inventory, previous):
    """Compare like-for-like inventories; growth and unavailable baselines are advisory."""
    if previous is None:
        return {"status": "not_compared"}
    try:
        baseline = json.loads(Path(previous).read_text(encoding="utf-8"))
        if any(baseline["runtime"][field] != inventory["runtime"][field] for field in ("platform", "pythonMode")):
            raise ValueError("different platform/Python mode")
        deltas = {}
        for field in ("bytes", "expandedBytes"):
            old, new = baseline["archive"][field], inventory["archive"][field]
            if type(old) is not int or old <= 0:
                raise ValueError("missing positive baseline size")
            deltas[field] = {"previous": old, "current": new, "delta": new - old,
                             "percent": round(100 * (new - old) / old, 2)}
        return {"status": "compared", "baselineSha256": baseline["archive"]["sha256"], "sizes": deltas}
    except (OSError, ValueError, KeyError, TypeError):
        inventory["warnings"].append("Size trend unknown: baseline is unavailable or not the same platform/Python mode.")
        return {"status": "unknown"}


def collect_inventory(xpi, digest=None, previous=None):
    """Read actual ZIP sizes, own sources, distribution versions and located license files."""
    xpi = Path(xpi)
    if digest is None:
        with xpi.open("rb") as stream:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
    warnings = []
    with zipfile.ZipFile(xpi) as archive:
        entries = sorted(archive.infolist(), key=lambda entry: entry.filename)
        names = [entry.filename for entry in entries]
        manifests = [name for name in names if name.startswith("runtime/")
                     and name.count("/") == 2 and name.endswith("/runtime.json")]
        if len(manifests) != 1:
            raise ValueError("Inventory needs one platform runtime manifest")
        metadata = json.loads(archive.read(manifests[0]))
        prefix = manifests[0].removesuffix("runtime.json")
        backend = prefix + "backend/"
        sources = [{"path": entry.filename, "bytes": entry.file_size,
                    "sha256": hashlib.sha256(archive.read(entry)).hexdigest()}
                   for entry in entries if not entry.is_dir() and (
                       entry.filename.startswith(backend) and entry.filename.endswith(".py")
                       or not entry.filename.startswith("runtime/") and Path(entry.filename).suffix in ADDON_SOURCE_SUFFIXES)]
        declared = {}
        packages = metadata.get("packages", [])
        if not isinstance(packages, list):
            warnings.append("Runtime dependency declarations unknown: packages is not a list.")
            packages = []
        for package in packages:
            if not isinstance(package, dict) or not isinstance(package.get("name"), str) or not package["name"].strip():
                warnings.append("Runtime dependency declaration unknown: missing package name.")
                continue
            declared[_package_name(package["name"].strip())] = package
        dependencies = []
        observed = set()
        for name in names:
            if not name.startswith(prefix + "python/") or not name.endswith(".dist-info/METADATA"):
                continue
            message = BytesParser().parsebytes(archive.read(name))
            package_name = str(message.get("Name", "")).strip() or "unknown"
            version = str(message.get("Version", "")).strip() or "unknown"
            canonical = _package_name(package_name)
            observed.add(canonical)
            expected = declared.get(canonical, {}).get("version") or "unknown"
            license_info = _license_evidence(archive, name.removesuffix("METADATA"), message)
            dependencies.append({"name": package_name, "version": version, "declaredVersion": expected,
                                 "metadataPath": name, "license": license_info})
            if package_name == "unknown" or version == "unknown" or expected != "unknown" and version != expected:
                warnings.append(f"Dependency version unknown or inconsistent: {package_name}.")
            if (license_info["status"] == "unknown" or license_info["missingDeclaredFiles"]
                    or any(item["bytes"] == 0 for item in license_info["files"])):
                warnings.append(f"License evidence unknown, absent or empty: {package_name}.")
        for name, package in sorted(declared.items()):
            if name not in observed:
                dependencies.append({"name": package["name"], "version": "unknown",
                                     "declaredVersion": package.get("version") or "unknown", "metadataPath": None,
                                     "license": _license_evidence(archive, None)})
                warnings.append(f"Packaged distribution metadata missing: {package['name']}.")
        if not dependencies:
            warnings.append("Dependency inventory unknown: no packaged distribution metadata or declarations.")
        components = []
        for name, folder, shipped, recursive in (
            ("PaperBridge", "", True, False),
            ("CPython interpreter/stdlib", prefix + "python/", metadata.get("pythonMode") == "bundled", False),
            ("Addon notices (unassigned)", "licenses/", any(name.startswith("licenses/") for name in names), True),
            ("Layout model assets", prefix + ".cache/babeldoc/models/", True, True),
            ("Tokenizer assets", prefix + ".cache/babeldoc/tiktoken/", True, True),
        ):
            # Root/stdlib licenses must not borrow evidence from nested dependencies.
            evidence = _license_evidence(archive, folder, recursive=recursive)
            components.append({"name": name, "shipped": shipped, "license": evidence})
            if shipped and (evidence["status"] == "unknown" or any(item["bytes"] == 0 for item in evidence["files"])):
                warnings.append(f"Component license evidence unknown or empty: {name}.")
        inventory = {
            "schemaVersion": SCHEMA_VERSION, "scope": "completed_xpi_archive_metadata",
            "nativeExecution": "not_tested", "licenseCompliance": "unknown",
            "licenseScope": "Packaged METADATA and located files only; vendored native-library obligations are not audited.",
            "archive": {"name": xpi.name, "sha256": digest, "bytes": xpi.stat().st_size,
                        "compressedEntryBytes": sum(entry.compress_size for entry in entries),
                        "expandedBytes": sum(entry.file_size for entry in entries),
                        "entryCount": len(entries), "fileCount": sum(not entry.is_dir() for entry in entries)},
            "runtime": {field: metadata.get(field, "unknown") for field in (
                "version", "platform", "pythonMode", "python", "buildId", "payloadSha256")},
            "entries": [{"path": entry.filename, "compressedBytes": entry.compress_size,
                         "expandedBytes": entry.file_size} for entry in entries],
            "sourceModules": sources, "dependencies": sorted(dependencies, key=lambda package: _package_name(package["name"])),
            "components": components, "warnings": warnings,
        }
    inventory["sizeTrend"] = size_trend(inventory, previous)
    if inventory["sizeTrend"]["status"] == "compared" and any(
            size["delta"] > 0 for size in inventory["sizeTrend"]["sizes"].values()):
        inventory["warnings"].append("Package size increased versus the supplied baseline; advisory only, no size gate.")
    return inventory


def write_inventory(path, inventory):
    """Write an indented UTF-8 machine-readable sidecar beside its completed artifact."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
