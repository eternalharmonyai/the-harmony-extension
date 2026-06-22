"""Secret lookup helpers — never expose raw key values to clients."""

from __future__ import annotations

import os
from dataclasses import dataclass

from .config import get_config

SECRET_NAMES = [
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "BFL_API_KEY",
    "FAL_API_KEY",
    "FAL_KEY",
    "REPLICATE_API_TOKEN",
    "RUNPOD_API_KEY",
]


@dataclass
class SecretResolver:
    """Resolve named provider secrets from env or private local config."""

    def get(self, name: str) -> str | None:
        if os.environ.get(name):
            return os.environ[name]
        config = get_config()
        secrets_cfg = config.raw_local_config.get("secrets", {}) if config.raw_local_config else {}
        value = secrets_cfg.get(name)
        return str(value) if value else None

    def configured(self, name: str) -> bool:
        return bool(self.get(name))

    def safe_status(self) -> dict[str, bool]:
        return {name: self.configured(name) for name in SECRET_NAMES}
