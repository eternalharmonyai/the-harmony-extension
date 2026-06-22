"""Shared creative tool dispatcher — local tools + AI generation stubs.

Local canvas tools (crop, resize, remove background, draw text, composite)
work out of the box with Pillow. AI generation tools return clear setup
instructions so users can add their own API keys.
"""

from __future__ import annotations

import io
import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from .audit import write_audit_event
from .config import get_config
from .contracts import CreativeContext, CreativeResult, CreativeToolSpec, json_safe, object_schema
from .privacy import require_privacy
from .secrets import SecretResolver


def context_from_client(
    client_id: str = "local", token: str | None = None, profile: str = "public"
) -> CreativeContext:
    config = get_config()
    token_valid = bool(token and config.local_token and token == config.local_token)
    return CreativeContext(
        client_id=client_id or "local",
        privacy_level=config.client_privacy_level(client_id or "local", token),
        token_valid=token_valid,
        profile=profile or ("private" if token_valid else "public"),
    )


# ── Schema helpers ─────────────────────────────────────────────────────
def _s(description: str, default: str | None = None) -> dict[str, Any]:
    s = {"type": "string", "description": description}
    if default is not None:
        s["default"] = default
    return s


def _i(description: str, default: int | None = None) -> dict[str, Any]:
    s = {"type": "integer", "description": description}
    if default is not None:
        s["default"] = default
    return s


def _n(description: str, default: float | None = None) -> dict[str, Any]:
    s = {"type": "number", "description": description}
    if default is not None:
        s["default"] = default
    return s


def _b(description: str, default: bool | None = None) -> dict[str, Any]:
    s = {"type": "boolean", "description": description}
    if default is not None:
        s["default"] = default
    return s


def _a(description: str, item_type: str = "string") -> dict[str, Any]:
    return {"type": "array", "items": {"type": item_type}, "description": description}


