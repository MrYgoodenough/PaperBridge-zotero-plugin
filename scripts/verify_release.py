"""Check existing build.py artifacts; optionally inspect their public publication."""
import argparse
from fnmatch import fnmatchcase
import hashlib
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
import zipfile

# Source metadata is the default version, addon ID and compatibility baseline.
SOURCE_MANIFEST = Path(__file__).resolve().parents[1] / "addon/manifest.json"
# These public locations and runtime layouts mirror scripts/build.py.
REPOSITORY = "MrYgoodenough/PaperBridge-zotero-plugin"
# Each channel carries native packages for exactly one supported platform.
PLATFORMS = {
    "linux-x64": ("python/bin/python3.12", "python/lib/python3.12/site-packages"),
    "macos-arm64": ("python/bin/python3.12", "python/lib/python3.12/site-packages"),
    "windows-x64": ("python/python.exe", "python/Lib/site-packages"),
}
# Core addon files include the newly integrated native annotation controller.
REQUIRED_ADDON_FILES = (
    "manifest.json", "bootstrap.js", "content/runtime.js", "content/library.js",
    "content/tasks.js", "content/alignment.js", "content/paperbridge.js", "content/annotations.js",
)
# The current backend requires these modules, including errors and diagnostics.
REQUIRED_BACKEND_FILES = (
    "alignment.py", "batching.py", "compact_math.py", "deepseek.py", "diagnostics.py",
    "engine.py", "errors.py", "fonts.py", "launcher.py", "library_cache.py",
    "preserve.py", "references.py", "server.py", "usage.py",
)
# Only model and tokenizer assets are intentional build.py cache payloads.
ASSET_DIRECTORIES = (".cache/babeldoc/models/", ".cache/babeldoc/tiktoken/")
# Local state directories must never be shipped, unlike dependency source modules.
PRIVATE_DIRECTORIES = {
    ".git", ".venv", ".runtime", ".ssh", ".aws", ".azure", ".tools",
    ".pytest_cache", ".mypy_cache", ".ruff_cache", "__pycache__", "logs",
}
# Match private data filenames without rejecting Python modules such as secrets.py.
PRIVATE_FILENAMES = (
    ".env", ".env.*", "credentials*.json", "secrets*.json", "logins.json",
    "id_rsa*", "id_ed25519*", "*.log", "*.log.*", ".ds_store", "thumbs.db",
)
# certifi/cacert.pem is the sole intentional public-certificate exception.
PRIVATE_SUFFIXES = {".pyc", ".pyo", ".db", ".sqlite", ".sqlite3", ".key", ".pem", ".p12", ".pfx"}
# GitHub metadata and checksum requests should finish without fetching the XPI body.
HTTP_TIMEOUT = 30
# A generous metadata-only limit prevents an accidental large asset GET.
MAX_REMOTE_BYTES = 1024 * 1024


class VerificationError(ValueError):
    """An artifact or public metadata violates the existing build contract."""


def _require(condition, message):
    """Report a failed contract without echoing file contents or credentials."""
    if not condition:
        raise VerificationError(message)


def _json_object(contents, label):
    """Read a JSON object with a short, content-free error message."""
    try:
        document = json.loads(contents)
    except (ValueError, UnicodeError):
        raise VerificationError(f"{label} is not valid JSON.") from None
    _require(isinstance(document, dict), f"{label} must be a JSON object.")
    return document


def _zotero(document, label):
    """Extract Zotero metadata without relying on unchecked nested JSON types."""
    applications = document.get("applications")
    _require(isinstance(applications, dict), f"{label} has no applications object.")
    zotero = applications.get("zotero")
    _require(isinstance(zotero, dict), f"{label} has no Zotero metadata.")
    return zotero


def _check_checksum(contents, filename, digest):
    """Match one sha256sum record to the actual XPI, including its filename."""
    try:
        text = contents.decode("utf-8-sig").strip()
    except UnicodeError:
        raise VerificationError("SHA-256 sidecar is not UTF-8.") from None
    record = re.fullmatch(r"([0-9a-fA-F]{64}) [ *]([^\r\n]+)", text)
    _require(record is not None, "SHA-256 sidecar must contain one sha256sum record.")
    _require(record[2] == filename, "SHA-256 sidecar names a different XPI.")
    _require(record[1].lower() == digest, "SHA-256 sidecar does not match actual XPI bytes.")


