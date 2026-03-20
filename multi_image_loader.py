import torch
import numpy as np
from PIL import Image, ImageOps
import os
import folder_paths
import io

class MultiImageLoader:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "image_paths": ("STRING", {"default": "", "multiline": True}),
                "width": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "height": ("INT", {"default": 0, "min": 0, "max": 8192, "step": 1}),
                "upscale_method": (["lanczos", "bilinear", "nearest-exact"],),
                "divisible_by": ("INT", {"default": 32, "min": 1, "max": 512, "step": 1}),
                "img_compression": ("INT", {"default": 18, "min": 0, "max": 100, "step": 1}),
            },
        }

    # Added "IMAGE" at the beginning for multi_output + 50 individual outputs = 51 outputs
    RETURN_TYPES = ("IMAGE",) * 51
    RETURN_NAMES = ("multi_output",) + tuple(f"image_{i+1}" for i in range(50))
    FUNCTION = "load_images"
    CATEGORY = "image"

    def load_images(self, image_paths, width, height, upscale_method, divisible_by, img_compression):
        results = []
        valid_paths = [p.strip() for p in image_paths.split("\n") if p.strip()]

        # Track the dimensions of the first processed image
        first_target_w, first_target_h = None, None

        for path in valid_paths:
            try:
                # Resolve full path
                full_path = path
                if not os.path.exists(full_path):
                    full_path = os.path.join(folder_paths.get_input_directory(), path)
                    
                if not os.path.exists(full_path):
                    print(f"Warning: Image path not found: {path}")
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
                
                # To prevent torch.cat errors, ALL images in the batch must match the dimensions 
                # of the first successfully loaded image.
                if first_target_w is None:
                    first_target_w, first_target_h = target_w, target_h
                else:
                    target_w, target_h = first_target_w, first_target_h

                if target_w != orig_w or target_h != orig_h:
                    resample = Image.LANCZOS if upscale_method == "lanczos" else Image.BILINEAR
                    image = image.resize((target_w, target_h), resample=resample)

                # Compression
                if img_compression > 0:
                    img_byte_arr = io.BytesIO()
                    image.save(img_byte_arr, format="JPEG", quality=max(1, 100 - img_compression))
                    image = Image.open(img_byte_arr)

                image_np = np.array(image).astype(np.float32) / 255.0
                results.append(torch.from_numpy(image_np)[None,])
            except Exception as e:
                print(f"Error loading {path}: {e}")

        # Combine all successfully loaded images into a single batched tensor for multi_output
        if len(results) > 0:
            multi_output = torch.cat(results, dim=0)
        else:
            # Fallback empty tensor if no valid paths
            multi_output = torch.zeros((1, 64, 64, 3))
            results = [multi_output]

        # Pad individual outputs exactly to length 50 as defined in RETURN_TYPES
        padded_results = results + [torch.zeros((1, 64, 64, 3))] * (50 - len(results))

        # Return the multi batch output first, followed by the individual padded items
        return (multi_output, *padded_results[:50])