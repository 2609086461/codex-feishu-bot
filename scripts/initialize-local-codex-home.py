"""Create an isolated Codex home without copying caches, logs, or writer locks."""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def copy_file(source: Path, target: Path, *, overwrite: bool = True) -> None:
    if not source.is_file() or (target.exists() and not overwrite):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)


def copy_tree(source: Path, target: Path) -> None:
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True)


def sqlite_snapshot(source: Path, target: Path) -> None:
    if not source.is_file():
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.unlink(missing_ok=True)
    source_db = sqlite3.connect(f"file:{source.as_posix()}?mode=ro", uri=True)
    try:
        target_db = sqlite3.connect(temporary)
        try:
            source_db.backup(target_db)
        finally:
            target_db.close()
    finally:
        source_db.close()
    temporary.replace(target)


def rewrite_config(source: Path, target: Path, source_home: Path, target_home: Path) -> None:
    if not source.is_file():
        return
    text = source.read_text(encoding="utf-8")
    source_value = str(source_home)
    target_value = str(target_home)
    text = text.replace(
        f"CODEX_HOME = '{source_value}'",
        f"CODEX_HOME = '{target_value}'",
    )
    target.write_text(text, encoding="utf-8")


def initialize(source: Path, target: Path) -> dict[str, object]:
    if source.resolve() == target.resolve():
        raise ValueError("Source and target Codex homes must differ")
    if not (source / "auth.json").is_file():
        raise FileNotFoundError(f"Missing Codex auth: {source / 'auth.json'}")

    target.mkdir(parents=True, exist_ok=True)
    marker = target / ".feishu-bot-home.json"
    first_run = not marker.exists()

    copy_file(source / "auth.json", target / "auth.json", overwrite=False)
    rewrite_config(source / "config.toml", target / "config.toml", source, target)
    copy_tree(source / "skills", target / "skills")
    copy_tree(source / "rules", target / "rules")

    if first_run:
        copy_tree(source / "sessions", target / "sessions")
        copy_tree(source / "attachments", target / "attachments")
        copy_file(source / ".codex-global-state.json", target / ".codex-global-state.json")
        copy_file(source / "session_index.jsonl", target / "session_index.jsonl")
        for pattern in (
            "state_*.sqlite",
            "thread_history_*.sqlite",
            "goals_*.sqlite",
            "memories_*.sqlite",
        ):
            for database in source.glob(pattern):
                sqlite_snapshot(database, target / database.name)

    payload = {
        "version": 1,
        "initializedAt": datetime.now(timezone.utc).isoformat(),
        "source": str(source),
        "historySnapshotCreated": first_run,
    }
    marker.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(initialize(args.source, args.target)))


if __name__ == "__main__":
    main()
