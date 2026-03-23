import { app } from "../../scripts/app.js";

/**
 * Shared module for LTXSequencer and LTXKeyframer dynamic widget management.
 * Eliminates code duplication between the two nodes, which differ only by class name.
 * 
 * Features:
 * - Dynamic widget creation/destruction based on upstream image count
 * - Cross-node sync of insert_frame and strength values
 * - Strict serialization array for reliable save/load
 * - Event-driven sync (no polling)
 * - Undo/redo for widget value changes
 */

const MAX_IMAGES = 50;

// ─── Cross-node sync ────────────────────────────────────────────────────────
// Finds all other nodes of the same class globally and mirrors a widget value
function syncWidgetAcrossNodes(sourceNode, widgetName, value, globalRegistry) {
    if (!globalRegistry) return;
    for (const targetNode of globalRegistry) {
        if (targetNode !== sourceNode) {
            targetNode.properties[widgetName] = value;
            if (targetNode.widgets) {
                const targetWidget = targetNode.widgets.find(w => w.name === widgetName);
                if (targetWidget && targetWidget.value !== value) {
                    targetWidget.value = value;
                    targetNode.setDirtyCanvas(true, false);
                }
            }
        }
    }
}

// ─── Upstream tracing ───────────────────────────────────────────────────────
// Reads image count from a connected MultiImageLoader node,
// tracing through Reroute and Group nodes.
function readSourceImageCount(self) {
    const multiInput = self.inputs?.find(inp => inp.name === "multi_input");
    if (!multiInput || !multiInput.link) return null;

    const nodeGraph = self.graph || app.graph;

    function traceUpstream(graph, linkId, visited = new Set()) {
        if (!linkId || visited.has(linkId)) return null;
        visited.add(linkId);

        const link = graph.links?.[linkId] ?? graph._links?.get?.(linkId);
        if (!link) return null;

        const originNode = graph.getNodeById(link.origin_id);
        if (!originNode) return null;

        if (originNode.comfyClass === "MultiImageLoader") {
            return originNode;
        }

        // Traverse Reroute nodes
        if (originNode.type === "Reroute" || originNode.comfyClass === "Reroute") {
            if (originNode.inputs && originNode.inputs.length > 0 && originNode.inputs[0].link) {
                return traceUpstream(graph, originNode.inputs[0].link, visited);
            }
        }

        // Traverse standard ComfyUI Group Nodes (subgraphs)
        if (typeof originNode.getInnerNode === "function") {
            try {
                const innerNode = originNode.getInnerNode(link.origin_slot);
                if (innerNode && innerNode.comfyClass === "MultiImageLoader") {
                    return innerNode;
                }
            } catch (e) {
                console.warn("[LTX Shared] Could not trace inner node:", e);
            }
        }

        return null;
    }

    let sourceNode = traceUpstream(nodeGraph, multiInput.link);

    function getCountFromNode(n) {
        if (typeof n._imageCount === "number") return n._imageCount;
        const pathsWidget = n.widgets?.find(w => w.name === "image_paths");
        if (pathsWidget) {
            return (pathsWidget.value || "").split('\n').map(p => p.trim()).filter(p => p.length > 0).length;
        }
        return null;
    }

    if (sourceNode) {
        return getCountFromNode(sourceNode);
    }

    // Fallback: If exactly ONE MultiImageLoader exists in the workspace, use it
    let multiImageLoaders = [];
    function findAllLoaders(nodes) {
        if (!nodes) return;
        for (let n of nodes) {
            if (n.comfyClass === "MultiImageLoader") {
                multiImageLoaders.push(n);
            }
            if (n.subgraph && n.subgraph._nodes) {
                findAllLoaders(n.subgraph._nodes);
            }
        }
    }
    if (app.graph && app.graph._nodes) {
        findAllLoaders(app.graph._nodes);
    }

    if (multiImageLoaders.length === 1) {
        return getCountFromNode(multiImageLoaders[0]);
    }

    return null;
}

// ─── Serialization helpers ──────────────────────────────────────────────────
// Validates a value is numeric, returning a safe fallback otherwise
function safeNumericValue(value, fallback) {
    if (value === undefined || value === null) return fallback;
    const num = Number(value);
    if (Number.isNaN(num) || !Number.isFinite(num)) {
        console.warn(`[LTX Shared] Invalid numeric value "${value}", using fallback ${fallback}`);
        return fallback;
    }
    return num;
}