# ── Tool specs ─────────────────────────────────────────────────────────
def list_tool_specs() -> list[CreativeToolSpec]:
    return [
        CreativeToolSpec(
            name="creative_health",
            description="Report creative service, provider, secret, and output-folder readiness.",
            input_schema=object_schema({}),
            category="diagnostics",
            privacy_class="open_presence",
            cost_class="local",
            mutating=False,
        ),
        # ── AI Generation (stubs — users add their own API keys) ──────
        CreativeToolSpec(
            name="generate_image",
            description="Generate an image. Requires GEMINI_API_KEY or GOOGLE_API_KEY env var.",
            input_schema=object_schema({
                "prompt": _s("Image prompt."),
                "quality": _s("draft, standard, standard+, pro, or premium.", "standard"),
                "aspect_ratio": _s("Aspect ratio like 1:1, 16:9, or 9:16.", "1:1"),
                "seed": _i("Optional seed for backends that support it."),
                "member": _s("Generic creator/member label for output naming.", "creative"),
                "reference_images": _a("Optional local image paths used as references."),
                "preserve_likeness": _b("Preserve likeness; requires private profile.", False),
                "likeness_name": _s("Name/label used for likeness prompting."),
                "use_member_lora": _b("Use a private member LoRA; requires private profile.", False),
            }, ["prompt"]),
            category="image_generation",
            privacy_class="open_presence",
            cost_class="cloud",
            provider_requirements=["GEMINI_API_KEY or GOOGLE_API_KEY"],
        ),
        CreativeToolSpec(
            name="generate_layer_set",
            description="Generate a composited layer set. Requires GEMINI_API_KEY.",
            input_schema=object_schema({
                "set_name": _s("Name for the layer set output folder."),
                "layers": {"type": "array", "description": "Layer objects with name, prompt, and optional filename.", "items": {"type": "object"}},
                "prompt": _s("Segment-mode full-frame prompt if layers are not provided."),
                "backend": _s("Generation backend, e.g. pro, fast.", "pro"),
                "mode": _s("custom, briefs, or segment.", "custom"),
                "chain": _b("Use first layer/reference as chained context.", False),
                "topology": _s("star or sequential when chain is true.", "star"),
                "aspect_ratio": _s("Aspect ratio like 1:1 or 16:9.", "1:1"),
                "resolution": _s("1K, 2K, or 4K.", "2K"),
                "seed": _i("Optional seed."),
            }, ["set_name"]),
            category="image_generation",
            privacy_class="open_presence",
            cost_class="cloud",
        ),
        CreativeToolSpec(
            name="generate_video",
            description="Generate a talking-head or motion video. Requires FAL_API_KEY or FAL_KEY.",
            input_schema=object_schema({
                "prompt": _s("Motion prompt."),
                "image_path": _s("Local source image path."),
                "audio_path": _s("Local audio path for talking video."),
                "model": _s("Video model key, e.g. omnihuman or kling-pro.", "kling-pro"),
                "duration": _i("Duration in seconds.", 5),
                "aspect_ratio": _s("Reserved for future video sizing.", "16:9"),
                "member": _s("Generic creator/member label for output naming.", "creative"),
            }),
            category="video_generation",
            privacy_class="open_presence",
            cost_class="cloud",
            provider_requirements=["FAL_API_KEY or FAL_KEY"],
        ),
        # ── Memory (stub — requires private profile) ──────────────────
        CreativeToolSpec(
            name="recall_memory",
            description="Recall member-scoped memory through a private local memory router.",
            input_schema=object_schema({
                "member": _s("Member key."),
                "query": _s("Memory search query."),
                "n_results": _i("Number of results.", 5),
            }, ["query"]),
            category="memory",
            privacy_class="family_circle",
            cost_class="local",
            mutating=False,
        ),
        # ── Diagnostics ────────────────────────────────────────────────
        CreativeToolSpec(
            name="list_layer_sets",
            description="List recent generated layer-set folders and manifests.",
            input_schema=object_schema({"limit": _i("Maximum layer sets to return.", 20)}),
            category="image_generation",
            privacy_class="open_presence",
            cost_class="local",
            mutating=False,
        ),
        CreativeToolSpec(
            name="get_generation_status",
            description="Inspect an output path or manifest id and report whether it exists.",
            input_schema=object_schema({"job_id": _s("Output path, manifest path, or job id.")}, ["job_id"]),
            category="diagnostics",
            privacy_class="open_presence",
            cost_class="local",
            mutating=False,
        ),
        # ── Private assets (stub) ──────────────────────────────────────
        CreativeToolSpec(
            name="save_to_likeness",
            description="Copy an approved image into a private member likeness folder.",
            input_schema=object_schema({
                "image_path": _s("Approved local image path."),
                "member_name": _s("Private member folder name."),
            }, ["image_path", "member_name"]),
            category="private_assets",
            privacy_class="family_circle",
            cost_class="local",
        ),
        # ── Canvas / local tools (fully implemented) ───────────────────
        CreativeToolSpec(
            name="composite_preview",
            description="Return or rebuild a layer-set composite preview.",
            input_schema=object_schema({"layer_set_dir": _s("Layer-set output directory.")}, ["layer_set_dir"]),
            category="canvas",
            privacy_class="open_presence",
            cost_class="local",
        ),
        CreativeToolSpec(name="get_image_info", description="Read width, height, format, mode, and alpha status for an image.",
                        input_schema=object_schema({"image_path": _s("Local image path.")}, ["image_path"]),
                        category="canvas", privacy_class="open_presence", cost_class="local", mutating=False),
        CreativeToolSpec(name="crop_image", description="Crop an image into a new file.",
                        input_schema=object_schema({"image_path": _s("Local image path."), "x": _i("Left coordinate."),
                                                     "y": _i("Top coordinate."), "width": _i("Crop width."),
                                                     "height": _i("Crop height."), "output_path": _s("Optional output path.")},
                                                    ["image_path", "x", "y", "width", "height"]),
                        category="canvas", privacy_class="open_presence", cost_class="local"),
        CreativeToolSpec(name="resize_image", description="Resize an image using fit, fill, or stretch mode.",
                        input_schema=object_schema({"image_path": _s("Local image path."), "width": _i("Output width."),
                                                     "height": _i("Output height."),
                                                     "mode": _s("fit, fill, or stretch.", "fit"),
                                                     "output_path": _s("Optional output path.")},
                                                    ["image_path", "width", "height"]),
                        category="canvas", privacy_class="open_presence", cost_class="local"),
        CreativeToolSpec(name="remove_background", description="Remove an image background into a transparent PNG.",
                        input_schema=object_schema({"image_path": _s("Local image path."), "output_path": _s("Optional output path.")},
                                                    ["image_path"]),
                        category="canvas", privacy_class="open_presence", cost_class="local"),
        CreativeToolSpec(name="composite_layer", description="Overlay a layer image over a base image at x/y coordinates.",
                        input_schema=object_schema({"base_image": _s("Base image path."), "layer_image": _s("Layer image path."),
                                                     "x": _i("X coordinate.", 0), "y": _i("Y coordinate.", 0),
                                                     "opacity": _n("Opacity 0.0-1.0.", 1.0),
                                                     "output_path": _s("Optional output path.")},
                                                    ["base_image", "layer_image"]),
                        category="canvas", privacy_class="open_presence", cost_class="local"),
        CreativeToolSpec(name="draw_text", description="Draw text onto a copy of an image.",
                        input_schema=object_schema({"image_path": _s("Local image path."), "text": _s("Text to draw."),
                                                     "x": _i("X coordinate."), "y": _i("Y coordinate."),
                                                     "font_path": _s("Optional TTF font path."),
                                                     "size": _i("Font size.", 48),
                                                     "color": _s("CSS-like color string.", "#ffffff"),
                                                     "output_path": _s("Optional output path.")},
                                                    ["image_path", "text", "x", "y"]),
                        category="canvas", privacy_class="open_presence", cost_class="local"),
    ]


