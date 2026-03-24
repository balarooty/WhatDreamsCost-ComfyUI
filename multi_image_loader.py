import glob
import io as stdio
import os

import folder_paths
import numpy as np
import torch
from PIL import Image, ImageOps

# Module-level constant for maximum images (backend output slot count)
MAX_IMAGES = 50

# Supported image extensions for folder scanning
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif", ".gif"}

# PIL resampling method mapping
_RESAMPLE_MAP = {
    "lanczos": Image.LANCZOS,
    "bilinear": Image.BILINEAR,
    "nearest-exact": Image.NEAREST,
}


def _list_input_subfolders():
    """List subdirectories inside ComfyUI's input directory for the folder browser."""
    input_dir = folder_paths.get_input_directory()
    try:
        entries = ["(none)", ""] + sorted(
            d
            for d in os.listdir(input_dir)
            if os.path.isdir(os.path.join(input_dir, d))
        )
        return entries
    except Exception:
        return ["(none)", ""]


def _scan_folder_for_images(folder_path):
    """Return sorted list of image file paths in a folder."""
    if not os.path.isdir(folder_path):
        return []
    files = []
    for f in sorted(os.listdir(folder_path)):
        if os.path.splitext(f)[1].lower() in _IMAGE_EXTENSIONS:
            files.append(os.path.join(folder_path, f))
    return files


class MultiImageLoader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_paths": ("STRING", {"default": "", "multiline": True}),
                "width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "upscale_method": (["lanczos", "bilinear", "nearest-exact"],),
                "divisible_by": (
                    "INT",
                    {"default": 32, "min": 1, "max": 512, "step": 1},
                ),
                "img_compression": (
                    "INT",
                    {"default": 18, "min": 0, "max": 100, "step": 1},
                ),
            },
            "optional": {
                "input_folder": (_list_input_subfolders(),),
                "import_folder": ("BOOLEAN", {"default": False}),
                "captions": ("STRING", {"default": "", "multiline": True}),
            },
        }

    RETURN_TYPES = ("IMAGE",) * (MAX_IMAGES + 1) + ("STRING",)
    RETURN_NAMES = (
        ("multi_output",)
        + tuple(f"image_{i + 1}" for i in range(MAX_IMAGES))
        + ("captions",)
    )
    FUNCTION = "load_images"
    CATEGORY = "image"

    def load_images(
        self,
        image_paths,
        width,
        height,
        upscale_method,
        divisible_by,
        img_compression,
        input_folder="(none)",
        import_folder=False,
        captions="",
    ):
        # Normalise empty string to "(none)" — workflows saved on other machines may store ""
        if not input_folder:
            input_folder = "(none)"
        results = []
        valid_paths = [p.strip() for p in image_paths.split("\n") if p.strip()]

        # If folder import is enabled, prepend images from the selected input subfolder
        if import_folder and input_folder and input_folder != "(none)":
            folder_full_path = os.path.join(
                folder_paths.get_input_directory(), input_folder
            )
            folder_images = _scan_folder_for_images(folder_full_path)
            # Prepend folder images (they go before manually added ones)
            valid_paths = folder_images + valid_paths

        # Parse captions (one per line, parallel to image_paths)
        caption_list = (
            [c.strip() for c in captions.split("\n")] if captions.strip() else []
        )

        # Track the dimensions of the first processed image
        first_target_w, first_target_h = None, None

        for idx, path in enumerate(valid_paths):
            try:
                # Resolve full path
                full_path = path
                if not os.path.exists(full_path):
                    full_path = os.path.join(folder_paths.get_input_directory(), path)

                if not os.path.exists(full_path):
                    print(f"[MultiImageLoader] Warning: Image path not found: {path}")
                    continue

                image = Image.open(full_path)
                image = ImageOps.exif_transpose(image)
                image = image.convert("RGB")

                orig_w, orig_h = image.size
                target_w, target_h = width, height

                if target_w == 0 and target_h == 0:
                    target_w, target_h = orig_w, orig_h
                elif target_w == 0:
                    target_w = int(orig_w * (target_h / orig_h))
                elif target_h == 0:
                    target_h = int(orig_h * (target_w / orig_w))

                # Divisible by constraint
                target_w = (target_w // divisible_by) * divisible_by
                target_h = (target_h // divisible_by) * divisible_by

                # Ensure minimum 1-pixel dimensions after divisibility rounding
                target_w = max(target_w, divisible_by)
                target_h = max(target_h, divisible_by)

                # To prevent torch.cat errors, ALL images in the batch must match the dimensions
                # of the first successfully loaded image.
                if first_target_w is None:
                    first_target_w, first_target_h = target_w, target_h
                else:
                    target_w, target_h = first_target_w, first_target_h

                if target_w != orig_w or target_h != orig_h:
                    resample = _RESAMPLE_MAP.get(upscale_method, Image.LANCZOS)
                    image = image.resize((target_w, target_h), resample=resample)

                # Compression
                if img_compression > 0:
                    img_byte_arr = stdio.BytesIO()
                    image.save(
                        img_byte_arr,
                        format="JPEG",
                        quality=max(1, 100 - img_compression),
                    )
                    image = Image.open(img_byte_arr)

                image_np = np.array(image).astype(np.float32) / 255.0
                results.append(torch.from_numpy(image_np)[None,])
            except Exception as e:
                print(f"[MultiImageLoader] Error loading {path}: {e}")

        # Compute proper fallback dimensions based on user settings or first image
        if first_target_w is not None:
            fallback_w, fallback_h = first_target_w, first_target_h
        else:
            fallback_w = max((width or 512) // divisible_by, 1) * divisible_by
            fallback_h = max((height or 512) // divisible_by, 1) * divisible_by

        # Combine all successfully loaded images into a single batched tensor for multi_output
        if len(results) > 0:
            multi_output = torch.cat(results, dim=0)
        else:
            # Fallback empty tensor using proper dimensions
            multi_output = torch.zeros((1, fallback_h, fallback_w, 3))
            results = [multi_output]

        # Pad individual outputs to MAX_IMAGES using correct fallback dimensions
        fallback_tensor = torch.zeros((1, fallback_h, fallback_w, 3))
        padded_results = results + [fallback_tensor] * (MAX_IMAGES - len(results))

        # Pad captions to match image count
        padded_captions = caption_list + [""] * (len(valid_paths) - len(caption_list))
        captions_output = (
            "\n".join(padded_captions[: len(valid_paths)]) if valid_paths else ""
        )

        # Return: multi batch output, individual padded items, captions string
        return (multi_output, *padded_results[:MAX_IMAGES], captions_output)
