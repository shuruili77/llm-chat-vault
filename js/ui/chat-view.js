/**
 * Chat view component for rendering conversation messages
 */

import { renderMarkdown } from './markdown.js';
import { ChatNavigator } from './chat-navigator.js';

export class ChatView {
    constructor(container, options = {}) {
        this.container = container;
        this.titleElement = document.getElementById('chat-title');
        this.metaElement = document.getElementById('chat-meta');
        this.starBtn = document.getElementById('chat-star-btn');
        this.renameBtn = document.getElementById('chat-rename-btn');
        this.currentConversation = null;
        this.searchQuery = '';
        this.onSwitchBranch = options.onSwitchBranch || null;
        this.onRenameCallback = null;
        this.onToggleStarCallback = null;
        this.navigator = new ChatNavigator(this.container.parentElement || this.container, this.container);
        this.targetScrollMessageId = null;
        this.targetScrollTurnIndex = null;
        this.lastRenderedConversationId = null;
        this.setupRenameEvents();
        this.setupStarEvents();
    }

    setupRenameEvents() {
        if (this.renameBtn) {
            this.renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.currentConversation && this.onRenameCallback) {
                    this.onRenameCallback(this.currentConversation);
                }
            });
        }
        if (this.titleElement) {
            this.titleElement.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                if (this.currentConversation && this.onRenameCallback) {
                    this.onRenameCallback(this.currentConversation);
                }
            });
        }
    }

    setupStarEvents() {
        if (this.starBtn) {
            this.starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.currentConversation && this.onToggleStarCallback) {
                    this.onToggleStarCallback(this.currentConversation.id, !this.currentConversation.is_starred);
                }
            });
        }
    }

    onRename(callback) {
        this.onRenameCallback = callback;
    }

    onToggleStar(callback) {
        this.onToggleStarCallback = callback;
    }

    /**
     * Set search query for highlighting
     * @param {string} query - Search query
     */
    setSearchQuery(query) {
        this.searchQuery = query;
    }

    /**
     * Render a conversation in the chat view
     * @param {Object} conversation - Normalized conversation object
     */
    render(conversation) {
        this.currentConversation = conversation;
        if (!conversation) {
            if (this.renameBtn) this.renameBtn.style.display = 'none';
            if (this.starBtn) this.starBtn.style.display = 'none';
            this.renderEmpty();
            return;
        }

        // Update header
        this.titleElement.textContent = conversation.title;
        if (this.renameBtn) {
            this.renameBtn.style.display = 'inline-flex';
        }
        if (this.starBtn) {
            this.starBtn.style.display = 'inline-flex';
            const isStarred = Boolean(conversation.is_starred);
            this.starBtn.classList.toggle('starred', isStarred);
            this.starBtn.title = isStarred ? 'Unstar this conversation' : 'Star this conversation';
            this.starBtn.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="${isStarred ? '#f59e0b' : 'currentColor'}" viewBox="0 0 16 16">
                    ${isStarred ?
                        '<path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/>' :
                        '<path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767-3.686 1.894.694-3.957a.565.565 0 0 0-.163-.505L1.71 6.745l4.052-.576a.525.525 0 0 0 .393-.288L8 2.223l1.847 3.658a.525.525 0 0 0 .393.288l4.052.575-2.906 2.77a.565.565 0 0 0-.163.506l.694 3.957-3.686-1.895a.564.564 0 0 0-.532 0z"/>'
                    }
                </svg>
            `;
        }

        if (conversation.custom_title && conversation.original_title && conversation.custom_title !== conversation.original_title) {
            this.titleElement.title = `Custom title (Original: "${conversation.original_title}") • Double click to rename`;
        } else {
            this.titleElement.title = `Double click to rename`;
        }

        const rawMessages = conversation.active_branch || conversation.messages || [];
        const messages = rawMessages.filter(msg => {
            if (!msg) return false;
            const content = (msg.content || '').trim();
            const hasAttachments = (msg.metadata?.attachments && msg.metadata.attachments.length > 0) || (msg.attachments && msg.attachments.length > 0);
            return Boolean(content) || Boolean(hasAttachments);
        });

        const formatBadge = this.getFormatBadge(conversation.format);
        const rawDate = conversation.updated ?? conversation.updated_at ?? conversation.created ?? conversation.created_at;
        let dateVal = new Date();
        if (rawDate instanceof Date) {
            dateVal = rawDate;
        } else if (typeof rawDate === 'number') {
            dateVal = new Date(rawDate < 1e10 ? rawDate * 1000 : rawDate);
        } else if (rawDate) {
            const parsed = new Date(rawDate);
            if (!isNaN(parsed.getTime())) dateVal = parsed;
        }
        const dateStr = this.formatDate(dateVal);
        this.metaElement.innerHTML = `${formatBadge} <span class="text-muted">•</span> ${dateStr} <span class="text-muted">•</span> ${messages.length} messages`;

        // Clear container and render messages
        this.container.innerHTML = '';

        if (messages.length === 0) {
            this.container.innerHTML = '<div class="text-center text-muted py-5">No messages in this conversation</div>';
            if (this.navigator) this.navigator.hide();
            return;
        }

        const messagesContainer = document.createElement('div');
        messagesContainer.className = 'messages-container';

        let turnIndex = 0;
        messages.forEach(message => {
            let turnIdxForMsg = null;
            if (message.role === 'user') {
                turnIndex++;
                turnIdxForMsg = turnIndex;
            }
            const messageElement = this.createMessageElement(message, conversation, turnIdxForMsg);
            if (messageElement) {
                messagesContainer.appendChild(messageElement);
            }
        });

        this.container.appendChild(messagesContainer);

        // Attach 1-click copy listeners to code blocks
        this.attachCopyCodeListeners();

        // Attach image lightbox preview listeners
        this.attachImageLightboxListeners();

        // Render side navigator (Claude timeline / ChatGPT outline)
        if (this.navigator) {
            this.navigator.render(messages);
        }

        // Handle scroll positioning (preserve position on branch switch vs bottom on new conversation)
        const isNewConversation = !this.lastRenderedConversationId || this.lastRenderedConversationId !== conversation.id;
        this.lastRenderedConversationId = conversation.id;

        if (this.targetScrollMessageId || this.targetScrollTurnIndex) {
            let targetEl = null;
            if (this.targetScrollMessageId) {
                targetEl = this.container.querySelector(`[data-message-id="${this.targetScrollMessageId}"]`) ||
                           document.getElementById(`msg-${this.targetScrollMessageId}`);
            }
            if (!targetEl && this.targetScrollTurnIndex) {
                targetEl = document.getElementById(`msg-turn-${this.targetScrollTurnIndex}`);
            }

            if (targetEl) {
                targetEl.scrollIntoView({ block: 'center', behavior: 'instant' });
            } else if (isNewConversation) {
                this.container.scrollTop = this.container.scrollHeight;
            }

            this.targetScrollMessageId = null;
            this.targetScrollTurnIndex = null;
        } else if (isNewConversation) {
            this.container.scrollTop = this.container.scrollHeight;
        }
    }

    /**
     * Attach click handlers for image attachments to open full-screen lightbox
     */
    attachImageLightboxListeners() {
        this.container.querySelectorAll('.chat-attached-image').forEach(img => {
            img.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openLightbox(img.src, img.alt || '');
            });
        });
    }

    /**
     * Open image preview in a modal Lightbox
     * @param {string} src - Image URL
     * @param {string} captionText - Caption or alt text
     */
    openLightbox(src, captionText = '') {
        let lightbox = document.getElementById('image-lightbox-modal');
        if (!lightbox) {
            lightbox = document.createElement('div');
            lightbox.id = 'image-lightbox-modal';
            lightbox.className = 'image-lightbox';
            lightbox.innerHTML = `
                <div class="lightbox-toolbar">
                    <a class="lightbox-btn" id="lightbox-download-btn" href="#" download target="_blank">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
                            <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
                        </svg>
                        Download
                    </a>
                    <button class="lightbox-btn" id="lightbox-close-btn" type="button" title="Close (Esc)">
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/>
                        </svg>
                        Close
                    </button>
                </div>
                <div class="lightbox-img-wrap">
                    <img id="lightbox-main-img" class="lightbox-img" src="" alt="" />
                </div>
                <div id="lightbox-caption" class="lightbox-caption"></div>
            `;
            document.body.appendChild(lightbox);

            const closeBtn = lightbox.querySelector('#lightbox-close-btn');
            closeBtn.addEventListener('click', () => this.closeLightbox());
            lightbox.addEventListener('click', (e) => {
                if (e.target === lightbox || e.target.classList.contains('lightbox-img-wrap')) {
                    this.closeLightbox();
                }
            });
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && lightbox.classList.contains('active')) {
                    this.closeLightbox();
                }
            });
        }

        const mainImg = lightbox.querySelector('#lightbox-main-img');
        const dlBtn = lightbox.querySelector('#lightbox-download-btn');
        const captionEl = lightbox.querySelector('#lightbox-caption');

        mainImg.src = src;
        dlBtn.href = src;
        if (captionText && captionText !== 'Image') {
            captionEl.textContent = captionText;
            captionEl.style.display = 'block';
        } else {
            captionEl.style.display = 'none';
        }

        lightbox.classList.add('active');
    }

    /**
     * Close the active lightbox modal
     */
    closeLightbox() {
        const lightbox = document.getElementById('image-lightbox-modal');
        if (lightbox) {
            lightbox.classList.remove('active');
        }
    }

    /**
     * Attach click handlers for copy buttons on code blocks
     */
    attachCopyCodeListeners() {
        this.container.querySelectorAll('.code-copy-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rawCode = decodeURIComponent(btn.dataset.code || '');
                try {
                    await navigator.clipboard.writeText(rawCode);
                    const originalHtml = btn.innerHTML;
                    btn.innerHTML = `
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" style="color: #4ade80;" viewBox="0 0 16 16">
                            <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
                        </svg>
                        <span style="color: #4ade80;">Copied!</span>
                    `;
                    setTimeout(() => {
                        btn.innerHTML = originalHtml;
                    }, 2000);
                } catch (err) {
                    console.error('Failed to copy code block:', err);
                }
            });
        });
    }

    /**
     * Create a message element
     * @param {Object} message - Message object
     * @param {Object} conversation - Parent conversation object
     * @param {number|null} turnIndex - Optional 1-based turn index for user prompt
     * @returns {HTMLElement}
     */
    createMessageElement(message, conversation, turnIndex = null) {
        if (!message) return null;
        const contentStr = (message.content || '').trim();
        const hasAttachments = (message.metadata?.attachments && message.metadata.attachments.length > 0) || (message.attachments && message.attachments.length > 0);
        if (!contentStr && !hasAttachments) {
            return null;
        }

        const wrapper = document.createElement('div');
        wrapper.className = `message-wrapper message-${message.role}`;
        if (message.id) {
            wrapper.dataset.messageId = message.id;
        }
        if (message.role === 'user' && turnIndex) {
            wrapper.id = `msg-turn-${turnIndex}`;
            wrapper.dataset.turnIndex = turnIndex - 1;
        } else if (message.id) {
            wrapper.id = `msg-${message.id}`;
        }

        const bubble = document.createElement('div');
        bubble.className = `message-bubble ${message.role}`;

        // Render markdown content
        const contentHtml = renderMarkdown(message.content);
        bubble.innerHTML = contentHtml;

        // Apply search highlighting if there's a query
        if (this.searchQuery) {
            this.highlightTextInElement(bubble);
        }

        // Footer with timestamp, branch version switcher & model badge
        const footer = document.createElement('div');
        footer.className = 'message-footer';

        // Add branch switcher if message has siblings (regenerated or edited versions)
        if (message.siblings && message.siblings.length > 1) {
            const currentIdx = message.siblings.findIndex(s => s.id === message.id);
            const activeIdx = currentIdx >= 0 ? currentIdx : 0;
            const branchSwitcher = document.createElement('div');
            branchSwitcher.className = 'branch-version-switcher';
            branchSwitcher.innerHTML = `
                <button class="branch-nav-btn prev" ${activeIdx === 0 ? 'disabled' : ''} title="Previous version">&lt;</button>
                <span class="branch-version-label">${activeIdx + 1} / ${message.siblings.length}</span>
                <button class="branch-nav-btn next" ${activeIdx === message.siblings.length - 1 ? 'disabled' : ''} title="Next version">&gt;</button>
            `;

            branchSwitcher.querySelector('.prev').addEventListener('click', (e) => {
                e.stopPropagation();
                if (activeIdx > 0 && this.onSwitchBranch) {
                    const targetNode = message.siblings[activeIdx - 1];
                    this.targetScrollMessageId = targetNode.id;
                    this.targetScrollTurnIndex = turnIndex;
                    this.onSwitchBranch(conversation.id, targetNode.id);
                }
            });

            branchSwitcher.querySelector('.next').addEventListener('click', (e) => {
                e.stopPropagation();
                if (activeIdx < message.siblings.length - 1 && this.onSwitchBranch) {
                    const targetNode = message.siblings[activeIdx + 1];
                    this.targetScrollMessageId = targetNode.id;
                    this.targetScrollTurnIndex = turnIndex;
                    this.onSwitchBranch(conversation.id, targetNode.id);
                }
            });

            footer.appendChild(branchSwitcher);
        }

        // Add model badge for AI/assistant messages
        if (message.role === 'assistant') {
            const rawModel = message.model_slug ||
                             message.metadata?.model_slug ||
                             message.metadata?.model ||
                             conversation?.model_slug ||
                             conversation?.default_model_slug ||
                             null;
            const formattedModel = this.formatModelName(rawModel, conversation?.format);
            const isUnknown = formattedModel === 'Unknown' || formattedModel.includes('Unknown');

            const modelPill = document.createElement('span');
            modelPill.className = `message-model-pill ${isUnknown ? 'model-pill-unknown' : ''}`;
            modelPill.title = rawModel ? `Model: ${rawModel}` : 'Model: Unknown';
            modelPill.innerHTML = `
                <span class="model-pill-icon">🤖</span>
                <span class="model-pill-name">${this.escapeHtml(formattedModel)}</span>
            `;
            footer.appendChild(modelPill);
        }

        // Add timestamp
        const timestamp = document.createElement('div');
        timestamp.className = 'message-timestamp';
        const tsDate = message.timestamp ? new Date(message.timestamp) : (message.created_at ? new Date(message.created_at * (message.created_at > 10000000000 ? 1 : 1000)) : new Date());
        timestamp.textContent = this.formatTimestamp(tsDate);
        footer.appendChild(timestamp);

        wrapper.appendChild(bubble);
        wrapper.appendChild(footer);

        return wrapper;
    }

    /**
     * Render empty state
     */
    renderEmpty() {
        this.titleElement.textContent = 'Welcome';
        this.metaElement.textContent = '';

        if (this.navigator) {
            this.navigator.hide();
        }

        this.container.innerHTML = `
            <div class="empty-state text-center py-5">
                <div class="empty-state-icon mb-3">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M5 8a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm4 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0zm3 1a1 1 0 1 0 0-2 1 1 0 0 0 0 2z"/>
                        <path d="m2.165 15.803.02-.004c1.83-.363 2.948-.842 3.468-1.105A9.06 9.06 0 0 0 8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6a10.437 10.437 0 0 1-.524 2.318l-.003.011a10.722 10.722 0 0 1-.244.637c-.079.186.074.394.273.362a21.673 21.673 0 0 0 .693-.125zm.8-3.108a1 1 0 0 0-.287-.801C1.618 10.83 1 9.468 1 8c0-3.192 2.913-6 7-6s7 2.808 7 6c0 3.193-2.913 6-7 6a8.06 8.06 0 0 1-2.088-.272 1 1 0 0 0-.711.074c-.387.196-1.24.57-2.634.893a10.97 10.97 0 0 0 .398-2z"/>
                    </svg>
                </div>
                <h3 class="empty-state-title">Select a conversation</h3>
                <p class="empty-state-subtitle">Choose a chat from the sidebar to view full message history</p>
            </div>
        `;
    }

    /**
     * Get format badge HTML
     * @param {string} format - 'openai', 'claude', or 'zai'
     * @returns {string}
     */
    getFormatBadge(format) {
        const f = (format || '').toLowerCase();
        if (f === 'openai') return '<span class="format-chip chip-openai">OpenAI</span>';
        if (f === 'claude') return '<span class="format-chip chip-claude">Claude</span>';
        if (f === 'zai') return '<span class="format-chip chip-zai">Z.ai</span>';
        return '<span class="format-chip chip-default">Chat</span>';
    }

    /**
     * Format date for display
     * @param {Date} date
     * @returns {string}
     */
    formatDate(date) {
        if (!date || isNaN(date.getTime())) return '';
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    /**
     * Format timestamp for message
     * @param {Date} timestamp
     * @returns {string}
     */
    formatTimestamp(timestamp) {
        return timestamp.toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    /**
     * Highlight search terms in an element's text nodes
     * @param {HTMLElement} element - Element to highlight in
     */
    highlightTextInElement(element) {
        const searchWords = this.searchQuery.toLowerCase().trim().split(/\s+/).filter(word => word.length > 0);

        if (searchWords.length === 0) {
            return;
        }

        // Walk through all text nodes and highlight matches
        const walker = document.createTreeWalker(
            element,
            NodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => {
                    // Skip text nodes inside code blocks to avoid breaking syntax highlighting
                    if (node.parentElement.tagName === 'CODE' || node.parentElement.tagName === 'PRE') {
                        return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            }
        );

        const textNodes = [];
        let node;
        while (node = walker.nextNode()) {
            textNodes.push(node);
        }

        // Process each text node
        textNodes.forEach(textNode => {
            const text = textNode.textContent;
            let highlightedText = text;
            let hasMatch = false;

            searchWords.forEach(word => {
                const regex = new RegExp(`(${this.escapeRegex(word)})`, 'gi');
                if (regex.test(highlightedText)) {
                    hasMatch = true;
                }
            });

            if (hasMatch) {
                // Create a wrapper span and replace the text node
                const wrapper = document.createElement('span');
                wrapper.innerHTML = this.highlightText(text, searchWords);
                textNode.replaceWith(wrapper);
            }
        });
    }

    /**
     * Highlight search words in text
     * @param {string} text - Text to highlight
     * @param {Array<string>} searchWords - Words to highlight
     * @returns {string} - HTML with highlighted terms
     */
    highlightText(text, searchWords) {
        if (!text) return '';
        if (!searchWords || searchWords.length === 0) return this.escapeHtml(text);

        const validWords = searchWords.filter(w => w && w.trim().length > 0);
        if (validWords.length === 0) return this.escapeHtml(text);

        const pattern = new RegExp(`(${validWords.map(w => this.escapeRegex(w)).join('|')})`, 'gi');
        const parts = String(text).split(pattern);

        return parts.map(part => {
            if (!part) return '';
            if (validWords.some(w => w.toLowerCase() === part.toLowerCase())) {
                return `<mark class="search-highlight">${this.escapeHtml(part)}</mark>`;
            }
            return this.escapeHtml(part);
        }).join('');
    }

    /**
     * Escape HTML to prevent XSS
     * @param {string} text
     * @returns {string}
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Escape special regex characters
     * @param {string} str
     * @returns {string}
     */
    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Format raw model slug into human-readable label with fallback
     * @param {string|null} slug - Raw model identifier
     * @param {string|null} conversationFormat - Format of conversation (e.g. openai, claude, zai)
     * @returns {string} - Clean formatted model name (e.g. "GPT-4o", "Claude 3.5 Sonnet", "Unknown")
     */
    formatModelName(slug, conversationFormat = null) {
        if (!slug || typeof slug !== 'string') {
            if (conversationFormat === 'claude') return 'Claude (Unknown)';
            if (conversationFormat === 'zai') return 'Z.ai (Unknown)';
            return 'Unknown';
        }

        const s = slug.trim();
        if (!s) return 'Unknown';

        const lower = s.toLowerCase();

        // Exact matches & common tools
        if (lower === 'gpt-4o') return 'GPT-4o';
        if (lower === 'gpt-4o-mini') return 'GPT-4o Mini';
        if (lower === 'gpt-4o-canmore') return 'GPT-4o (Canvas)';
        if (lower === 'gpt-4o-av') return 'GPT-4o (Voice)';
        if (lower === 'gpt-4-turbo' || lower.includes('gpt-4-turbo')) return 'GPT-4 Turbo';
        if (lower === 'gpt-4-gizmo') return 'GPT-4 (Custom GPT)';
        if (lower === 'gpt-4-plugins') return 'GPT-4 (Plugins)';
        if (lower === 'gpt-4-dalle') return 'GPT-4 (DALL·E)';
        if (lower === 'gpt-4-code-interpreter') return 'GPT-4 (Code Interpreter)';
        if (lower === 'gpt-4-browsing') return 'GPT-4 (Browsing)';
        if (lower === 'gpt-4') return 'GPT-4';
        if (lower === 'gpt-4-1' || lower === 'gpt-4.1') return 'GPT-4.1';
        if (lower === 'gpt-4-1-mini') return 'GPT-4.1 Mini';
        if (lower === 'gpt-4-5' || lower === 'gpt-4.5') return 'GPT-4.5';
        if (lower === 'gpt-3.5-turbo' || lower.includes('gpt-3.5')) return 'GPT-3.5 Turbo';
        if (lower.startsWith('text-davinci-002-render') || lower.startsWith('text-davinci-003')) return 'GPT-3.5';

        // o-series reasoning models
        if (lower === 'o3') return 'o3';
        if (lower === 'o3-mini') return 'o3-mini';
        if (lower === 'o3-mini-high') return 'o3-mini (High)';
        if (lower === 'o1') return 'o1';
        if (lower === 'o1-preview') return 'o1-preview';
        if (lower === 'o1-mini') return 'o1-mini';
        if (lower === 'o4-mini' || lower === 'o4-mini-high') return 'o4-mini (High)';

        // Deep Research / Special features
        if (lower === 'research' || lower === 'deep-research') return 'Deep Research';
        if (lower === 'auto') return 'Auto Model';

        // GPT-5 series
        if (lower.startsWith('gpt-5')) {
            let name = s.replace(/^gpt-/i, 'GPT-').replace(/-/g, ' ');
            name = name.replace(/GPT 5 (\d)/i, 'GPT-5.$1')
                       .replace(/GPT 5\b/i, 'GPT-5')
                       .replace(/thinking/i, 'Thinking')
                       .replace(/instant/i, 'Instant')
                       .replace(/auto/i, 'Auto');
            return name;
        }

        // Claude models
        if (lower.includes('claude-3-5-sonnet') || lower.includes('claude-3.5-sonnet')) return 'Claude 3.5 Sonnet';
        if (lower.includes('claude-3-5-haiku') || lower.includes('claude-3.5-haiku')) return 'Claude 3.5 Haiku';
        if (lower.includes('claude-3-opus') || lower.includes('claude-3.0-opus')) return 'Claude 3 Opus';
        if (lower.includes('claude-3-sonnet')) return 'Claude 3 Sonnet';
        if (lower.includes('claude-3-haiku')) return 'Claude 3 Haiku';
        if (lower.includes('claude-2')) return 'Claude 2';
        if (lower === 'claude') return 'Claude';
        if (lower.startsWith('claude')) {
            return s.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }

        // Z.ai models
        if (lower === 'zai' || lower === 'z.ai') return 'Z.ai';

        // Generic GPT prefix
        if (lower.startsWith('gpt-')) {
            return s.replace(/^gpt-/i, 'GPT-');
        }

        return s;
    }
}