def _audit_archive(archive, prefix, site_packages, mode):
    """Reject mixed runtimes and accidental private, cache or log archive entries."""
    entries = archive.infolist()
    names = {entry.filename for entry in entries}
    _require(len(entries) == len(names), "XPI contains duplicate archive entries.")
    allowed_caches = tuple(prefix + directory for directory in ASSET_DIRECTORIES)
    public_certificate = prefix + site_packages + "/certifi/cacert.pem"
    for entry in entries:
        name = entry.filename
        parts = name.rstrip("/").split("/")
        _require(
            "\\" not in name and all(part not in {"", ".", ".."} for part in parts)
            and not re.match(r"^[A-Za-z]:", name),
            "XPI contains a non-portable or unsafe archive path.",
        )
        _require(not entry.flag_bits & 1, "XPI contains an encrypted archive entry.")
        lower_parts = [part.lower() for part in parts]
        basename = lower_parts[-1]
        forbidden = bool(PRIVATE_DIRECTORIES.intersection(lower_parts))
        forbidden |= any(fnmatchcase(basename, pattern) for pattern in PRIVATE_FILENAMES)
        forbidden |= Path(basename).suffix in PRIVATE_SUFFIXES and name != public_certificate
        _require(not forbidden, f"Private/cache/log entry must not ship: {name!r}")
        if ".cache" in lower_parts:
            allowed = any(name.startswith(directory) for directory in allowed_caches)
            if entry.is_dir():
                allowed |= any(directory.startswith(name) for directory in allowed_caches)
            _require(allowed, f"Unexpected cache entry must not ship: {name!r}")
        if name.lower().startswith("runtime/") and name != "runtime/":
            _require(name.startswith(prefix), "XPI contains another platform's runtime.")
        if mode == "local" and name.startswith(prefix + "python/") and not entry.is_dir():
            _require(name.startswith(prefix + site_packages + "/"),
                     "Local-Python XPI includes a bundled interpreter or standard library.")
    return names


