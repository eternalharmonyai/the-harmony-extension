"""Stable contracts shared by REST clients — no private references."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


def json_safe(value: Any) -> Any:
    """Convert common Python values into JSON-safe values."""
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [json_safe(item) for item in value]
    if hasattr(value, "to_dict") and callable(value.to_dict):
        return json_safe(value.to_dict())
    if hasattr(value, "__dataclass_fields__"):
        return json_safe(asdict(value))
    return value


@dataclass(frozen=True)
class CreativeContext:
    """Who is calling a tool and what privacy level they have."""
    client_id: str = "local"
    privacy_level: str = "open_presence"
    token_valid: bool = False
    profile: str = "public"


@dataclass(frozen=True)
class CreativeToolSpec:
    """One callable creative tool and its stable schema."""
    name: str
    description: str
    input_schema: dict[str, Any]
    category: str = "creative"
    privacy_class: str = "open_presence"
    cost_class: str = "local"
    mutating: bool = True
    provider_requirements: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return json_safe(asdict(self))


@dataclass
class CreativeResult:
    """Normalized tool result returned by every adapter."""
    success: bool
    tool: str
    result: dict[str, Any] = field(default_factory=dict)
    error: str | None = None
    error_type: str | None = None
    privacy_level: str = "open_presence"
    cost_class: str = "local"
    warnings: list[str] = field(default_factory=list)
    audit_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return json_safe(asdict(self))


def object_schema(properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    """Build the JSON schema shape used by REST clients."""
    return {
        "type": "object",
        "properties": properties,
        "required": required or [],
    }
