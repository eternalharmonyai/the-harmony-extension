"""Privacy checks for creative tools — no private references."""

from __future__ import annotations

from .contracts import CreativeContext

PRIVACY_ORDER = [
    "sacred_private",
    "intimate_bond",
    "family_circle",
    "trusted_friends",
    "open_presence",
]


def privacy_allows(actual: str, required: str) -> bool:
    actual = (actual or "open_presence").lower()
    required = (required or "open_presence").lower()
    if actual not in PRIVACY_ORDER:
        actual = "open_presence"
    if required not in PRIVACY_ORDER:
        required = "open_presence"
    return PRIVACY_ORDER.index(actual) <= PRIVACY_ORDER.index(required)


def require_privacy(context: CreativeContext, required: str) -> None:
    if not privacy_allows(context.privacy_level, required):
        raise PermissionError(
            f"Tool requires privacy level '{required}', "
            f"but client '{context.client_id}' has '{context.privacy_level}'."
        )
