#!/usr/bin/env python3
"""Validate the built Android package, not a source-only APK promise."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path


class VerificationError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VerificationError(message)


def parse_metadata(
    badging: str, permissions_text: str, manifest_tree: str, signature: str, package_id: str,
    release: bool = False,
) -> dict:
    package = re.search(r"^package: name='([^']+)'", badging, re.MULTILINE)
    minimum = re.search(r"^sdkVersion:'(\d+)'", badging, re.MULTILINE)
    target = re.search(r"^targetSdkVersion:'(\d+)'", badging, re.MULTILINE)
    require(package is not None and package.group(1) == package_id, "Unexpected application ID.")
    require(minimum is not None and int(minimum.group(1)) == 26, "Expected Android 8/API 26 minimum.")
    require(target is not None and int(target.group(1)) >= 36, "Expected Android API 36 or newer target.")
    require(
        ("application-debuggable" not in badging) if release else ("application-debuggable" in badging),
        "Release packages must not be debuggable." if release else "This delivery must be explicitly a test/debug build.",
    )
    require(
        re.search(r"android:usesCleartextTraffic[^\n]*(?:0x0\b|false\b)", manifest_tree) is not None,
        "The packaged application must explicitly reject cleartext traffic.",
    )
    require(
        re.search(r"android:allowBackup[^\n]*(?:0x0\b|false\b)", manifest_tree) is not None,
        "The packaged application must explicitly disable account-data backups.",
    )
    permissions = set(
        re.findall(r"uses-permission(?:-sdk-\d+)?: name='([^']+)'", permissions_text)
    )
    required = {
        "android.permission.INTERNET",
        "android.permission.CAMERA",
        "android.permission.RECORD_AUDIO",
    }
    allowed = required | {
        "android.permission.ACCESS_NETWORK_STATE",
        "android.permission.WAKE_LOCK",
        package_id + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
    }
    require(required <= permissions, "The APK is missing required network or media permissions.")
    require(not (permissions - allowed), "Unexpected APK permissions: " + ", ".join(sorted(permissions - allowed)))
    if not release:
        require("Android Debug" in signature, "Expected a temporary Android debug signing certificate.")
    return {
        "applicationId": package_id,
        "minimumSdk": int(minimum.group(1)),
        "targetSdk": int(target.group(1)),
        "debuggable": not release,
        "debugSigned": not release,
        "cleartextTrafficAllowed": False,
        "accountBackupsAllowed": False,
        "permissions": sorted(permissions),
    }


def run_tool(tool: Path, *arguments: str) -> str:
    require(tool.is_file(), "Android build tool is missing: " + tool.name)
    result = subprocess.run(
        [str(tool), *arguments], capture_output=True, text=True, timeout=60, check=False
    )
    require(
        result.returncode == 0,
        tool.name + " could not verify the APK: " + (result.stderr or result.stdout)[-2000:],
    )
    return result.stdout + result.stderr


def ensure_no_private_keys(names: set[str]) -> None:
    require(
        not any(name.endswith((".jks", ".keystore", ".p12", ".pem")) for name in names),
        "Signing or credential material must not be packaged in the application.",
    )


def ensure_unsigned(names: set[str], payload: bytes | None = None) -> None:
    require(
        not any(re.match(r"^META-INF/[^/]+\.(?:SF|RSA|DSA|EC)$", name, re.IGNORECASE) for name in names),
        "CI release artifacts must not contain a signing certificate.",
    )
    if payload is not None:
        eocd = payload.rfind(b"PK\x05\x06", max(0, len(payload) - 65_557))
        require(eocd >= 0 and eocd + 22 <= len(payload), "APK end-of-directory record is missing.")
        central = struct.unpack_from("<I", payload, eocd + 16)[0]
        require(central <= eocd, "APK central-directory offset is invalid.")
        require(payload[max(0, central - 16):central] != b"APK Sig Block 42", "CI release APK unexpectedly contains an APK signing block.")


def elf_16k_alignment(payload: bytes) -> None:
    require(payload[:5] == b"\x7fELF\x02", "Expected an ELF64 ARM64 library.")
    require(payload[5] == 1, "Expected little-endian ELF.")
    require(len(payload) >= 64, "ELF header is truncated.")
    offset = struct.unpack_from("<Q", payload, 32)[0]
    entry_size, count = struct.unpack_from("<HH", payload, 54)
    require(entry_size >= 56 and offset + entry_size * count <= len(payload), "ELF program table is invalid.")
    alignments = [
        struct.unpack_from("<Q", payload, offset + index * entry_size + 48)[0]
        for index in range(count)
        if struct.unpack_from("<I", payload, offset + index * entry_size)[0] == 1
    ]
    require(bool(alignments) and all(value >= 16_384 for value in alignments), "ARM64 native library lacks 16 KB LOAD alignment.")


def write_receipt(source: Path, output: Path, filename: str, metadata: dict) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    destination = output / filename
    shutil.copyfile(source, destination)
    with destination.open("rb") as stream:
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
    (output / "SHA256SUMS.txt").write_text(digest + "  " + destination.name + "\n")
    receipt = {
        **metadata,
        "artifact": destination.name,
        "bytes": destination.stat().st_size,
        "sha256": digest,
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "physicalDeviceTested": False,
        "googlePlayPublished": False,
    }
    (output / "verification.json").write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def verify(apk: Path, tools: Path, package_id: str, output: Path, release: bool = False) -> dict:
    require(apk.is_file(), "The APK build output does not exist.")
    require(apk.stat().st_size > 1_000_000, "The APK is unexpectedly small.")
    with zipfile.ZipFile(apk) as archive:
        require(archive.testzip() is None, "The APK ZIP structure is corrupt.")
        names = set(archive.namelist())
        require("AndroidManifest.xml" in names, "Packaged Android manifest is missing.")
        require("lib/arm64-v8a/libflutter.so" in names, "The APK does not include the ARM64 Flutter engine.")
        ensure_no_private_keys(names)
        if release:
            require("lib/arm64-v8a/libapp.so" in names, "Release APK is missing the AOT application.")
            require("assets/flutter_assets/kernel_blob.bin" not in names, "Release APK contains a debug kernel.")
            ensure_unsigned(names, apk.read_bytes())
            for name in names:
                if name.startswith("lib/arm64-v8a/") and name.endswith(".so"):
                    elf_16k_alignment(archive.read(name))
        else:
            require(
                "assets/flutter_assets/kernel_blob.bin" in names,
                "The APK does not contain the compiled debug Flutter application.",
            )
    badging = run_tool(tools / "aapt", "dump", "badging", str(apk))
    permissions = run_tool(tools / "aapt", "dump", "permissions", str(apk))
    tree = run_tool(tools / "aapt", "dump", "xmltree", str(apk), "AndroidManifest.xml")
    signature = "Unsigned release artifact; owner signing is required." if release else run_tool(
        tools / "apksigner", "verify", "--verbose", "--print-certs", str(apk)
    )
    metadata = parse_metadata(badging, permissions, tree, signature, package_id, release)
    if release:
        run_tool(tools / "zipalign", "-c", "-P", "16", "4", str(apk))
    receipt = write_receipt(
        apk, output,
        "LiveStar-Android-arm64-release-unsigned.apk" if release else "LiveStar-Android-test.apk",
        {
            **metadata,
            "signed": not release,
            "native16kAlignmentVerified": release,
            "zip16kAlignmentVerified": release,
            "purpose": "Unsigned ARM64 release APK; align and sign with the owner's private key before installation."
            if release else "Installable device-test build, not a production-signed store release.",
        },
    )
    (output / "apk-badging.txt").write_text(badging)
    (output / "apk-signature.txt").write_text(signature)
    return receipt


def verify_bundle(bundle: Path, bundletool: Path, package_id: str, output: Path) -> dict:
    require(bundle.is_file() and bundle.stat().st_size > 1_000_000, "Release AAB is missing or unexpectedly small.")
    require(bundletool.is_file(), "The pinned bundletool JAR is missing.")
    with zipfile.ZipFile(bundle) as archive:
        require(archive.testzip() is None, "The AAB ZIP structure is corrupt.")
        names = set(archive.namelist())
        require("base/manifest/AndroidManifest.xml" in names, "AAB base manifest is missing.")
        require("base/lib/arm64-v8a/libapp.so" in names, "AAB is missing the ARM64 AOT application.")
        require("base/lib/arm64-v8a/libflutter.so" in names, "AAB is missing the ARM64 Flutter engine.")
        require("base/assets/flutter_assets/kernel_blob.bin" not in names, "Release AAB contains a debug kernel.")
        ensure_no_private_keys(names)
        ensure_unsigned(names)
        for name in names:
            if name.startswith("base/lib/arm64-v8a/") and name.endswith(".so"):
                elf_16k_alignment(archive.read(name))
    validation = subprocess.run(
        ["java", "-jar", str(bundletool), "validate", "--bundle=" + str(bundle)],
        capture_output=True, text=True, timeout=120, check=False,
    )
    require(validation.returncode == 0, "bundletool rejected the AAB: " + validation.stderr[-2000:])
    dump = subprocess.run(
        ["java", "-jar", str(bundletool), "dump", "manifest", "--bundle=" + str(bundle)],
        capture_output=True, text=True, timeout=60, check=False,
    )
    require(dump.returncode == 0, "bundletool could not read the AAB manifest.")
    manifest = ET.fromstring(dump.stdout)
    android = "{http://schemas.android.com/apk/res/android}"
    sdk, application = manifest.find("uses-sdk"), manifest.find("application")
    require(manifest.get("package") == package_id, "Unexpected AAB application ID.")
    require(int(manifest.get(android + "versionCode", "0")) > 0, "AAB version code must be positive.")
    require(sdk is not None and sdk.get(android + "minSdkVersion") == "26", "Unexpected AAB minimum SDK.")
    require(sdk is not None and int(sdk.get(android + "targetSdkVersion", "0")) >= 36, "Unexpected AAB target SDK.")
    require(application is not None and application.get(android + "debuggable", "false") == "false", "Release AAB must not be debuggable.")
    require(application is not None and application.get(android + "usesCleartextTraffic") == "false", "AAB must disallow cleartext traffic.")
    require(application is not None and application.get(android + "allowBackup") == "false", "AAB must disable account-data backups.")
    permissions = [node.get(android + "name") for node in manifest.findall("uses-permission")]
    required = {"android.permission.INTERNET", "android.permission.CAMERA", "android.permission.RECORD_AUDIO"}
    allowed = required | {"android.permission.ACCESS_NETWORK_STATE", "android.permission.WAKE_LOCK", package_id + ".DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION"}
    require(required <= set(permissions) <= allowed, "Unexpected AAB permissions.")
    receipt = write_receipt(bundle, output, "LiveStar-Google-Play-unsigned.aab", {
        "applicationId": package_id,
        "minimumSdk": 26,
        "targetSdk": int(sdk.get(android + "targetSdkVersion")),
        "versionCode": manifest.get(android + "versionCode"),
        "versionName": manifest.get(android + "versionName"),
        "debuggable": False,
        "signed": False,
        "bundletoolValidated": True,
        "native16kAlignmentVerified": True,
        "permissions": sorted(permissions),
        "purpose": "Release AAB for owner upload-key signing; not yet uploadable or published.",
    })
    (output / "bundle-manifest.xml").write_text(dump.stdout)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    artifact = parser.add_mutually_exclusive_group(required=True)
    artifact.add_argument("--apk", type=Path)
    artifact.add_argument("--bundle", type=Path)
    parser.add_argument("--release", action="store_true", help="Verify an unsigned release APK.")
    parser.add_argument("--build-tools", type=Path)
    parser.add_argument("--bundletool", type=Path)
    parser.add_argument("--package-id", default="com.livestar.live")
    parser.add_argument("--output-dir", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        if arguments.bundle:
            require(arguments.bundletool is not None, "--bundletool is required for AAB validation.")
            result = verify_bundle(arguments.bundle, arguments.bundletool, arguments.package_id, arguments.output_dir)
        else:
            require(arguments.build_tools is not None, "--build-tools is required for APK validation.")
            result = verify(arguments.apk, arguments.build_tools, arguments.package_id, arguments.output_dir, arguments.release)
        print(json.dumps(result, indent=2))
    except (VerificationError, OSError, zipfile.BadZipFile, subprocess.TimeoutExpired) as error:
        print("Android artifact verification failed: " + str(error), file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
