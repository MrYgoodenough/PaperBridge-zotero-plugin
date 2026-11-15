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
SCHEMA_VERSION = 2
# File names identify evidence only, never a license or redistribution permission.
LICENSE_NAMES = ("license", "licence", "copying", "notice", "copyright", "thirdpartynotice")
# Only PaperBridge sources, not dependency sources, belong in the module summary.
ADDON_SOURCE_SUFFIXES = {".js", ".xhtml", ".json"}
# Only this bundled manifest can associate supplemental notices with exact artifacts.
PROVENANCE_PATH = "licenses/provenance.json"
# Include versioned ELF libraries and native Windows/macOS wheel artifacts.
NATIVE_FILE_PATTERN = re.compile(r"\.(?:so(?:\.\d+)*|dylib|dll|pyd|a|lib)$", re.IGNORECASE)


def _package_name(name):
    """Match wheel and runtime-manifest names using Python distribution spelling rules."""
    return re.sub(r"[-_.]+", "-", name.strip()).lower()


def _file_evidence(archive, paths):
    """Hash existing archive members without importing or executing their contents."""
    return [{"path": name, "bytes": archive.getinfo(name).file_size,
             "sha256": hashlib.sha256(archive.read(name)).hexdigest()} for name in sorted(set(paths))]


def _record_files(archive, folder):
    """Read wheel ownership paths, keeping installed files within its site-packages tree."""
    names = set(archive.namelist())
    if folder + "RECORD" not in names:
        return set(), "unknown"
    site_packages = folder.rsplit("/", 2)[0] + "/"
    try:
        rows = csv.reader(StringIO(archive.read(folder + "RECORD").decode("utf-8")))
        files = {posixpath.normpath(site_packages + row[0]) for row in rows if row}
        return {name for name in files if name in names and name.startswith(site_packages)}, "read"
    except (UnicodeError, csv.Error):
        return set(), "unknown"


def _license_evidence(archive, folder, metadata=None, *, recursive=True, extra_files=()):
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
    files.update(set(extra_files) & names)
    record_status = "not_applicable"
    if metadata is not None and folder is not None:
        # RECORD associates module-local notices with this distribution, not its neighbours.
        owned, record_status = _record_files(archive, folder)
        files.update(name for name in owned if Path(name).name.lower().startswith(LICENSE_NAMES)
                     or "/licenses/" in name.lower())
    missing = []
    for relative in declared:
        candidates = {folder + relative, folder + "licenses/" + relative} if folder is not None else set()
        located = candidates & names
        files.update(located)
        if not located:
            missing.append(relative)
    evidence = _file_evidence(archive, files)
    reported = any(value != "unknown" for value in fields.values()) or classifiers or any(item["bytes"] for item in evidence)
    return {"status": "reported" if reported else "unknown", "fields": fields,
            "classifiers": classifiers, "files": evidence, "missingDeclaredFiles": missing,
            "recordStatus": record_status}


def _wheel_evidence(archive, folder):
    """Retain wheel tags, ownership metadata and the actual native files listed by RECORD."""
    owned, _ = _record_files(archive, folder)
    wheel = None
    if folder + "WHEEL" in archive.namelist():
        wheel = _file_evidence(archive, [folder + "WHEEL"])[0]
        message = BytesParser().parsebytes(archive.read(wheel["path"]))
        wheel["tags"] = message.get_all("Tag", [])
    record = _file_evidence(archive, [folder + "RECORD"])[0] if folder + "RECORD" in archive.namelist() else None
    return {"wheel": wheel, "record": record,
            "nativeFiles": _file_evidence(archive, [name for name in owned if NATIVE_FILE_PATTERN.search(name)])}


def _built_dependency(archive, prefix, package, platform):
    """Associate a declared source build with its hashed extension and module-local notices."""
    build = package.get("build")
    if (not isinstance(build, dict) or not build.get("extensionSha256")
            or build.get("version") != package.get("version") or build.get("platform") != platform):
        return None
    candidates = [name for name in archive.namelist() if name.startswith(prefix + "python/")
                  and "/site-packages/" in name and NATIVE_FILE_PATTERN.search(name)
                  and (not build.get("extensionBytes") or archive.getinfo(name).file_size == build["extensionBytes"])]
    matches = [item for item in _file_evidence(archive, candidates) if item["sha256"] == build["extensionSha256"]]
    if len(matches) != 1:
        return None
    site, relative = matches[0]["path"].split("site-packages/", 1)
    # A top-level extension must not borrow every neighbouring wheel's notices.
    folder = site + "site-packages/" + relative.split("/")[0] + "/" if "/" in relative else None
    return {"name": package["name"], "version": build["version"], "declaredVersion": package["version"],
            "versionSource": "runtime_manifest_native_build", "metadataPath": None,
            "buildProvenance": build, "nativeFiles": matches, "license": _license_evidence(archive, folder)}


