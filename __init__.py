from .ltx_keyframer import LTXKeyframer
from .multi_image_loader import MultiImageLoader, _list_input_subfolders, _scan_folder_for_images, _IMAGE_EXTENSIONS
from .ltx_sequencer import LTXSequencer

import os
import folder_paths
from aiohttp import web

# Register the node classes
NODE_CLASS_MAPPINGS = {
    "LTXKeyframer": LTXKeyframer,
    "MultiImageLoader": MultiImageLoader,
    "LTXSequencer": LTXSequencer
}

# Provide clean display names for the ComfyUI interface
NODE_DISPLAY_NAME_MAPPINGS = {
    "LTXKeyframer": "LTX Keyframer",
    "MultiImageLoader": "Multi Image Loader",
    "LTXSequencer": "LTX Sequencer"
}

WEB_DIRECTORY = "./js"

# ── API Routes for folder browsing from the MultiImageLoader JS frontend ──
try:
    from server import PromptServer

    @PromptServer.instance.routes.get("/multi_image_loader/list_folders")
    async def list_folders(request):
        """Return list of subdirectory names inside ComfyUI's input directory."""
        folders = _list_input_subfolders()
        # Remove the "(none)" placeholder used by the combo widget
        folders = [f for f in folders if f != "(none)"]
        return web.json_response({"folders": folders})

    @PromptServer.instance.routes.get("/multi_image_loader/scan_folder")
    async def scan_folder(request):
        """Return list of image filenames inside a specific input subfolder."""
        folder_name = request.query.get("folder", "")
        if not folder_name:
            return web.json_response({"images": [], "error": "No folder specified"}, status=400)

        input_dir = folder_paths.get_input_directory()
        folder_path = os.path.join(input_dir, folder_name)

        # Security: prevent path traversal
        real_input = os.path.realpath(input_dir)
        real_folder = os.path.realpath(folder_path)
        if not real_folder.startswith(real_input):
            return web.json_response({"images": [], "error": "Invalid folder path"}, status=403)

        image_files = _scan_folder_for_images(folder_path)
        # Return relative paths (subfolder/filename) for the widget value
        relative = [
            os.path.join(folder_name, os.path.basename(f))
            for f in image_files
        ]
        return web.json_response({"images": relative})

except ImportError:
    # PromptServer not available (e.g., running tests outside ComfyUI)
    pass

__all__ = ['NODE_CLASS_MAPPINGS', 'NODE_DISPLAY_NAME_MAPPINGS', 'WEB_DIRECTORY']