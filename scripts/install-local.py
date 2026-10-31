"""Install runtime files into an explicitly supplied vault; preserve settings."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("vault", type=Path)
parser.add_argument("--config-dir", default=".obsidian")
args = parser.parse_args()
project = Path(__file__).resolve().parent.parent
manifest = json.loads((project / "dist/manifest.json").read_text())
vault = args.vault.resolve(strict=True)
relative = Path(args.config_dir)
if relative.is_absolute() or ".." in relative.parts:
    parser.error("--config-dir must be relative to the vault")
config = vault / relative
if not config.is_dir() or not config.resolve().is_relative_to(vault):
    raise SystemExit("Expected an existing configuration directory inside the vault.")
plugins = config / "plugins"
if plugins.is_symlink():
    raise SystemExit("Refusing to install into a symlinked plugins directory.")
target = plugins / manifest["id"]
if target.is_symlink():
    raise SystemExit("Refusing to replace a symlinked plugin directory.")
assets = {name: (project / "dist" / name).read_bytes() for name in ["main.js", "manifest.json", "styles.css"]}
if target.exists():
    backup = config / ".english-flow-backups" / (target.name + "-" + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(target, backup)
    print("Existing plugin backed up:", backup)
target.mkdir(parents=True, exist_ok=True)
for name, content in assets.items():
    descriptor, temporary = tempfile.mkstemp(prefix=".install-", dir=target)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target / name)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    if (target / name).read_bytes() != content:
        raise SystemExit("Installed asset verification failed: " + name)
print(json.dumps({"installed": str(target), "version": manifest["version"], "main_js_sha256": hashlib.sha256(assets["main.js"]).hexdigest(), "existing_settings_preserved": True, "enabled_registry_unchanged": True}, ensure_ascii=False, indent=2))