// ─── Undo/redo helpers ──────────────────────────────────────────────────────
const UNDO_STACK_LIMIT = 50;

function pushUndoState(node) {
    if (!node._undoStack) node._undoStack = [];
    if (!node._redoStack) node._redoStack = [];

    // Snapshot current dynamic widget properties
    const snapshot = {};
    if (node.widgets) {
        node.widgets.forEach(w => {
            if (w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                snapshot[w.name] = w.value;
            }
        });
    }
    // Also include num_images
    snapshot["num_images"] = node.properties["num_images"];

    node._undoStack.push(snapshot);
    if (node._undoStack.length > UNDO_STACK_LIMIT) {
        node._undoStack.shift();
    }
    // Clear redo stack on new action
    node._redoStack = [];
}

function applySnapshot(node, snapshot) {
    if (!snapshot) return;
    for (const [key, value] of Object.entries(snapshot)) {
        node.properties[key] = value;
        if (node.widgets) {
            const w = node.widgets.find(ww => ww.name === key);
            if (w) w.value = value;
        }
    }
    node.setDirtyCanvas(true, true);
}

function undoAction(node) {
    if (!node._undoStack || node._undoStack.length === 0) return;

    // Save current state to redo stack
    const currentSnapshot = {};
    if (node.widgets) {
        node.widgets.forEach(w => {
            if (w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                currentSnapshot[w.name] = w.value;
            }
        });
    }
    currentSnapshot["num_images"] = node.properties["num_images"];
    if (!node._redoStack) node._redoStack = [];
    node._redoStack.push(currentSnapshot);

    const prevState = node._undoStack.pop();
    applySnapshot(node, prevState);
}

function redoAction(node) {
    if (!node._redoStack || node._redoStack.length === 0) return;

    // Save current state to undo stack
    const currentSnapshot = {};
    if (node.widgets) {
        node.widgets.forEach(w => {
            if (w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                currentSnapshot[w.name] = w.value;
            }
        });
    }
    currentSnapshot["num_images"] = node.properties["num_images"];
    if (!node._undoStack) node._undoStack = [];
    node._undoStack.push(currentSnapshot);

    const nextState = node._redoStack.pop();
    applySnapshot(node, nextState);
}


