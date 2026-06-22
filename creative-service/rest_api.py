"""Harmony Creative REST API — bundled with the extension.

This adapter serves the creative tools over HTTP on port 8896.
It imports from the local creative-service package (no external dependencies
beyond fastapi, uvicorn, and Pillow).

Start with:  python creative-service/rest_api.py
Or via the extension: Harmony: Start Creative Service
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# Ensure creative-service/ is on sys.path so local imports work
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from config import get_config
from core import context_from_client, get_core


class ToolCallRequest(BaseModel):
    tool: str = Field(..., description="Creative tool name")
    arguments: dict[str, Any] = Field(default_factory=dict, description="Tool arguments")
    client_id: str = Field("rest-local", description="Calling client id")
    profile: str = Field("public", description="Client profile label")


app = FastAPI(
    title="Harmony Creative API",
    description="Portable local creative tools — bundled with the Harmony extension.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1", "http://localhost", "http://127.0.0.1:8889", "http://localhost:8889"],
    allow_origin_regex=r"^(https://.*\.vscode-cdn\.net|vscode-webview://.*|http://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root() -> dict[str, Any]:
    return {
        "name": "Harmony Creative API",
        "version": "0.1.0",
        "port": get_config().service_port,
        "endpoints": ["GET /health", "GET /tools", "POST /call"],
    }


@app.get("/health")
async def health(x_harmony_creative_token: str | None = Header(default=None)) -> dict[str, Any]:
    context = context_from_client("rest-health", x_harmony_creative_token, "health")
    result = get_core().call_tool("creative_health", {}, context).to_dict()
    return result


@app.get("/tools")
async def tools() -> dict[str, Any]:
    return {"tools": get_core().list_tools()}


@app.post("/call")
async def call_tool(
    req: ToolCallRequest, x_harmony_creative_token: str | None = Header(default=None)
) -> dict[str, Any]:
    context = context_from_client(req.client_id, x_harmony_creative_token, req.profile)
    result = get_core().call_tool(req.tool, req.arguments, context)
    return result.to_dict()


if __name__ == "__main__":
    import uvicorn

    config = get_config()
    print(f"Harmony Creative API starting on port {config.service_port}...")
    uvicorn.run(app, host="127.0.0.1", port=config.service_port, log_level="info")
