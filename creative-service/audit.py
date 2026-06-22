"""Structured audit logging for creative tool calls."""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import get_config
from .contracts import CreativeContext, json_safe


def write_audit_event(
    *,
    tool: str,
    context: CreativeContext,
    success: bool,
    privacy_required: str,
    cost_class: str,
    provider_tier: str | None = None,
    output_path: str | None = None,
    error_type: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    config = get_config()
    audit_id = uuid.uuid4().hex
    event = {
        "audit_id": audit_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "client_id": context.client_id,
        "profile": context.profile,
        "tool": tool,
        "success": success,
        "privacy_level": context.privacy_level,
        "privacy_required": privacy_required,
        "cost_class": cost_class,
        "provider_tier": provider_tier,
        "output_path": output_path,
        "error_type": error_type,
        "metadata": json_safe(metadata or {}),
    }
    config.audit_log_path.parent.mkdir(parents=True, exist_ok=True)
    with config.audit_log_path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    return audit_id