def verify_release(xpi, sha256, feed, source_manifest=SOURCE_MANIFEST):
    """Verify explicit local artifacts without staging, rebuilding or publishing."""
    xpi, sha256, feed = Path(xpi), Path(sha256), Path(feed)
    source = _json_object(Path(source_manifest).read_bytes(), "Source manifest")
    source_zotero = _zotero(source, "Source manifest")
    version, addon_id = source.get("version"), source_zotero.get("id")
    _require(isinstance(version, str) and bool(version), "Source version is missing.")
    _require(isinstance(addon_id, str) and bool(addon_id), "Source addon ID is missing.")
    with zipfile.ZipFile(xpi) as archive:
        names = archive.namelist()
        _require("manifest.json" in names, "XPI has no addon manifest.")
        # Dependency assets named runtime.json are not top-level runtime manifests.
        manifests = [name for name in names if name.startswith("runtime/")
                     and name.count("/") == 2 and name.endswith("/runtime.json")]
        _require(len(manifests) == 1, "XPI must contain exactly one platform runtime manifest.")
        platform = manifests[0].split("/")[1]
        _require(platform in PLATFORMS, "XPI runtime platform is unsupported.")
        prefix = f"runtime/{platform}/"
        metadata = _json_object(archive.read(manifests[0]), "Runtime manifest")
        mode = metadata.get("pythonMode")
        _require(mode in ("bundled", "local"), "Runtime pythonMode must be bundled or local.")
        _require(metadata.get("version") == version, "Runtime version differs from source version.")
        _require(metadata.get("platform") == platform, "Runtime platform differs from its archive path.")
        suffix = "-local-python" if mode == "local" else ""
        feed_name = f"{platform}{suffix}.json"
        _require(xpi.name == f"paperbridge-{version}-{platform}{suffix}.xpi",
                 "XPI filename differs from version/platform/Python-mode metadata.")
        _require(feed.name == feed_name, "Feed filename selects another platform/Python-mode channel.")
        update_url = f"https://raw.githubusercontent.com/{REPOSITORY}/master/updates/{feed_name}"
        update_link = f"https://github.com/{REPOSITORY}/releases/download/v{version}/{xpi.name}"
        manifest = _json_object(archive.read("manifest.json"), "Built addon manifest")
        zotero = _zotero(manifest, "Built addon manifest")
        _require(manifest.get("version") == version, "Addon version differs from source version.")
        _require(zotero.get("id") == addon_id, "Built addon ID differs from source addon ID.")
        _require(zotero.get("update_url") == update_url,
                 "Addon update URL differs from its platform/Python-mode channel.")
        for key in ("strict_min_version", "strict_max_version"):
            _require(isinstance(source_zotero.get(key), str) and bool(source_zotero[key]),
                     f"Source Zotero compatibility is missing {key}.")
            _require(zotero.get(key) == source_zotero[key], f"Built Zotero {key} differs from source.")
        interpreter, site_packages = PLATFORMS[platform]
        names = _audit_archive(archive, prefix, site_packages, mode)
        required = list(REQUIRED_ADDON_FILES) + [prefix + "backend/" + name for name in REQUIRED_BACKEND_FILES]
        for name in required:
            _require(name in names and archive.getinfo(name).file_size > 0,
                     f"Required module is missing or empty: {name}")
        _require((prefix + interpreter in names) == (mode == "bundled"),
                 "Bundled interpreter presence differs from runtime pythonMode.")
        for directory in (site_packages + "/", *ASSET_DIRECTORIES):
            _require(any(name.startswith(prefix + directory) and not name.endswith("/") for name in names),
                     f"Required runtime directory has no files: {directory}")
        for key in ("payloadSha256", "buildId"):
            value = metadata.get(key)
            _require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value),
                     f"Runtime {key} must be a SHA-256 identity.")
        # Reproduce build.py's identity from packaged metadata and sorted top-level backend sources.
        identity_metadata = dict(metadata)
        build_id = identity_metadata.pop("buildId")
        identity = hashlib.sha256(json.dumps(identity_metadata, sort_keys=True).encode())
        backend_prefix = prefix + "backend/"
        for name in sorted(names):
            if name.startswith(backend_prefix) and name.endswith(".py") and "/" not in name[len(backend_prefix):]:
                identity.update(archive.read(name))
        _require(identity.hexdigest() == build_id, "Runtime buildId does not match packaged backend bytes.")
    # Hash the finished XPI once; do not unpack or re-hash its large native/model payload.
    with xpi.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    _check_checksum(sha256.read_bytes(), xpi.name, digest)
    draft = _json_object(feed.read_bytes(), "Draft update feed")
    addons = draft.get("addons")
    _require(isinstance(addons, dict) and set(addons) == {addon_id}, "Feed addon ID differs from built addon ID.")
    addon = addons[addon_id]
    updates = addon.get("updates") if isinstance(addon, dict) else None
    _require(isinstance(updates, list) and len(updates) == 1 and isinstance(updates[0], dict),
             "Draft feed must contain exactly one update for the explicit XPI.")
    update = updates[0]
    _require(update.get("version") == version, "Feed version differs from built XPI version.")
    _require(update.get("update_link") == update_link, "Feed update link names another version/platform/Python mode.")
    _require(update.get("update_hash") == "sha256:" + digest, "Feed SHA-256 does not match actual XPI bytes.")
    compatibility = _zotero(update, "Draft update")
    for key in ("strict_min_version", "strict_max_version"):
        _require(compatibility.get(key) == zotero[key], f"Feed Zotero {key} differs from built manifest.")
    return {"version": version, "addonId": addon_id, "platform": platform, "pythonMode": mode,
            "buildId": build_id, "sha256": digest, "xpiName": xpi.name, "xpiSize": xpi.stat().st_size,
            "updateUrl": update_url, "updateLink": update_link, "feed": draft}


def _read_public(url, *, head=False, label="Public resource", missing_hint=""):
    """Name failed resources without printing URLs, redirects or response bodies."""
    headers = {"User-Agent": "PaperBridge-release-verifier"}
    if url.startswith("https://api.github.com/"):
        headers["Accept"] = "application/vnd.github+json"
    request = Request(url, headers=headers, method="HEAD" if head else "GET")
    try:
        with urlopen(request, timeout=HTTP_TIMEOUT) as response:
            _require(response.status == 200, f"{label} did not return HTTP 200.")
            if head:
                return b""
            contents = response.read(MAX_REMOTE_BYTES + 1)
    except HTTPError as error:
        message = f"{label} request failed (HTTP {error.code})."
        if error.code == 404 and missing_hint:
            message += " " + missing_hint
        raise VerificationError(message) from None
    except URLError:
        raise VerificationError(f"{label} could not be reached; publication is unverified.") from None
    _require(len(contents) <= MAX_REMOTE_BYTES, f"{label} exceeds the metadata-only download limit.")
    return contents


def _uploaded_asset(release, filename, url):
    """Find one uploaded public asset at the URL advertised by build.py."""
    assets = release.get("assets")
    _require(isinstance(assets, list), "GitHub release has no asset metadata.")
    matching = [asset for asset in assets if isinstance(asset, dict) and asset.get("name") == filename]
    _require(len(matching) == 1,
             f"GitHub release {release.get('tag_name')} is missing a unique expected asset: {filename}. "
             "Use this exact tag; releases/latest is not a per-platform fallback.")
    asset = matching[0]
    _require(asset.get("state") == "uploaded" and asset.get("browser_download_url") == url,
             "GitHub asset is not uploaded at the advertised download URL.")
    return asset


