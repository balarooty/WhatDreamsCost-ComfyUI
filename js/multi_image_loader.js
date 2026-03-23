import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const UNDO_LIMIT = 30;

app.registerExtension({
    name: "Comfy.MultiImageLoader",
    async nodeCreated(node) {
        if (node.comfyClass !== "MultiImageLoader") return;

        // ── Undo/Redo stacks ────────────────────────────────────────
        const undoStack = [];
        const redoStack = [];

        function pushUndo(pathsArray) {
            undoStack.push([...pathsArray]);
            if (undoStack.length > UNDO_LIMIT) undoStack.shift();
            redoStack.length = 0;
        }

        function undoGallery() {
            if (undoStack.length === 0) return;
            const currentPaths = getCurrentPaths();
            redoStack.push([...currentPaths]);
            const prevPaths = undoStack.pop();
            setWidgetValue(prevPaths, false, true); // skipUndo = true
        }

        function redoGallery() {
            if (redoStack.length === 0) return;
            const currentPaths = getCurrentPaths();
            undoStack.push([...currentPaths]);
            const nextPaths = redoStack.pop();
            setWidgetValue(nextPaths, false, true);
        }

        function getCurrentPaths() {
            return (pathsWidget.value || "").split(/\n|,/).map(s => s.trim()).filter(s => s);
        }

        // ── 1. UI Setup ─────────────────────────────────────────────
        const container = document.createElement("div");
        container.style.cssText = `
            width: 100%;
            background: #222222;
            border: 1px solid #353545;
            border-radius: 4px;
            margin-top: 5px;
            padding: 10px;
            box-sizing: border-box;
            display: flex;
            flex-direction: column;
            gap: 10px;
            pointer-events: auto;
            overflow: hidden;
        `;

        // Top Bar
        const topBar = document.createElement("div");
        topBar.style.cssText = "display: flex; justify-content: flex-start; align-items: center; width: 100%; gap: 8px; flex-wrap: wrap;";

        const btnStyle = `
            background: #3a3f4b; color: white; border: 1px solid #5a5f6b;
            padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
        `;

        const uploadBtn = document.createElement("button");
        uploadBtn.innerText = "Upload Images";
        uploadBtn.style.cssText = btnStyle;

        const folderBtn = document.createElement("button");
        folderBtn.innerText = "Browse Folder";
        folderBtn.style.cssText = btnStyle;

        const removeAllBtn = document.createElement("button");
        removeAllBtn.innerText = "Remove All";
        removeAllBtn.style.cssText = `
            background: #cc2222; color: white; border: 1px solid #aa1111;
            padding: 3px 8px; border-radius: 3px; cursor: pointer; font-size: 10px;
            transition: background 0.2s;
        `;
        removeAllBtn.onmouseenter = () => { removeAllBtn.style.background = "#ff3333"; };
        removeAllBtn.onmouseleave = () => { removeAllBtn.style.background = "#cc2222"; };
        removeAllBtn.onclick = () => {
            pushUndo(getCurrentPaths());
            setWidgetValue([], false);
        };

        topBar.appendChild(uploadBtn);
        topBar.appendChild(folderBtn);
        topBar.appendChild(removeAllBtn);
        container.appendChild(topBar);

        // Folder dropdown (initially hidden)
        const folderDropdown = document.createElement("select");
        folderDropdown.style.cssText = `
            display: none; width: 100%; background: #2a2f3b; color: white;
            border: 1px solid #5a5f6b; padding: 4px 6px; border-radius: 3px;
            font-size: 10px; cursor: pointer;
        `;
        container.appendChild(folderDropdown);

        // Grid
        const grid = document.createElement("div");
        grid.style.cssText = `
            position: relative;
            flex-grow: 1;
            display: grid;
            gap: 8px;
            width: 100%;
            justify-content: center;
            align-content: center;
        `;
        container.appendChild(grid);

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.multiple = true;
        fileInput.accept = "image/*";
        fileInput.style.display = "none";
        container.appendChild(fileInput);

        // Add DOM widget
        const galleryWidget = node.addDOMWidget("Gallery", "html_gallery", container, { serialize: false });
        galleryWidget.computeSize = () => [0, 0];

        // Find the paths widget and hide it
        const pathsWidget = node.widgets.find(w => w.name === "image_paths");
        if (pathsWidget) {
            pathsWidget.type = "hidden";
            if (pathsWidget.element) pathsWidget.element.style.display = "none";
        }

        const oldCallback = pathsWidget.callback;

        // Centralized setter
        function setWidgetValue(newPathsArray, isRearranging = false, skipUndo = false) {
            if (!skipUndo) {
                pushUndo(getCurrentPaths());
            }
            const val = newPathsArray.join("\n");
            const tempCallback = pathsWidget.callback;
            pathsWidget.callback = null;
            pathsWidget.value = val;
            if (oldCallback) oldCallback.apply(pathsWidget, [val]);
            pathsWidget.callback = tempCallback;
            refreshGallery(isRearranging);
        }

        // ── 2. Output syncing & layout ──────────────────────────────
        function syncOutputs(count) {
            if (!node.outputs) return;
            let changed = false;
            const targetTotal = count + 1;

            while (node.outputs.length > targetTotal && node.outputs.length > 1) {
                node.removeOutput(node.outputs.length - 1);
                changed = true;
            }

            for (let i = node.outputs.length; i < targetTotal; i++) {
                node.addOutput(`image_${i}`, "IMAGE");
                changed = true;
            }

            if (changed) updateLayout();
        }

        function notifyConnectedNodes(imageCount) {
            if (!node.outputs) return;
            for (const output of node.outputs) {
                if (!output.links) continue;
                for (const linkId of output.links) {
                    const linkMap = app.graph.links;
                    const link = linkMap?.[linkId] ?? linkMap?.get?.(linkId);
                    if (!link) continue;
                    const targetNode = app.graph.getNodeById(link.target_id);
                    if (targetNode && typeof targetNode._syncImageCount === "function") {
                        targetNode._syncImageCount(imageCount);
                    }
                }
            }
        }

        function optimizeGrid(nodeW, containerH) {
            const paths = getCurrentPaths();
            const N = paths.length;

            if (N === 0) {
                grid.style.gridTemplateColumns = 'repeat(auto-fit, minmax(75px, 1fr))';
                grid.style.gridAutoRows = 'max-content';
                return;
            }

            const gridW = nodeW - 22;
            const gridH = containerH - 60;
            if (gridW <= 0 || gridH <= 0) return;

            let bestS = 0;
            let bestCols = 1;

            for (let c = 1; c <= N; c++) {
                const r = Math.ceil(N / c);
                const maxW = (gridW - (c - 1) * 8) / c;
                const maxH = (gridH - (r - 1) * 8) / r;
                const size = Math.min(maxW, maxH);
                if (size > bestS) {
                    bestS = size;
                    bestCols = c;
                }
            }

            bestS = Math.max(75, Math.floor(bestS));
            grid.style.gridTemplateColumns = `repeat(${bestCols}, ${bestS}px)`;
            grid.style.gridAutoRows = `${bestS}px`;
        }

        function getGalleryHeights() {
            const baseHeight = node.computeSize()[1];
            const oldHeight = container.style.height;
            const oldCols = grid.style.gridTemplateColumns;
            const oldRows = grid.style.gridAutoRows;

            container.style.height = 'fit-content';
            grid.style.gridTemplateColumns = `repeat(auto-fit, minmax(75px, 1fr))`;
            grid.style.gridAutoRows = `max-content`;

            const naturalGalleryHeight = container.offsetHeight || 100;
            const minNodeHeight = baseHeight + naturalGalleryHeight + 15;

            container.style.height = oldHeight;
            grid.style.gridTemplateColumns = oldCols;
            grid.style.gridAutoRows = oldRows;

            return { baseHeight, minNodeHeight };
        }

        let isLayouting = false;
        let isFirstLayout = true;
        function updateLayout(forceHeight = null) {
            if (isLayouting) return;
            isLayouting = true;

            const { baseHeight, minNodeHeight } = getGalleryHeights();
            let targetW = Math.max(node.size[0], 240);
            let targetH = forceHeight !== null ? forceHeight : node.size[1];

            if (isFirstLayout) {
                targetH = 0;
                isFirstLayout = false;
            }

            targetH = Math.max(targetH, minNodeHeight);

            if (node.size[0] !== targetW || node.size[1] !== targetH) {
                node.setSize([targetW, targetH]);
                app.graph.setDirtyCanvas(true, true);
            }

            const availableGalleryHeight = targetH - baseHeight - 15;
            container.style.height = availableGalleryHeight + "px";
            optimizeGrid(targetW, availableGalleryHeight);
            isLayouting = false;
        }

        const origOnResize = node.onResize;
        node.onResize = function(size) {
            if (origOnResize) origOnResize.call(this, size);
            if (isLayouting) return;

            const { baseHeight, minNodeHeight } = getGalleryHeights();
            size[0] = Math.max(size[0], 240);
            size[1] = Math.max(size[1], minNodeHeight);

            const availableGalleryHeight = size[1] - baseHeight - 15;
            container.style.height = availableGalleryHeight + "px";
            optimizeGrid(size[0], availableGalleryHeight);
        };

        let lastWidth = -1;
        let lastHeight = -1;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const currentWidth = entry.contentRect.width;
                const currentHeight = entry.contentRect.height;
                if ((lastWidth !== -1 && Math.abs(currentWidth - lastWidth) > 2) ||
                    (lastHeight !== -1 && Math.abs(currentHeight - lastHeight) > 2)) {
                    requestAnimationFrame(() => updateLayout());
                }
                lastWidth = currentWidth;
                lastHeight = currentHeight;
            }
        });
        resizeObserver.observe(container);

        // ── 3. Gallery rendering with lazy loading ──────────────────
        let draggedNode = null;
        let lastSwapX = 0;
        let lastSwapY = 0;
        let lastSwapTime = 0;

        // Lazy loading observer
        const lazyObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        delete img.dataset.src;
                        lazyObserver.unobserve(img);
                    }
                }
            });
        }, { root: grid, rootMargin: "100px" });

        function refreshGallery(isRearranging = false) {
            grid.innerHTML = "";
            const paths = getCurrentPaths();

            if (!isRearranging) {
                syncOutputs(paths.length);
            }
            node._imageCount = paths.length;
            notifyConnectedNodes(paths.length);

            paths.forEach((path, index) => {
                const item = document.createElement("div");
                item.dataset.path = path;
                item.draggable = true;
                item.style.cssText = `
                    position: relative;
                    width: 100%;
                    height: 100%;
                    aspect-ratio: 1 / 1;
                    background: #000000;
                    border-radius: 4px;
                    border: 1px solid #444;
                    overflow: hidden;
                    cursor: grab;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    will-change: transform;
                `;

                // Lazy-loaded image
                const img = document.createElement("img");
                const imgSrc = `/api/view?filename=${encodeURIComponent(path)}&type=input`;
                img.dataset.src = imgSrc; // Lazy load
                img.style.cssText = "max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: none; display: block;";
                img.alt = `Image ${index + 1}`;
                lazyObserver.observe(img);

                // Delete button
                const del = document.createElement("div");
                del.style.cssText = `
                    position: absolute; top: 0; right: 0;
                    background: #cc2222; color: white;
                    width: 18px; height: 18px;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 14px; cursor: pointer; z-index: 10;
                    font-family: Arial, sans-serif; font-weight: bold;
                    line-height: 1; border-bottom-left-radius: 4px;
                    transition: background 0.2s;
                `;
                del.innerHTML = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1L9 9M9 1L1 9" stroke="white" stroke-width="2" stroke-linecap="round"/>
                </svg>`;

                del.onmouseenter = () => { del.style.background = "#ff3333"; };
                del.onmouseleave = () => { del.style.background = "#cc2222"; };
                del.onclick = (e) => {
                    e.stopPropagation();
                    const newPaths = paths.filter((_, i) => i !== index);
                    setWidgetValue(newPaths, false);
                };

                // Number badge
                const numBadge = document.createElement("div");
                numBadge.style.cssText = `
                    position: absolute; bottom: 0; left: 0;
                    background: rgba(0, 0, 0, 0.75); color: #fff;
                    padding: 2px 6px; font-size: 11px; font-family: sans-serif;
                    font-weight: bold; border-top-right-radius: 4px; pointer-events: none;
                    z-index: 5;
                `;
                numBadge.innerText = (index + 1).toString();

                // Drag & drop events
                item.ondragstart = (e) => {
                    draggedNode = item;
                    setTimeout(() => {
                        if (draggedNode === item) {
                            item.style.opacity = "0.4";
                            item.style.pointerEvents = "none";
                        }
                    }, 0);
                    e.dataTransfer.effectAllowed = "move";
                };

                item.ondragend = () => {
                    if (draggedNode) {
                        draggedNode.style.opacity = "1";
                        draggedNode.style.pointerEvents = "auto";
                    }
                    draggedNode = null;

                    const newPaths = Array.from(grid.children).map(n => n.dataset.path);
                    const currentVal = (pathsWidget.value || "").trim();
                    if (newPaths.join("\n") !== currentVal) {
                        setWidgetValue(newPaths, true);
                    }
                };

                item.ondragover = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!draggedNode || draggedNode === item) return;

                    const distMoved = Math.hypot(e.clientX - lastSwapX, e.clientY - lastSwapY);
                    if (Date.now() - lastSwapTime < 50 && distMoved < 5) return;

                    const gridRect = grid.getBoundingClientRect();
                    const mouseX = e.clientX - gridRect.left;
                    const mouseY = e.clientY - gridRect.top;

                    const left = item.offsetLeft;
                    const top = item.offsetTop;
                    const width = item.offsetWidth;
                    const height = item.offsetHeight;

                    const bufferX = width * 0.10;
                    const bufferY = height * 0.10;

                    if (mouseX < left + bufferX || mouseX > left + width - bufferX ||
                        mouseY < top + bufferY || mouseY > top + height - bufferY) {
                        return;
                    }

                    const items = Array.from(grid.children);
                    const draggedIdx = items.indexOf(draggedNode);
                    const targetIdx = items.indexOf(item);

                    // FLIP Animation
                    const rects = new Map();
                    items.forEach(node => rects.set(node, node.getBoundingClientRect()));

                    if (draggedIdx < targetIdx) {
                        grid.insertBefore(draggedNode, item.nextSibling);
                    } else {
                        grid.insertBefore(draggedNode, item);
                    }

                    items.forEach(node => {
                        const oldRect = rects.get(node);
                        const newRect = node.getBoundingClientRect();
                        const dx = oldRect.left - newRect.left;
                        const dy = oldRect.top - newRect.top;

                        if (dx !== 0 || dy !== 0) {
                            node.style.transition = 'none';
                            node.style.transform = `translate(${dx}px, ${dy}px)`;
                            node.offsetWidth; // Force reflow
                            node.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
                            node.style.transform = '';
                        }
                    });

                    lastSwapX = e.clientX;
                    lastSwapY = e.clientY;
                    lastSwapTime = Date.now();
                };

                item.ondrop = (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                };

                item.appendChild(img);
                item.appendChild(del);
                item.appendChild(numBadge);
                grid.appendChild(item);
            });

            if (!isRearranging) {
                requestAnimationFrame(() => updateLayout());
            }
        }

        // ── 4. File handling ────────────────────────────────────────
        async function handleFiles(files) {
            const uploaded = [];
            for (const file of files) {
                const body = new FormData();
                body.append("image", file);
                try {
                    const resp = await api.fetchApi("/upload/image", { method: "POST", body });
                    if (resp.status === 200) {
                        const data = await resp.json();
                        let name = data.name;
                        if (data.subfolder) name = data.subfolder + "/" + name;
                        uploaded.push(name);
                    }
                } catch (e) { console.error("Upload error", e); }
            }
            if (uploaded.length > 0) {
                const current = (pathsWidget.value || "").trim();
                const allPaths = current ? current.split('\n').concat(uploaded) : uploaded;
                setWidgetValue(allPaths, false);
            }
        }

        uploadBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => handleFiles(e.target.files);

        // ── 5. Folder browsing ──────────────────────────────────────
        folderBtn.onclick = async () => {
            const isVisible = folderDropdown.style.display !== "none";
            if (isVisible) {
                folderDropdown.style.display = "none";
                return;
            }

            // Fetch available folders from the Python backend API
            try {
                const resp = await api.fetchApi("/multi_image_loader/list_folders");
                if (resp.status === 200) {
                    const data = await resp.json();
                    const folders = data.folders || [];

                    folderDropdown.innerHTML = "";

                    const defaultOpt = document.createElement("option");
                    defaultOpt.value = "";
                    defaultOpt.innerText = "-- Select folder to import --";
                    defaultOpt.disabled = true;
                    defaultOpt.selected = true;
                    folderDropdown.appendChild(defaultOpt);

                    for (const folder of folders) {
                        const opt = document.createElement("option");
                        opt.value = folder;
                        opt.innerText = folder;
                        folderDropdown.appendChild(opt);
                    }

                    folderDropdown.style.display = "block";
                } else {
                    console.warn("[MultiImageLoader] Folder list API returned status:", resp.status);
                }
            } catch (e) {
                console.error("[MultiImageLoader] Failed to fetch folder list:", e);
            }
        };

        folderDropdown.onchange = async () => {
            const selectedFolder = folderDropdown.value;
            if (!selectedFolder) return;

            try {
                const resp = await api.fetchApi(`/multi_image_loader/scan_folder?folder=${encodeURIComponent(selectedFolder)}`);
                if (resp.status === 200) {
                    const data = await resp.json();
                    const images = data.images || [];

                    if (images.length > 0) {
                        const current = (pathsWidget.value || "").trim();
                        const allPaths = current ? current.split('\n').concat(images) : images;
                        setWidgetValue(allPaths, false);
                    }
                }
            } catch (e) {
                console.error("[MultiImageLoader] Failed to scan folder:", e);
            }

            folderDropdown.style.display = "none";
        };

        // ── 6. Drop zone ────────────────────────────────────────────
        container.ondragover = (e) => {
            e.preventDefault();
            e.stopPropagation();
            container.style.borderColor = "#4CAF50";
        };
        container.ondragleave = (e) => {
            e.preventDefault();
            e.stopPropagation();
            container.style.borderColor = "#353545";
        };
        container.ondrop = (e) => {
            e.preventDefault();
            e.stopPropagation();
            container.style.borderColor = "#353545";
            if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        };

        // ── 7. Paste handling ───────────────────────────────────────
        const pasteHandler = (e) => {
            if (app.canvas.selected_nodes && app.canvas.selected_nodes[node.id]) {
                const items = e.clipboardData?.items;
                if (!items) return;

                const files = [];
                for (let i = 0; i < items.length; i++) {
                    if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
                        files.push(items[i].getAsFile());
                    }
                }

                if (files.length > 0) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    handleFiles(files);
                }
            }
        };
        document.addEventListener("paste", pasteHandler, { capture: true });

        // ── 8. Keyboard shortcuts (undo/redo) ───────────────────────
        const keyHandler = (e) => {
            if (!app.canvas?.selected_nodes?.[node.id]) return;

            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
                e.preventDefault();
                e.stopPropagation();
                undoGallery();
            } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "z" || e.key === "Z")) {
                e.preventDefault();
                e.stopPropagation();
                redoGallery();
            }
        };
        document.addEventListener("keydown", keyHandler);

        // ── 9. Cleanup ──────────────────────────────────────────────
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function() {
            document.removeEventListener("paste", pasteHandler, { capture: true });
            document.removeEventListener("keydown", keyHandler);
            resizeObserver.disconnect();
            lazyObserver.disconnect();
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };

        // External state load callback
        pathsWidget.callback = (v) => {
            if (oldCallback) oldCallback.apply(pathsWidget, [v]);
            refreshGallery();
        };

        setTimeout(() => refreshGallery(), 100);
    }
});