// ═══════════════════════════════════════════════════════════════════════════
// Main factory: registers the extension for a given node class
// ═══════════════════════════════════════════════════════════════════════════
export function registerLTXNode(nodeClassName, globalRegistryName) {
    // Initialize global registry for this node type
    window[globalRegistryName] = window[globalRegistryName] || new Set();

    app.registerExtension({
        name: `Comfy.${nodeClassName}.DynamicInputs`,

        async nodeCreated(node) {
            if (node.comfyClass !== nodeClassName) return;

            const globalRegistry = window[globalRegistryName];
            globalRegistry.add(node);

            node._currentImageCount = -1;
            node.properties = node.properties || {};
            node._undoStack = [];
            node._redoStack = [];

            // ── Separator widget above num_images ────────────────────────
            node.addCustomWidget({
                name: "num_images_separator",
                type: "text",
                draw(ctx, node, widget_width, y, widget_height) {
                    ctx.save();
                    ctx.strokeStyle = "#444";
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(10, y + 5);
                    ctx.lineTo(widget_width - 10, y + 5);
                    ctx.stroke();
                    ctx.restore();
                },
                computeSize(width) {
                    return [width, 10];
                }
            });

            const moveSeparator = () => {
                const idx = node.widgets.findIndex(w => w.name === "num_images");
                const sepIdx = node.widgets.findIndex(w => w.name === "num_images_separator");
                if (idx !== -1 && sepIdx !== -1) {
                    const separator = node.widgets.splice(sepIdx, 1)[0];
                    node.widgets.splice(idx, 0, separator);
                }
            };
            setTimeout(moveSeparator, 50);

            // ── Core: synchronize widget visibility to match count ───────
            node._applyWidgetCount = function(count) {
                const isInitialLoad = this._currentImageCount === -1;

                if (this._currentImageCount === count && !isInitialLoad) return;
                this._currentImageCount = count;

                const initialWidth = this.size[0];
                const numWidget = this.widgets?.find(w => w.name === "num_images");
                if (numWidget) {
                    numWidget.label = "images_loaded";
                    numWidget.value = Math.max(0, Math.min(count || 0, MAX_IMAGES));
                }

                // Save current widget values before removing
                if (!isInitialLoad && this.widgets) {
                    pushUndoState(this);
                    this.widgets.forEach(w => {
                        if (w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                            this.properties[w.name] = w.value;
                        }
                    });
                }

                // Remove all dynamic widgets
                if (this.widgets) {
                    this.widgets = this.widgets.filter(w =>
                        !w.name.startsWith("insert_frame_") &&
                        !w.name.startsWith("strength_") &&
                        !w.name.startsWith("header_")
                    );
                } else {
                    this.widgets = [];
                }

                // Add back exactly the right amount
                for (let i = 1; i <= count; i++) {
                    // Header widget
                    const headerName = `header_${i}`;
                    this.addCustomWidget({
                        name: headerName,
                        type: "text",
                        value: `Image #${i}`,
                        draw(ctx, node, widget_width, y, widget_height) {
                            ctx.save();
                            const margin = 10;
                            const topPadding = 15;
                            ctx.strokeStyle = "#333";
                            ctx.lineWidth = 1;
                            ctx.beginPath();
                            ctx.moveTo(margin, y + 5);
                            ctx.lineTo(widget_width - margin, y + 5);
                            ctx.stroke();
                            ctx.fillStyle = "#dddddd";
                            ctx.font = "bold 12px Arial";
                            ctx.textAlign = "left";
                            ctx.fillText(`Image #${i}`, margin, y + topPadding + 10);
                            ctx.restore();
                        },
                        computeSize(width) {
                            return [width, 35];
                        }
                    });

                    const insertFrameWidgetName = `insert_frame_${i}`;
                    const strengthWidgetName = `strength_${i}`;

                    // insert_frame widget with sync callback
                    const savedInsertFrameValue = this.properties[insertFrameWidgetName];
                    this.addWidget("number", insertFrameWidgetName,
                        safeNumericValue(savedInsertFrameValue, 0),
                        (value) => {
                            const rounded = Math.round(value);
                            this.properties[insertFrameWidgetName] = rounded;
                            syncWidgetAcrossNodes(this, insertFrameWidgetName, rounded, globalRegistry);
                        }, { min: -9999, max: 9999, step: 10, precision: 0 }
                    );

                    // strength widget with sync callback
                    const savedStrengthValue = this.properties[strengthWidgetName];
                    this.addWidget("number", strengthWidgetName,
                        safeNumericValue(savedStrengthValue, 1.0),
                        (value) => {
                            this.properties[strengthWidgetName] = value;
                            syncWidgetAcrossNodes(this, strengthWidgetName, value, globalRegistry);
                        }, { min: 0.0, max: 1.0, step: 0.01 }
                    );
                }

                this.setDirtyCanvas(true, true);
                requestAnimationFrame(() => {
                    if (this.computeSize) {
                        this.setSize(this.computeSize());
                        this.size[0] = initialWidth;
                    }
                });
            };

            // ── Strict array mapper on configure ────────────────────────
            const origConfigure = node.configure;
            node.configure = function(info) {
                if (origConfigure) {
                    origConfigure.apply(this, arguments);
                }
                if (this.widgets) {
                    this.widgets.forEach(w => {
                        if (w.name === "num_images" || w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                            this.properties[w.name] = w.value;
                        }
                    });
                }
            };

            // ── Deserialize: load properties from saved JSON ────────────
            const originalOnConfigure = node.onConfigure;
            node.onConfigure = function(info) {
                if (originalOnConfigure) {
                    originalOnConfigure.apply(this, arguments);
                }
                if (info.properties) {
                    this.properties = { ...this.properties, ...info.properties };
                }
                setTimeout(() => {
                    const count = readSourceImageCount(this);
                    let targetCount = count !== null ? count : (this.properties.num_images || 0);
                    this._applyWidgetCount(targetCount);
                }, 100);
            };

            // ── Serialize: build strict array with validation ───────────
            const originalOnSerialize = node.onSerialize;
            node.onSerialize = function(info) {
                try {
                    // Sync widget values to properties before building
                    if (this.widgets) {
                        this.widgets.forEach(w => {
                            if (w.name === "num_images" || w.name.startsWith("insert_frame_") || w.name.startsWith("strength_")) {
                                this.properties[w.name] = w.value;
                            }
                        });
                    }

                    if (originalOnSerialize) {
                        originalOnSerialize.apply(this, arguments);
                    }

                    info.properties = { ...this.properties };

                    // Build the exact strict array with type validation
                    const strictArray = [];
                    const numWidgetVal = this.properties["num_images"];
                    strictArray.push(safeNumericValue(numWidgetVal, 1));

                    for (let i = 1; i <= MAX_IMAGES; i++) {
                        const fVal = this.properties[`insert_frame_${i}`];
                        const sVal = this.properties[`strength_${i}`];
                        strictArray.push(safeNumericValue(fVal, 0));
                        strictArray.push(safeNumericValue(sVal, 1.0));
                    }

                    info.widgets_values = strictArray;
                } catch (e) {
                    console.error(`[${nodeClassName}] Serialization error:`, e);
                    // Don't corrupt — leave info unchanged on failure
                }
            };

            // ── Manual num_images widget callback ───────────────────────
            setTimeout(() => {
                const numWidget = node.widgets?.find(w => w.name === "num_images");
                if (numWidget) {
                    numWidget.callback = (val) => {
                        node.properties["num_images"] = val;
                        node._applyWidgetCount(val);
                    };
                }
            }, 100);

            // ── Push-based receiver ─────────────────────────────────────
            node._syncImageCount = function(count) {
                this._applyWidgetCount(count);
            };

            // ── Keyboard shortcuts: Ctrl+Z/Ctrl+Shift+Z ────────────────
            node._onKeyDown = function(e) {
                // Only respond if this node is selected
                if (!app.canvas?.selected_nodes) return;
                const selectedIds = Object.keys(app.canvas.selected_nodes);
                if (!selectedIds.includes(String(node.id))) return;

                if (e.ctrlKey && !e.shiftKey && e.key === "z") {
                    e.preventDefault();
                    e.stopPropagation();
                    undoAction(node);
                } else if (e.ctrlKey && e.shiftKey && e.key === "z") {
                    e.preventDefault();
                    e.stopPropagation();
                    redoAction(node);
                }
            };
            document.addEventListener("keydown", node._onKeyDown);

            // ── Cleanup on removal ──────────────────────────────────────
            const origOnRemoved = node.onRemoved;
            node.onRemoved = function() {
                globalRegistry.delete(node);
                if (node._onKeyDown) {
                    document.removeEventListener("keydown", node._onKeyDown);
                }
                if (origOnRemoved) origOnRemoved.apply(this, arguments);
            };

            // ── Connection change handler (event-driven, no polling) ────
            const onConnectionsChange = node.onConnectionsChange;
            node.onConnectionsChange = function(type, index, connected, link_info) {
                if (onConnectionsChange) onConnectionsChange.apply(this, arguments);

                if (type === 1) { // Input
                    const input = this.inputs[index];
                    if (input && input.name === "multi_input") {
                        if (connected) {
                            setTimeout(() => {
                                const count = readSourceImageCount(this);
                                this._applyWidgetCount(count !== null ? count : (this.properties.num_images || 0));
                            }, 100);
                        } else {
                            this._applyWidgetCount(0);
                        }
                    }
                }
            };

            // ── Graph change handler (picks up workflow loads) ──────────
            const origOnAfterGraphChange = node.onAfterGraphChange;
            node.onAfterGraphChange = function() {
                if (origOnAfterGraphChange) origOnAfterGraphChange.apply(this, arguments);
                setTimeout(() => {
                    const count = readSourceImageCount(this);
                    if (count !== null) {
                        this._applyWidgetCount(count);
                    }
                }, 200);
            };

            // ── Initial sync when first placed ──────────────────────────
            const origOnAdded = node.onAdded;
            node.onAdded = function() {
                if (origOnAdded) origOnAdded.apply(this, arguments);
                setTimeout(() => {
                    const count = readSourceImageCount(this);
                    this._applyWidgetCount(count !== null ? count : (this.properties.num_images || 0));
                }, 100);
            };
        }
    });
}