def verify_online(result):
    """Check public feed/assets and GitHub digests without downloading the large XPI."""
    channel = result["updateUrl"].rsplit("/", 1)[-1]
    public_feed = _json_object(_read_public(
        result["updateUrl"], label=f"Public update feed master/updates/{channel}",
        missing_hint="The built URL needs a separately published master/updates file; "
        "dist/updates contains local drafts only. Do not publish unaccepted artifacts to clear this 404.",
    ), "Public update feed")
    _require(public_feed == result["feed"],
             f"Public feed differs from the locally verified draft for {channel}, version {result['version']}. "
             "The public channel may intentionally retain another version or no updates; do not overwrite it to pass this check.")
    tag = "v" + result["version"]
    api_url = f"https://api.github.com/repos/{REPOSITORY}/releases/tags/{quote(tag, safe='')}"
    release = _json_object(_read_public(
        api_url, label=f"GitHub release metadata for {tag}",
        missing_hint="No release for this exact tag is publicly readable; drafts/private releases are not visible here. "
        "A newer releases/latest may contain only another platform's assets; it is not a substitute.",
    ), "GitHub release metadata")
    _require(release.get("tag_name") == tag and release.get("draft") is False and bool(release.get("published_at")),
             "Expected GitHub release is not publicly published.")
    asset = _uploaded_asset(release, result["xpiName"], result["updateLink"])
    # GitHub's asset digest hashes the completed XPI, not runtime payloadSha256.
    _require(asset.get("digest") == "sha256:" + result["sha256"],
             "GitHub XPI SHA-256 digest is missing or mismatched; XPI was not downloaded.")
    _require(asset.get("size") == result["xpiSize"], "GitHub XPI size differs from the local XPI.")
    _read_public(result["updateLink"], head=True, label=f"Public XPI {result['xpiName']}",
                 missing_hint="The advertised exact-tag XPI download is not publicly reachable.")
    checksum_url = result["updateLink"] + ".sha256"
    checksum_asset = _uploaded_asset(release, result["xpiName"] + ".sha256", checksum_url)
    checksum = _read_public(checksum_url, label=f"Public checksum {result['xpiName']}.sha256",
                            missing_hint="The matching .xpi.sha256 sidecar must be separately uploaded to this exact release.")
    _check_checksum(checksum, result["xpiName"], result["sha256"])
    _require(checksum_asset.get("size") == len(checksum)
             and checksum_asset.get("digest") == "sha256:" + hashlib.sha256(checksum).hexdigest(),
             "GitHub checksum asset size/digest is missing or mismatched.")


def main(argv=None):
    """Print separate local/publication results and never claim client update success."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--xpi", type=Path, required=True, help="Explicit completed build.py XPI")
    parser.add_argument("--sha256", type=Path, required=True, help="Explicit matching .xpi.sha256 sidecar")
    parser.add_argument("--feed", type=Path, required=True, help="Explicit platform/mode draft update JSON")
    parser.add_argument("--source-manifest", type=Path, default=SOURCE_MANIFEST, help="Expected source addon manifest")
    parser.add_argument("--online", action="store_true", help="Also check public feed and GitHub assets, read-only")
    args = parser.parse_args(argv)
    try:
        result = verify_release(args.xpi, args.sha256, args.feed, args.source_manifest)
    except (VerificationError, OSError, zipfile.BadZipFile, RuntimeError) as error:
        print(f"LOCAL-FAILED: {error}", file=sys.stderr)
        return 1
    print(f"LOCAL-CONSISTENT: {result['xpiName']}")
    print(f"Addon {result['addonId']} | version {result['version']} | {result['platform']} | Python {result['pythonMode']}")
    print(f"SHA-256: {result['sha256']}\nBuild ID: {result['buildId']}")
    if args.online:
        try:
            verify_online(result)
        except (VerificationError, OSError) as error:
            print(f"PUBLICATION-NOT-VERIFIED: {error}", file=sys.stderr)
            return 1
        print("PUBLISHED-METADATA-VERIFIED: public feed, download URL and GitHub asset digests agree.")
    else:
        print("PUBLICATION-NOT-CHECKED: local consistency is not evidence of a published update.")
    print("AUTOMATIC-UPDATE-NOT-TESTED: Zotero installation and newer-version delivery are separate checks.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
