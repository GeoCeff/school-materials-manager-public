"""Refresh notices from the installed canvas SBOM; run manually after dependency changes."""
import base64
import concurrent.futures
import hashlib
import io
import json
import re
import tarfile
import tomllib
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "output" / "native-license-cache"
TARGET = ROOT / "licenses" / "native"
CACHE.mkdir(parents=True, exist_ok=True)
sbom_bytes = (ROOT / "node_modules/@napi-rs/canvas-win32-x64-msvc/sbom.cdx.json").read_bytes()
sbom = json.loads(sbom_bytes)
version = sbom["metadata"]["component"]["version"]
assert version == json.loads((ROOT / "node_modules/@napi-rs/canvas/package.json").read_text())["version"]
# ponytail: Skia's pinned revision below is for canvas 1.0.11; review its new submodule before upgrading.
assert version == "1.0.11", "Review the canvas source tag and Skia revision before updating native notices"


def download(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Archive-Search-license-review"})
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            data = response.read(20 * 1024 * 1024 + 1)
    except urllib.error.HTTPError as error:
        error.add_note(url)
        raise
    if len(data) > 20 * 1024 * 1024:
        raise ValueError("License source exceeded its download limit")
    return data


def cargo(component):
    name, release = component["name"], component["version"]
    assert re.fullmatch(r"[a-zA-Z0-9_-]+", name)
    assert re.fullmatch(r"[a-zA-Z0-9.+_-]+", release)
    url = f"https://static.crates.io/crates/{name}/{name}-{release}.crate"
    cached = CACHE / f"{name}-{release}.crate"
    data = cached.read_bytes() if cached.exists() else download(url)
    expected = next(item["content"] for item in component["hashes"] if item["alg"] == "SHA-256")
    assert hashlib.sha256(data).hexdigest() == expected, f"SBOM source checksum mismatch: {name}"
    cached.write_bytes(data)
    texts = []
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        if any(item.get("expression") == "MPL-2.0" for item in component.get("licenses", [])):
            entries = archive.getmembers()
            assert len(entries) < 5000 and sum(entry.size for entry in entries) < 10 * 1024 * 1024
            assert all(not entry.name.startswith("/") and ".." not in entry.name.split("/")
                       and (entry.isfile() or entry.isdir()) for entry in entries), "Unsafe covered-source archive"
        for entry in archive.getmembers():
            filename = entry.name.rsplit("/", 1)[-1]
            if entry.isfile() and re.match(r"^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE)(?:[._-]|$)", filename, re.I):
                if entry.size > 1024 * 1024:
                    raise ValueError("License file exceeded 1 MiB")
                texts.append((entry.name, archive.extractfile(entry).read().decode("utf-8", errors="replace")))
        if not texts:
            prefix = f"{name}-{release}/"
            package = tomllib.loads(archive.extractfile(prefix + "Cargo.toml").read().decode())["package"]
            vcs = json.loads(archive.extractfile(prefix + ".cargo_vcs_info.json").read())
            repository = package["repository"].removesuffix(".git")
            revision = vcs["git"]["sha1"]
            assert re.fullmatch(r"https://github.com/[\w.-]+/[\w.-]+", repository)
            assert re.fullmatch(r"[a-f0-9]{40}", revision)
            license_url = repository.replace("https://github.com/", "https://raw.githubusercontent.com/") + f"/{revision}/LICENSE"
            texts.append((license_url, download(license_url).decode("utf-8")))
    return {"name": name, "version": release, "licenses": component.get("licenses", []),
            "source": url, "sha256": expected, "texts": texts,
            "coveredSource": any(item.get("expression") == "MPL-2.0" for item in component.get("licenses", []))}


components = [item for item in sbom["components"] if item.get("purl", "").startswith("pkg:cargo/")
              and any(value["alg"] == "SHA-256" for value in item.get("hashes", []))]
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    crates = list(pool.map(cargo, components))
missing = [item["name"] for item in crates if not item["texts"]]
if missing:
    raise ValueError("Crate packages lack license files; review upstream sources: " + ", ".join(missing))

native_files = {
    "expat": ["COPYING"], "freetype": ["docs/FTL.TXT", "LICENSE.TXT"],
    "brotli": ["LICENSE"], "harfbuzz": ["COPYING"], "icu": ["LICENSE", "icu4c/LICENSE"],
    "libjxl": ["LICENSE"], "highway": ["LICENSE", "LICENSE-BSD3", "NOTICE"],
    "libjpeg-turbo": ["LICENSE.md", "README.ijg"], "libpng": ["LICENSE"],
    "libwebp": ["COPYING", "PATENTS"], "wuffs": ["LICENSE", "PATENTS"], "zlib": ["LICENSE"],
}
native = []
for component in sbom["components"]:
    if not component.get("purl", "").startswith("pkg:generic/"):
        continue
    repository = next(item["value"] for item in component["properties"] if item["name"] == "cdx:skia:repositoryUrl")
    texts = []
    for filename in native_files[component["name"]]:
        url = f"{repository}/+/{component['version']}/{filename}?format=TEXT"
        try:
            text = base64.b64decode(download(url), validate=False).decode("utf-8")
            texts.append((url, text))
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise
    if not texts:
        raise ValueError("Native source lacks reviewed license files: " + component["name"])
    native.append({"name": component["name"], "version": component["version"],
                   "source": repository, "licenses": component.get("licenses", []), "texts": texts})

# Pinned canvas source tag records the exact Skia submodule revision.
skia_revision = "95ee33d7ec7791ab9c071675710a14fe6408ae4f"
skia_url = f"https://raw.githubusercontent.com/google/skia/{skia_revision}/LICENSE"
native.insert(0, {"name": "Skia", "version": skia_revision,
                  "source": f"https://github.com/google/skia/tree/{skia_revision}",
                  "licenses": [{"license": {"id": "BSD-3-Clause"}}],
                  "texts": [(skia_url, download(skia_url).decode("utf-8"))]})

TARGET.mkdir(parents=True, exist_ok=True)
parts = [f"Archive Search - native canvas {version} supplemental notices\n\n"
         "This inventory is derived from the exact installed Windows canvas SBOM. It includes\n"
         "Rust build/target dependencies conservatively as listed by the upstream inventory.\n"
         "It supplements THIRD_PARTY_NOTICES.txt and Electron/Chromium's license resources.\n"
         "The app's own public distribution license remains an owner decision.\n\n"
         "Unmodified MPL-2.0 covered source packages are supplied in this directory.\n"
         "Their license governs those sources; the source URLs below provide another way to\n"
         "obtain the exact upstream source at no charge. SOURCE_MANIFEST.json records hashes.\n"
         "No third-party source was modified. Other third-party terms remain as reproduced.\n"]
manifest = {"canvasVersion": version, "sbomSha256": hashlib.sha256(sbom_bytes).hexdigest(),
            "skiaRevision": skia_revision, "components": [], "coveredSources": []}
for item in crates + native:
    license_ids = "; ".join(license.get("expression") or license.get("license", {}).get("id", "") for license in item["licenses"])
    parts.append(f"\n{'=' * 72}\n{item['name']} {item['version']}\nLicense: {license_ids}\nSource: {item['source']}\n")
    for location, text in item["texts"]:
        parts.append(f"\n--- {location} ---\n{text.rstrip()}\n")
    manifest["components"].append({key: value for key, value in item.items() if key not in ("texts", "coveredSource")})
    if item.get("coveredSource"):
        filename = f"{item['name']}-{item['version']}.crate"
        data = (CACHE / filename).read_bytes()
        (TARGET / filename).write_bytes(data)
        manifest["coveredSources"].append({"file": filename, "url": item["source"], "sha256": item["sha256"]})
(TARGET / "THIRD_PARTY_NOTICES.txt").write_text("\n".join(parts), encoding="utf-8", newline="\n")
(TARGET / "SOURCE_MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
print(json.dumps({"canvas": version, "cargoComponents": len(crates), "nativeComponents": len(native),
                  "coveredSources": len(manifest["coveredSources"]), "noticeBytes": (TARGET / "THIRD_PARTY_NOTICES.txt").stat().st_size}))