def _provenance_evidence(archive, prefix, entry):
    """Match both shipped artifact bytes and supplemental notice bytes, without license inference."""
    result = {"id": entry.get("id", "unknown"), "status": "unknown",
              "sources": entry.get("sources", []), "declarations": entry.get("declarations", {}),
              "limitations": entry.get("limitations", []), "missingFiles": [], "mismatchedFiles": []}
    names = set(archive.namelist())
    for field, base in (("artifacts", prefix), ("files", "")):
        expected = entry.get(field)
        if not isinstance(expected, dict) or not expected or not all(
                isinstance(path, str) and isinstance(digest, str) for path, digest in expected.items()):
            result["problem"] = "Missing artifact/notice hash declarations."
            return result
        expected = {base + path: digest for path, digest in expected.items()}
        result["missingFiles"].extend(sorted(set(expected) - names))
        result[field] = _file_evidence(archive, set(expected) & names)
        for item in result[field]:
            item["expectedSha256"] = expected[item["path"]]
            if item["bytes"] == 0 or item["sha256"] != item["expectedSha256"]:
                result["mismatchedFiles"].append(item["path"])
    if not result["missingFiles"] and not result["mismatchedFiles"]:
        result["status"] = "matched"
    return result


def _apply_bundled_provenance(archive, prefix, metadata, dependencies, components, warnings):
    """Attach only applicable, byte-matched supplemental evidence; malformed data is advisory."""
    assigned = set()
    if PROVENANCE_PATH not in archive.namelist():
        return {"status": "not_present", "entries": []}, assigned
    result = {"status": "unknown", "file": _file_evidence(archive, [PROVENANCE_PATH])[0], "entries": []}
    try:
        data = json.loads(archive.read(PROVENANCE_PATH))
        if not isinstance(data, dict) or data.get("schemaVersion") != 1 or not isinstance(data.get("entries"), list):
            raise ValueError("unsupported provenance manifest")
        targets = {item["name"]: item for item in components}
        packages = {_package_name(item["name"]): item for item in dependencies}
        for entry in data["entries"]:
            if (not isinstance(entry, dict)
                    or "dependency" in entry and not isinstance(entry["dependency"], str)
                    or "component" in entry and not isinstance(entry["component"], str)
                    or not isinstance(entry.get("limitations", []), list)
                    or not all(isinstance(text, str) for text in entry.get("limitations", []))):
                raise ValueError("invalid provenance entry")
            target = packages.get(_package_name(entry["dependency"])) if "dependency" in entry else targets.get(entry.get("component"))
            if (target is None or target.get("shipped") is False
                    or entry.get("platform", metadata.get("platform")) != metadata.get("platform")
                    or entry.get("python", metadata.get("python")) != metadata.get("python")
                    or "version" in entry and entry["version"] != target.get("version")):
                result["entries"].append({"id": entry.get("id", "unknown"), "status": "not_applicable"})
                continue
            evidence = _provenance_evidence(archive, prefix, entry)
            result["entries"].append(evidence)
            target["license"].setdefault("provenance", []).append(evidence)
            if evidence["status"] == "matched":
                files = {item["path"]: item for item in target["license"]["files"]}
                files.update({item["path"]: {key: item[key] for key in ("path", "bytes", "sha256")}
                              for item in evidence["files"]})
                target["license"]["files"] = [files[name] for name in sorted(files)]
                target["license"]["status"] = "reported"
                assigned.update(files)
                warnings.extend(f"Unresolved redistribution evidence: {evidence['id']}: {text}"
                                for text in evidence["limitations"])
            else:
                warnings.append(f"Bundled license provenance unknown: {evidence['id']}; artifact/notice bytes absent or inconsistent.")
        result["status"] = "read"
    except (ValueError, KeyError, TypeError, UnicodeError):
        warnings.append("Bundled license provenance unknown: invalid manifest; no compliance claim is made.")
    return result, assigned


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
            contents = archive.read(name)
            message = BytesParser().parsebytes(contents)
            package_name = str(message.get("Name", "")).strip() or "unknown"
            version = str(message.get("Version", "")).strip() or "unknown"
            canonical = _package_name(package_name)
            observed.add(canonical)
            expected = declared.get(canonical, {}).get("version") or "unknown"
            folder = name.removesuffix("METADATA")
            license_info = _license_evidence(archive, folder, message)
            dependencies.append({"name": package_name, "version": version, "declaredVersion": expected,
                                 "versionSource": "packaged_metadata", "metadataPath": name,
                                 "metadataSha256": hashlib.sha256(contents).hexdigest(),
                                 "projectUrls": message.get_all("Project-URL", []), "license": license_info,
                                 **_wheel_evidence(archive, folder)})
            if package_name == "unknown" or version == "unknown" or expected != "unknown" and version != expected:
                warnings.append(f"Dependency version unknown or inconsistent: {package_name}.")
        for name, package in sorted(declared.items()):
            if name not in observed:
                built = _built_dependency(archive, prefix, package, metadata.get("platform"))
                if built is not None:
                    dependencies.append(built)
                    continue
                dependencies.append({"name": package["name"], "version": "unknown",
                                     "declaredVersion": package.get("version") or "unknown", "metadataPath": None,
                                     "versionSource": "unknown", "nativeFiles": [],
                                     "license": _license_evidence(archive, None)})
                warnings.append(f"Packaged distribution metadata missing: {package['name']}.")
        if not dependencies:
            warnings.append("Dependency inventory unknown: no packaged distribution metadata or declarations.")
        components = []
        for name, folder, shipped, recursive in (
            ("PaperBridge", "", True, False),
            ("CPython interpreter/stdlib", prefix + "python/", metadata.get("pythonMode") == "bundled", False),
            ("Addon notices (unassigned)", "licenses/", any(name.startswith("licenses/") for name in names), True),
            ("Layout model assets", prefix + ".cache/babeldoc/models/",
             any(name.startswith(prefix + ".cache/babeldoc/models/") for name in names), True),
            ("Tokenizer assets", prefix + ".cache/babeldoc/tiktoken/",
             any(name.startswith(prefix + ".cache/babeldoc/tiktoken/") for name in names), True),
        ):
            # Root/stdlib licenses must not borrow evidence from nested dependencies.
            stdlib_licenses = [prefix + "python/lib/python3.12/LICENSE.txt", prefix + "python/Lib/LICENSE.txt"]
            evidence = _license_evidence(archive, folder, recursive=recursive,
                                         extra_files=stdlib_licenses if name == "CPython interpreter/stdlib" and shipped else ())
            components.append({"name": name, "shipped": shipped, "license": evidence})
        provenance, assigned = _apply_bundled_provenance(archive, prefix, metadata, dependencies, components, warnings)
        unassigned = next(item for item in components if item["name"] == "Addon notices (unassigned)")
        unassigned["license"]["files"] = [item for item in unassigned["license"]["files"]
                                          if item["path"] not in assigned and item["path"] != PROVENANCE_PATH]
        if not unassigned["license"]["files"]:
            unassigned["shipped"] = False
            unassigned["license"]["status"] = "unknown"
        for package in dependencies:
            evidence = package["license"]
            if (evidence["status"] == "unknown" or evidence["missingDeclaredFiles"]
                    or any(item["bytes"] == 0 for item in evidence["files"])):
                warnings.append(f"License evidence unknown, absent or empty: {package['name']}.")
        for component in components:
            evidence = component["license"]
            if component["shipped"] and (evidence["status"] == "unknown"
                    or any(item["bytes"] == 0 for item in evidence["files"])):
                warnings.append(f"Component license evidence unknown or empty: {component['name']}.")
        inventory = {
            "schemaVersion": SCHEMA_VERSION, "scope": "completed_xpi_archive_metadata",
            "nativeExecution": "not_tested", "licenseCompliance": "unknown",
            "licenseScope": "Packaged METADATA/RECORD, native hashes and matching bundled notices/provenance; "
                            "not a legal opinion or an exhaustive native-library audit.",
            "licenseProvenance": provenance,
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
