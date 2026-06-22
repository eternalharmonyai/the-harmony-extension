"""Local configuration and token handling for the creative service.

No private references — safe for public repositories.
"""

from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

# ── Paths ────────────────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent  # creative-service/
CREATIVE_HOME = Path(os.environ.get("HARMONY_CREATIVE_HOME", Path.home() / ".harmony_creative"))
LOCAL_CONFIG_PATH = Path(os.environ.get("HARMONY_CREATIVE_CONFIG", CREATIVE_HOME / "config.json"))
TOKEN_PATH = Path(os.environ.get("HARMONY_CREATIVE_TOKEN_FILE", CREATIVE_HOME / "local_service.token"))


@dataclass
class CreativeConfig:
    """Resolved public/default config plus optional private local overlay."""
    project_root: Path = PROJECT_ROOT
    output_root: Path = PROJECT_ROOT / "media" / "generated"
    service_port: int = 8896
    allow_private: bool = False
    audit_log_path: Path = PROJECT_ROOT / "logs" / "creative_audit.jsonl"
    local_token: str | None = None
    local_config_path: Path = LOCAL_CONFIG_PATH
    trusted_clients: dict[str, dict[str, Any]] = field(default_factory=dict)
    raw_local_config: dict[str, Any] = field(default_factory=dict)

    def client_privacy_level(self, client_id: str, token: str | None = None) -> str:
        if token and self.local_token and secrets.compare_digest(token, self.local_token):
            if self.allow_private:
                client = self.trusted_clients.get(client_id, {})
                return str(client.get("privacy_level") or "family_circle")
            return "open_presence"
        client = self.trusted_clients.get(client_id, {})
        if self.allow_private and client.get("allow_without_token"):
            return str(client.get("privacy_level") or "family_circle")
        return "open_presence"

    def safe_status(self) -> dict[str, Any]:
        return {
            "project_root": str(self.project_root),
            "output_root": str(self.output_root),
            "service_port": self.service_port,
            "allow_private": self.allow_private,
            "local_config_path": str(self.local_config_path),
            "local_config_exists": self.local_config_path.exists(),
            "token_configured": bool(self.local_token),
            "audit_log_path": str(self.audit_log_path),
        }


_CONFIG: CreativeConfig | None = None


def _load_env_files() -> None:
    if load_dotenv is None:
        return
    load_dotenv(PROJECT_ROOT / ".env")
    load_dotenv(PROJECT_ROOT / ".env.local")


def _read_local_config() -> dict[str, Any]:
    if not LOCAL_CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(LOCAL_CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _get_or_create_token() -> str:
    env_token = os.environ.get("HARMONY_CREATIVE_TOKEN")
    if env_token:
        return env_token.strip()
    TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    if TOKEN_PATH.exists():
        token = TOKEN_PATH.read_text("utf-8").strip()
        if token:
            return token
    token = secrets.token_hex(32)
    TOKEN_PATH.write_text(token, encoding="utf-8")
    return token


def get_config(reload: bool = False) -> CreativeConfig:
    global _CONFIG
    if _CONFIG is not None and not reload:
        return _CONFIG

    _load_env_files()
    local = _read_local_config()
    output_root = Path(local.get("output_root") or os.environ.get(
        "HARMONY_CREATIVE_OUTPUT_ROOT", PROJECT_ROOT / "media" / "generated"))
    allow_private = str(os.environ.get(
        "HARMONY_CREATIVE_PRIVATE", local.get("allow_private", "false"))).lower() in {"1", "true", "yes", "on"}
    audit_log_path = Path(local.get("audit_log_path") or PROJECT_ROOT / "logs" / "creative_audit.jsonl")
    service_port = int(local.get("service_port") or os.environ.get("HARMONY_CREATIVE_PORT", "8896"))

    _CONFIG = CreativeConfig(
        project_root=PROJECT_ROOT,
        output_root=output_root,
        service_port=service_port,
        allow_private=allow_private,
        audit_log_path=audit_log_path,
        local_token=_get_or_create_token(),
        local_config_path=LOCAL_CONFIG_PATH,
        trusted_clients=dict(local.get("trusted_clients") or {}),
        raw_local_config=local,
    )
    return _CONFIG