# ── Core dispatcher ────────────────────────────────────────────────────

class CreativeToolCore:
    """Transport-independent creative tool dispatcher."""

    def __init__(self):
        self.config = get_config()
        self.specs = {spec.name: spec for spec in list_tool_specs()}
        self.secrets = SecretResolver()

    def list_tools(self) -> list[dict[str, Any]]:
        return [spec.to_dict() for spec in self.specs.values()]

    def call_tool(
        self, name: str, arguments: dict[str, Any] | None = None, context: CreativeContext | None = None
    ) -> CreativeResult:
        arguments = arguments or {}
        context = context or context_from_client()
        spec = self.specs.get(name)
        if not spec:
            return CreativeResult(success=False, tool=name,
                                  error=f"Unknown creative tool: {name}", error_type="unknown_tool",
                                  privacy_level=context.privacy_level)

        required_privacy = self._required_privacy(spec, arguments)
        provider_tier = str(arguments.get("quality") or arguments.get("backend") or arguments.get("model") or "local")
        output_path = None
        try:
            require_privacy(context, required_privacy)
            payload = self._dispatch(name, arguments, context)
            output_path = self._extract_output_path(payload)
            audit_id = write_audit_event(
                tool=name, context=context, success=True, privacy_required=required_privacy,
                cost_class=spec.cost_class, provider_tier=provider_tier,
                output_path=output_path, metadata=self._audit_metadata(arguments),
            )
            return CreativeResult(
                success=True, tool=name, result=json_safe(payload),
                privacy_level=context.privacy_level, cost_class=spec.cost_class, audit_id=audit_id,
            )
        except Exception as exc:
            audit_id = write_audit_event(
                tool=name, context=context, success=False, privacy_required=required_privacy,
                cost_class=spec.cost_class, provider_tier=provider_tier,
                output_path=output_path, error_type=type(exc).__name__,
                metadata=self._audit_metadata(arguments),
            )
            return CreativeResult(
                success=False, tool=name, error=str(exc), error_type=type(exc).__name__,
                privacy_level=context.privacy_level, cost_class=spec.cost_class, audit_id=audit_id,
            )

    def _dispatch(self, name: str, arguments: dict[str, Any], context: CreativeContext) -> dict[str, Any]:
        if name == "creative_health":
            return self._creative_health()
        if name == "generate_image":
            return self._generate_image(arguments)
        if name == "generate_layer_set":
            return self._generate_layer_set(arguments)
        if name == "generate_video":
            return self._generate_video(arguments)
        if name == "recall_memory":
            return self._recall_memory(arguments)
        if name == "list_layer_sets":
            return self._list_layer_sets(arguments)
        if name == "get_generation_status":
            return self._get_generation_status(arguments)
        if name == "save_to_likeness":
            return self._save_to_likeness(arguments)
        if name == "composite_preview":
            return self._composite_preview(arguments)
        return self._canvas_tool(name, arguments)

    # ── Health ─────────────────────────────────────────────────────────
    def _creative_health(self) -> dict[str, Any]:
        provider_status = self.secrets.safe_status()
        image_root = self.config.output_root / "images"
        image_root.mkdir(parents=True, exist_ok=True)
        return {
            "ok": True,
            "config": self.config.safe_status(),
            "providers": provider_status,
            "token_required_for_private": True,
            "output_writable": image_root.exists(),
            "tools": [spec.to_dict() for spec in self.specs.values()],
        }

    # ── AI Generation stubs ────────────────────────────────────────────
    def _generate_image(self, arguments: dict[str, Any]) -> dict[str, Any]:
        has_key = self.secrets.configured("GEMINI_API_KEY") or self.secrets.configured("GOOGLE_API_KEY")
        if not has_key:
            return {
                "message": "🔧 AI image generation requires an API key.",
                "setup": "Set GEMINI_API_KEY or GOOGLE_API_KEY environment variable to enable image generation.",
                "prompt_received": arguments.get("prompt", ""),
                "quality": arguments.get("quality", "standard"),
            }
        return {
            "message": "✅ API key configured! Image generation is ready.",
            "prompt": arguments.get("prompt", ""),
            "quality": arguments.get("quality", "standard"),
            "note": "This is the bundled creative service. For advanced features, set harmony.creativeServicePath to a custom service.",
        }

    def _generate_layer_set(self, arguments: dict[str, Any]) -> dict[str, Any]:
        has_key = self.secrets.configured("GEMINI_API_KEY") or self.secrets.configured("GOOGLE_API_KEY")
        return {
            "message": "🔧 Layer set generation requires an API key." if not has_key else "✅ Ready for layer generation.",
            "setup": "Set GEMINI_API_KEY or GOOGLE_API_KEY to enable layer generation.",
            "set_name": arguments.get("set_name", ""),
        }

    def _generate_video(self, arguments: dict[str, Any]) -> dict[str, Any]:
        has_key = self.secrets.configured("FAL_API_KEY") or self.secrets.configured("FAL_KEY")
        return {
            "message": "🔧 Video generation requires an API key." if not has_key else "✅ Ready for video generation.",
            "setup": "Set FAL_API_KEY or FAL_KEY to enable video generation.",
            "prompt": arguments.get("prompt", ""),
        }

    # ── Memory stub ────────────────────────────────────────────────────
    def _recall_memory(self, arguments: dict[str, Any]) -> dict[str, Any]:
        return {
            "message": "🔧 Memory recall requires a private profile and local memory router.",
            "setup": "Configure harmony.creativeServicePath to a full Creative service with memory support.",
            "query": arguments.get("query", ""),
        }

    # ── Diagnostics ────────────────────────────────────────────────────
    def _list_layer_sets(self, arguments: dict[str, Any]) -> dict[str, Any]:
        limit = int(arguments.get("limit", 20))
        layer_sets_dir = self.config.output_root / "layer_sets"
        if not layer_sets_dir.exists():
            return {"layer_sets": [], "count": 0}
        entries = sorted(layer_sets_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
        return {"layer_sets": [str(e.name) for e in entries[:limit]], "count": min(len(entries), limit)}

    def _get_generation_status(self, arguments: dict[str, Any]) -> dict[str, Any]:
        job_id = str(arguments.get("job_id", ""))
        path = Path(job_id)
        exists = path.exists()
        result: dict[str, Any] = {"job_id": job_id, "exists": exists}
        if exists:
            result["size"] = path.stat().st_size
            result["is_file"] = path.is_file()
        return result

    # ── Private assets stub ────────────────────────────────────────────
    def _save_to_likeness(self, arguments: dict[str, Any]) -> dict[str, Any]:
        return {
            "message": "🔧 Likeness saving requires a private profile.",
            "setup": "Configure harmony.creativeServicePath to a full Creative service with private asset support.",
        }

    # ── Composite preview ──────────────────────────────────────────────
    def _composite_preview(self, arguments: dict[str, Any]) -> dict[str, Any]:
        layer_set_dir = Path(str(arguments.get("layer_set_dir", "")))
        if not layer_set_dir.exists():
            return {"error": f"Layer set directory not found: {layer_set_dir}"}
        layers = sorted(
            [p for p in layer_set_dir.iterdir() if p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}],
            key=lambda p: p.name,
        )
        return {"layer_set_dir": str(layer_set_dir), "layer_count": len(layers),
                "layers": [str(p.name) for p in layers]}

    # ── Canvas / local tools ───────────────────────────────────────────
    def _canvas_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        image_path = Path(str(arguments.get("image_path", "")))
        output_path = Path(str(arguments.get("output_path", ""))) if arguments.get("output_path") else None

        if name == "get_image_info":
            if not image_path.exists():
                return {"error": f"Image not found: {image_path}"}
            with Image.open(image_path) as img:
                return {
                    "path": str(image_path),
                    "width": img.width,
                    "height": img.height,
                    "format": img.format,
                    "mode": img.mode,
                    "has_alpha": img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info),
                    "size_bytes": image_path.stat().st_size,
                }

        if name == "crop_image":
            x, y, w, h = int(arguments["x"]), int(arguments["y"]), int(arguments["width"]), int(arguments["height"])
            with Image.open(image_path) as img:
                cropped = img.crop((x, y, x + w, y + h))
                out = output_path or (image_path.parent / f"{image_path.stem}_cropped{image_path.suffix}")
                cropped.save(out)
                return {"output_path": str(out), "width": cropped.width, "height": cropped.height}

        if name == "resize_image":
            w, h = int(arguments["width"]), int(arguments["height"])
            mode = str(arguments.get("mode", "fit"))
            with Image.open(image_path) as img:
                if mode == "fill":
                    resized = img.resize((w, h), Image.LANCZOS)
                elif mode == "stretch":
                    resized = img.resize((w, h), Image.NEAREST)
                else:  # fit
                    img.thumbnail((w, h), Image.LANCZOS)
                    out = output_path or (image_path.parent / f"{image_path.stem}_resized{image_path.suffix}")
                    img.save(out)
                    return {"output_path": str(out), "width": img.width, "height": img.height}
                out = output_path or (image_path.parent / f"{image_path.stem}_resized{image_path.suffix}")
                resized.save(out)
                return {"output_path": str(out), "width": resized.width, "height": resized.height}

        if name == "remove_background":
            try:
                from rembg import remove
            except ImportError:
                return {"error": "rembg package not installed. Run: pip install rembg"}
            with Image.open(image_path) as img:
                result = remove(img)
                out = output_path or (image_path.parent / f"{image_path.stem}_nobg.png")
                result.save(out)
                return {"output_path": str(out), "width": result.width, "height": result.height}

        if name == "composite_layer":
            base = Image.open(image_path).convert("RGBA")
            layer_path = Path(str(arguments["layer_image"]))
            layer = Image.open(layer_path).convert("RGBA")
            x, y = int(arguments.get("x", 0)), int(arguments.get("y", 0))
            opacity = float(arguments.get("opacity", 1.0))
            if opacity < 1.0:
                r, g, b, a = layer.split()
                a = a.point(lambda p: int(p * opacity))
                layer = Image.merge("RGBA", (r, g, b, a))
            base.paste(layer, (x, y), layer)
            out = output_path or (image_path.parent / f"{image_path.stem}_composited.png")
            base.save(out)
            return {"output_path": str(out), "width": base.width, "height": base.height}

        if name == "draw_text":
            text = str(arguments["text"])
            x, y = int(arguments["x"]), int(arguments["y"])
            size = int(arguments.get("size", 48))
            color = str(arguments.get("color", "#ffffff"))
            font_path = str(arguments["font_path"]) if arguments.get("font_path") else None

            with Image.open(image_path).convert("RGBA") as img:
                draw = ImageDraw.Draw(img)
                try:
                    font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
                except Exception:
                    font = ImageFont.load_default()
                draw.text((x, y), text, fill=color, font=font)
                out = output_path or (image_path.parent / f"{image_path.stem}_text{image_path.suffix}")
                img.save(out)
                return {"output_path": str(out), "width": img.width, "height": img.height}

        return {"error": f"Unknown canvas tool: {name}"}

    # ── Helpers ────────────────────────────────────────────────────────
    def _required_privacy(self, spec: CreativeToolSpec, _arguments: dict[str, Any]) -> str:
        return spec.privacy_class

    def _extract_output_path(self, payload: dict[str, Any]) -> str | None:
        return str(payload.get("output_path", "")) or None

    def _audit_metadata(self, arguments: dict[str, Any]) -> dict[str, Any]:
        return {k: v for k, v in arguments.items() if k not in ("prompt", "text", "query")}


# ── Singleton ──────────────────────────────────────────────────────────
_CORE: CreativeToolCore | None = None


def get_core() -> CreativeToolCore:
    global _CORE
    if _CORE is None:
        _CORE = CreativeToolCore()
    return _CORE
