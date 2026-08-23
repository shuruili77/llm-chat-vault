/**
 * File handler for drag & drop and zip file extraction
 */

import { parseConversations } from '../parsers.js';

export class FileHandler {
    constructor() {
        this.overlay = document.getElementById('drop-zone-overlay');
        this.fileInput = document.getElementById('file-input');
        this.uploadBtn = document.getElementById('upload-btn');
        this.urlInput = document.getElementById('url-input');
        this.urlLoadBtn = document.getElementById('url-load-btn');
        this.closeBtn = document.getElementById('drop-zone-close-btn');
        this.dragCounter = 0;
        this.setupEventListeners();
    }

    setupEventListeners() {
        // Prevent default drag behaviors on entire document
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            document.addEventListener(eventName, (e) => this.preventDefaults(e), false);
        });

        // Show overlay ONLY when actual files are dragged over the document
        document.addEventListener('dragenter', (e) => {
            if (!this.isFilesDrag(e)) return;
            this.dragCounter++;
            this.showOverlay();
        }, false);

        document.addEventListener('dragover', (e) => {
            if (!this.isFilesDrag(e)) return;
            this.preventDefaults(e);
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'copy';
            }
        }, false);

        // Hide overlay when leaving window
        document.addEventListener('dragleave', (e) => {
            if (!this.isFilesDrag(e)) return;
            this.dragCounter--;
            if (this.dragCounter <= 0) {
                this.hideOverlay();
            }
        }, false);

        // Handle dropped files
        document.addEventListener('drop', (e) => {
            this.preventDefaults(e);
            const isFiles = this.isFilesDrag(e);
            this.hideOverlay();
            if (isFiles) {
                this.handleDrop(e);
            }
        }, false);

        // ESC key to dismiss overlay (use capturing phase on window so nothing blocks it)
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27) {
                if (this.overlay && this.overlay.classList.contains('active')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.hideOverlay();
                }
            }
        }, true);

        // Click anywhere on overlay to dismiss
        if (this.overlay) {
            this.overlay.addEventListener('click', () => {
                this.hideOverlay();
            });
        }

        // Handle upload button click
        if (this.uploadBtn) {
            this.uploadBtn.addEventListener('click', async () => {
                if (window.electronAPI && typeof window.electronAPI.selectArchivePath === 'function') {
                    try {
                        const chosenPath = await window.electronAPI.selectArchivePath();
                        if (chosenPath) {
                            const name = chosenPath.split(/[\\/]/).pop() || 'archive';
                            const fakeFile = { path: chosenPath, name };
                            const event = new CustomEvent('conversations-loaded', {
                                detail: { conversations: [], source: name, file: fakeFile }
                            });
                            document.dispatchEvent(event);
                            return;
                        }
                    } catch (err) {
                        console.warn('Native open dialog failed, falling back to file input:', err);
                    }
                }
                this.fileInput.click();
            });
        }

        // Handle file input change
        if (this.fileInput) {
            this.fileInput.addEventListener('change', (e) => {
                const files = e.target.files;
                if (files.length > 0) {
                    this.handleFileSelect(files[0]);
                    // Reset input so same file can be selected again
                    this.fileInput.value = '';
                }
            });
        }

        // Handle URL load button click
        if (this.urlLoadBtn) {
            this.urlLoadBtn.addEventListener('click', () => {
                this.handleUrlLoad();
            });
        }

        // Handle Enter key in URL input
        if (this.urlInput) {
            this.urlInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.handleUrlLoad();
                }
            });
        }
    }

    /**
     * Check if drag event involves external files (and not internal text selection)
     */
    isFilesDrag(e) {
        if (!e || !e.dataTransfer) return false;
        const types = Array.from(e.dataTransfer.types || []);
        return types.includes('Files');
    }

    preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    showOverlay() {
        if (this.overlay) {
            this.overlay.classList.add('active');
        }
    }

    hideOverlay() {
        this.dragCounter = 0;
        if (this.overlay) {
            this.overlay.classList.remove('active');
        }
    }

    async handleDrop(e) {
        const files = e.dataTransfer.files;

        if (files.length === 0) {
            return;
        }

        const file = files[0];
        let filePath = file.path;
        if (!filePath && window.electronAPI && typeof window.electronAPI.getPathForFile === 'function') {
            try {
                filePath = window.electronAPI.getPathForFile(file);
            } catch {}
        }

        if (filePath) {
            const name = file.name || filePath.split(/[\\/]/).pop() || 'archive';
            const fakeFile = { path: filePath, name };
            const event = new CustomEvent('conversations-loaded', {
                detail: { conversations: [], source: name, file: fakeFile }
            });
            document.dispatchEvent(event);
            return;
        }

        await this.processFile(file);
    }

    async handleFileSelect(file) {
        await this.processFile(file);
    }

    async processFile(file) {
        try {
            let filePath = file.path;
            if (!filePath && window.electronAPI && typeof window.electronAPI.getPathForFile === 'function') {
                try {
                    filePath = window.electronAPI.getPathForFile(file);
                } catch {}
            }

            // Fast path: In Electron / Chromium with file.path, bypass client-side JSZip buffer
            if (filePath) {
                const name = file.name || filePath.split(/[\\/]/).pop() || 'archive';
                const fakeFile = { path: filePath, name };
                const event = new CustomEvent('conversations-loaded', {
                    detail: { conversations: [], source: name, file: fakeFile }
                });
                document.dispatchEvent(event);
                return;
            }

            if (file.name.endsWith('.json')) {
                await this.handleJSONFile(file);
            } else if (file.name.endsWith('.zip')) {
                await this.handleZipFile(file);
            } else {
                this.showError('Unsupported file type. Please select a .json or .zip file.');
            }
        } catch (error) {
            this.showError(`Error processing file: ${error.message}`);
        }
    }

    async handleJSONFile(file) {
        const text = await file.text();
        const data = JSON.parse(text);
        const conversations = parseConversations(data);

        // Emit custom event with parsed conversations and file payload
        const event = new CustomEvent('conversations-loaded', {
            detail: { conversations, source: file.name, file }
        });
        document.dispatchEvent(event);

        this.showSuccess(`Loaded ${conversations.length} conversation(s) from ${file.name}`);
    }

    async handleZipFile(file) {
        const arrayBuffer = await file.arrayBuffer();
        const zip = await JSZip.loadAsync(arrayBuffer);

        // Find single conversations.json or chat_history.json anywhere in the ZIP archive
        let matches = zip.file(/(^|\/)(conversations|chat_history)\.json$/i);

        // If not found, look for chunked conversations-*.json files
        if (!matches || matches.length === 0) {
            matches = zip.file(/(^|\/)conversations-\d+\.json$/i);
        }

        if (!matches || matches.length === 0) {
            throw new Error('conversations.json or chunked conversations-*.json not found in ZIP file');
        }

        // Sort matches to ensure sequential chunk order
        matches.sort((a, b) => a.name.localeCompare(b.name));

        let combinedData = [];
        for (const fileMatch of matches) {
            const text = await fileMatch.async('text');
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
                combinedData.push(...data);
            } else if (data && data.mapping) {
                combinedData.push(data);
            }
        }

        const conversations = parseConversations(combinedData);

        // Emit custom event with parsed conversations and file payload
        const event = new CustomEvent('conversations-loaded', {
            detail: { conversations, source: file.name, file }
        });
        document.dispatchEvent(event);

        this.showSuccess(`Loaded ${conversations.length} conversation(s) from ${file.name}`);
    }

    showError(message) {
        this.showToast(message, 'danger');
    }

    showSuccess(message) {
        this.showToast(message, 'success');
    }

    showToast(message, type = 'info') {
        // Create toast container if it doesn't exist
        let toastContainer = document.getElementById('toast-container');
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.id = 'toast-container';
            toastContainer.className = 'toast-container position-fixed top-0 end-0 p-3';
            toastContainer.style.zIndex = '9999';
            document.body.appendChild(toastContainer);
        }

        // Create toast element
        const toastId = `toast-${Date.now()}`;
        const toast = document.createElement('div');
        toast.className = `toast align-items-center text-bg-${type} border-0`;
        toast.setAttribute('role', 'alert');
        toast.setAttribute('aria-live', 'assertive');
        toast.setAttribute('aria-atomic', 'true');
        toast.id = toastId;

        toast.innerHTML = `
            <div class="d-flex">
                <div class="toast-body">
                    ${message}
                </div>
                <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
            </div>
        `;

        toastContainer.appendChild(toast);

        // Show toast using Bootstrap
        const bsToast = new bootstrap.Toast(toast, { autohide: true, delay: 5000 });
        bsToast.show();

        // Remove from DOM after hidden
        toast.addEventListener('hidden.bs.toast', () => {
            toast.remove();
        });
    }

    async handleUrlLoad() {
        const url = this.urlInput.value.trim();

        if (!url) {
            this.showError('Please enter a URL');
            return;
        }

        try {
            this.showToast('Loading from URL...', 'info');

            // Fetch the file from URL
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const contentType = response.headers.get('content-type');
            const blob = await response.blob();

            // Determine file type from URL or content-type
            let fileName = url.split('/').pop() || 'download';

            if (contentType?.includes('application/json') || url.endsWith('.json')) {
                fileName = fileName.endsWith('.json') ? fileName : 'conversations.json';
                await this.processUrlFile(blob, fileName, 'json');
            } else if (contentType?.includes('application/zip') || url.endsWith('.zip')) {
                fileName = fileName.endsWith('.zip') ? fileName : 'conversations.zip';
                await this.processUrlFile(blob, fileName, 'zip');
            } else {
                // Try to guess from the blob
                const text = await blob.text();
                try {
                    JSON.parse(text);
                    await this.processUrlFile(blob, 'conversations.json', 'json');
                } catch {
                    throw new Error('Unable to determine file type. URL must point to a .json or .zip file.');
                }
            }
        } catch (error) {
            this.showError(`Error loading from URL: ${error.message}`);
        }
    }

    async processUrlFile(blob, fileName, type) {
        try {
            const fileObj = new File([blob], fileName, { type: blob.type || (type === 'zip' ? 'application/zip' : 'application/json') });

            if (type === 'json') {
                const text = await blob.text();
                const data = JSON.parse(text);
                const conversations = parseConversations(data);

                // Emit custom event with parsed conversations, file, and fromUrl flag
                const event = new CustomEvent('conversations-loaded', {
                    detail: {
                        conversations,
                        source: fileName,
                        fromUrl: true,
                        file: fileObj
                    }
                });
                document.dispatchEvent(event);

                this.showSuccess(`Loaded ${conversations.length} conversation(s) from URL`);
            } else if (type === 'zip') {
                const arrayBuffer = await blob.arrayBuffer();
                const zip = await JSZip.loadAsync(arrayBuffer);

                // Find conversations.json, chat_history.json, or chunked conversations-*.json in ZIP archive
                let matches = zip.file(/(^|\/)(conversations|chat_history)\.json$/i);
                if (!matches || matches.length === 0) {
                    matches = zip.file(/(^|\/)conversations-\d+\.json$/i);
                }

                if (!matches || matches.length === 0) {
                    throw new Error('conversations.json or conversations-*.json not found in ZIP file');
                }

                matches.sort((a, b) => a.name.localeCompare(b.name));

                let combinedData = [];
                for (const fileMatch of matches) {
                    const text = await fileMatch.async('text');
                    const data = JSON.parse(text);
                    if (Array.isArray(data)) {
                        combinedData.push(...data);
                    } else if (data && typeof data === 'object') {
                        combinedData.push(data);
                    }
                }

                const conversations = parseConversations(combinedData);

                // Emit custom event with parsed conversations, file, and fromUrl flag
                const event = new CustomEvent('conversations-loaded', {
                    detail: {
                        conversations,
                        source: fileName,
                        fromUrl: true,
                        file: fileObj
                    }
                });
                document.dispatchEvent(event);

                this.showSuccess(`Loaded ${conversations.length} conversation(s) from URL`);
            }
        } catch (error) {
            throw new Error(`Error processing file: ${error.message}`);
        }
    }
}
