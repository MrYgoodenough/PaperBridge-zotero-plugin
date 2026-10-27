"""Remove this machine's home path from bundled build metadata before publishing."""
import subprocess
from pathlib import Path


def sanitize_runtime(runtime):
    home = str(Path.home()).encode()
    # Keep binary offsets unchanged, including embedded C strings and debug paths.
    replacement = b"/build/user"[:len(home)].ljust(len(home), b"_")
    macho = {b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf",
             b"\xfe\xed\xfa\xce", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}
    changed = []
    for path in sorted(Path(runtime).rglob("*")):
        if not path.is_file():
            continue
        original = path.read_bytes()
        if home not in original:
            continue
        path.write_bytes(original.replace(home, replacement))
        if original[:4] in macho:
            # Changing Mach-O bytes invalidates its existing signature on Apple Silicon.
            subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True)
        changed.append(path.relative_to(runtime).as_posix())
    return changed


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("runtime", type=Path)
    print("Sanitized:", sanitize_runtime(parser.parse_args().runtime))
