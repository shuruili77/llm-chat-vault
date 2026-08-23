/**
 * ChatNavigator - Adaptive conversation preview and navigation system
 * 
 * Provides:
 * 1. Adaptive default: < 15 turns uses Claude-style timeline spine; >= 15 turns uses ChatGPT-style outline panel.
 * 2. Manual mode override: easily toggle between timeline, outline, and collapsed views.
 * 3. Rich hover preview: shows User Prompt + AI Response snippet on hover.
 * 4. Real-time keyword filter search in outline mode.
 * 5. Deterministic scroll tracking without off-by-one or scroll-snapping issues.
 */

export class ChatNavigator {
    /**
     * @param {HTMLElement} parentContainer - Container to attach navigator to (e.g. app-main or chat-viewport)
     * @param {HTMLElement} scrollContainer - Scrollable chat container (chat-viewport)
     * @param {Object} options - Configuration options
     */
    constructor(parentContainer, scrollContainer, options = {}) {
        this.parentContainer = parentContainer;
        this.scrollContainer = scrollContainer;
        this.threshold = options.threshold || 15;
        this.turns = [];
        this.activeTurnIndex = 0;
        this.currentMode = null; // 'timeline' | 'outline' | 'collapsed'
        this.userPreferredMode = null; // User manual override
        this.filterQuery = '';
        this.element = null;
        this.tooltipElement = null;
        this.hideTooltipTimeout = null;

        // Scroll lock & hover states to prevent scroll fighting
        this.isProgrammaticScroll = false;
        this.isHoveringOutline = false;
        this.scrollLockTimer = null;
        this.onScrollHandler = null;

        this.initDOM();
    }

    /**
     * Initialize base DOM containers
     */
    initDOM() {
        // Remove any existing navigator
        const existing = this.parentContainer.querySelector('.chat-navigator-root');
        if (existing) existing.remove();

        const existingTooltip = document.querySelector('.chat-nav-tooltip');
        if (existingTooltip) existingTooltip.remove();

        // Create root container
        this.element = document.createElement('div');
        this.element.className = 'chat-navigator-root';
        this.element.style.display = 'none';
        this.parentContainer.appendChild(this.element);

        // Create global floating tooltip
        this.tooltipElement = document.createElement('div');
        this.tooltipElement.className = 'chat-nav-tooltip';
        this.tooltipElement.style.display = 'none';
        document.body.appendChild(this.tooltipElement);
    }

    /**
     * Extract conversation turns from message list
     * @param {Array} messages - Filtered messages array
     * @returns {Array} List of turns
     */
    extractTurns(messages) {
        if (!messages || !Array.isArray(messages)) return [];

        const turns = [];
        let currentTurn = null;
        let turnIndex = 1;

        messages.forEach((msg, idx) => {
            if (!msg) return;
            const role = (msg.role || '').toLowerCase();
            const rawContent = msg.content || '';

            if (role === 'user') {
                if (currentTurn) {
                    turns.push(currentTurn);
                }
                const cleanUserText = this.extractPlainText(rawContent);
                currentTurn = {
                    index: turnIndex++,
                    userMessageId: msg.id || `msg-${idx}`,
                    elementId: `msg-turn-${turnIndex - 1}`,
                    userText: cleanUserText || '(Empty prompt)',
                    rawUserText: rawContent,
                    assistantSnippet: '',
                    timestamp: msg.timestamp || msg.created_at || null
                };
            } else if (role === 'assistant' && currentTurn) {
                // If assistant responds, record first snippet if not already recorded
                if (!currentTurn.assistantSnippet && rawContent) {
                    currentTurn.assistantSnippet = this.extractPlainText(rawContent, 180);
                }
            }
        });

        if (currentTurn) {
            turns.push(currentTurn);
        }

        return turns;
    }

    /**
     * Clean and strip Markdown formatting for clean plain-text preview
     * @param {string} text - Raw markdown text
     * @param {number} maxLength - Max length to truncate
     * @returns {string} Plain text preview
     */
    extractPlainText(text, maxLength = 120) {
        if (!text) return '';
        let clean = text
            .replace(/```[\s\S]*?```/g, ' [Code Block] ') // replace code blocks
            .replace(/`([^`]+)`/g, '$1')                 // inline code
            .replace(/!\[([^\]]*)\]\([^)]+\)/g, ' [Image] ') // images
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // links
            .replace(/^#+\s+/gm, '')                     // headers
            .replace(/(\*\*|__)(.*?)\1/g, '$2')          // bold
            .replace(/(\*|_)(.*?)\1/g, '$2')            // italic
            .replace(/^>\s+/gm, '')                      // blockquotes
            .replace(/[\r\n]+/g, ' ')                    // newlines to space
            .replace(/\s+/g, ' ')                        // multiple spaces
            .trim();

        if (clean.length > maxLength) {
            clean = clean.slice(0, maxLength).trim() + '...';
        }
        return clean;
    }

    /**
     * Render the navigator for a given conversation
     * @param {Array} messages - Message list
     */
    render(messages) {
        this.turns = this.extractTurns(messages);

        if (this.turns.length === 0) {
            this.hide();
            return;
        }

        // Reset active index to beginning for fresh conversation
        this.activeTurnIndex = 0;
        this.filterQuery = '';
        this.isProgrammaticScroll = false;

        // Determine mode: auto-adaptive based on threshold, unless manually set
        if (this.userPreferredMode) {
            this.currentMode = this.userPreferredMode;
        } else {
            this.currentMode = this.turns.length >= this.threshold ? 'outline' : 'timeline';
        }

        this.element.style.display = 'block';
        this.renderCurrentView();
        this.setupScrollObserver();
    }

    /**
     * Switch view mode (timeline | outline | collapsed)
     * @param {string} mode 
     */
    setMode(mode) {
        this.currentMode = mode;
        this.userPreferredMode = mode;
        this.renderCurrentView();
    }

    /**
     * Render the active mode view
     */
    renderCurrentView() {
        this.hideTooltip();
        this.element.innerHTML = '';
        this.element.className = `chat-navigator-root mode-${this.currentMode}`;

        if (this.currentMode === 'collapsed') {
            this.renderCollapsedView();
        } else if (this.currentMode === 'outline') {
            this.renderOutlineView();
        } else {
            this.renderTimelineView();
        }

        this.updateActiveHighlight(false);
    }

    /**
     * Render Claude-style Timeline / Spine view
     */
    renderTimelineView() {
        const spineWrap = document.createElement('div');
        spineWrap.className = 'chat-nav-timeline';

        // Header controls (mini toggle)
        const header = document.createElement('div');
        header.className = 'chat-nav-spine-header';
        header.innerHTML = `
            <button class="chat-nav-btn-icon" data-action="switch-outline" title="Switch to Outline view (${this.turns.length} turns)">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
                    <path fill-rule="evenodd" d="M2 12.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5zm0-3a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z"/>
                </svg>
            </button>
            <button class="chat-nav-btn-icon" data-action="collapse" title="Collapse navigator">
                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16">
                    <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
                </svg>
            </button>
        `;

        header.querySelector('[data-action="switch-outline"]').addEventListener('click', (e) => {
            e.stopPropagation();
            this.setMode('outline');
        });
        header.querySelector('[data-action="collapse"]').addEventListener('click', (e) => {
            e.stopPropagation();
            this.setMode('collapsed');
        });

        spineWrap.appendChild(header);

        // Ticks container
        const ticksList = document.createElement('div');
        ticksList.className = 'chat-nav-ticks-list';

        this.turns.forEach((turn, idx) => {
            const tick = document.createElement('div');
            tick.className = `chat-nav-tick ${idx === this.activeTurnIndex ? 'active' : ''}`;
            tick.dataset.turnIndex = idx;

            const tickBar = document.createElement('div');
            tickBar.className = 'tick-bar';
            tick.appendChild(tickBar);

            // Hover preview
            tick.addEventListener('mouseenter', () => {
                this.showTooltip(turn, tick);
            });
            tick.addEventListener('mouseleave', () => {
                this.scheduleHideTooltip();
            });

            // Click jump
            tick.addEventListener('click', (e) => {
                e.stopPropagation();
                this.scrollToTurn(idx);
            });

            ticksList.appendChild(tick);
        });

        spineWrap.appendChild(ticksList);
        this.element.appendChild(spineWrap);
    }

    /**
     * Render ChatGPT-style Outline panel view
     */
    renderOutlineView() {
        const panel = document.createElement('div');
        panel.className = 'chat-nav-outline-panel';

        // Outline hover detection to prevent background scroll interference
        panel.addEventListener('mouseenter', () => {
            this.isHoveringOutline = true;
        });
        panel.addEventListener('mouseleave', () => {
            this.isHoveringOutline = false;
        });

        panel.innerHTML = `
            <div class="chat-nav-outline-header">
                <div class="outline-header-title">
                    <span class="outline-title-text">Conversation Outline</span>
                    <span class="outline-count-badge">${this.turns.length}</span>
                </div>
                <div class="outline-header-actions">
                    <button class="chat-nav-btn-icon" data-action="switch-timeline" title="Switch to Timeline view">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M8 1a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-1 0v-13A.5.5 0 0 1 8 1zm4 3a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-1 0v-7a.5.5 0 0 1 .5-.5zm-8 2a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0v-3a.5.5 0 0 1 .5-.5z"/>
                        </svg>
                    </button>
                    <button class="chat-nav-btn-icon" data-action="collapse" title="Collapse outline">
                        <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16">
                            <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="chat-nav-filter-wrap">
                <div class="chat-nav-search-box">
                    <svg class="search-icon" xmlns="http://www.w3.org/2000/svg" width="11" height="11" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                    </svg>
                    <input type="text" class="chat-nav-filter-input" placeholder="Filter prompts..." value="${this.escapeHtml(this.filterQuery)}" />
                    ${this.filterQuery ? '<button class="chat-nav-clear-filter" title="Clear filter">&times;</button>' : ''}
                </div>
            </div>
            <div class="chat-nav-outline-list"></div>
        `;

        // Bind header buttons
        panel.querySelector('[data-action="switch-timeline"]').addEventListener('click', (e) => {
            e.stopPropagation();
            this.setMode('timeline');
        });
        panel.querySelector('[data-action="collapse"]').addEventListener('click', (e) => {
            e.stopPropagation();
            this.setMode('collapsed');
        });

        // Bind filter input
        const filterInput = panel.querySelector('.chat-nav-filter-input');
        filterInput.addEventListener('input', (e) => {
            this.filterQuery = e.target.value;
            this.renderOutlineList(panel.querySelector('.chat-nav-outline-list'));
        });

        const clearBtn = panel.querySelector('.chat-nav-clear-filter');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                this.filterQuery = '';
                this.renderCurrentView();
            });
        }

        // Render items into list
        this.renderOutlineList(panel.querySelector('.chat-nav-outline-list'));

        this.element.appendChild(panel);
    }

    /**
     * Render the items list inside outline panel
     * @param {HTMLElement} listContainer 
     */
    renderOutlineList(listContainer) {
        if (!listContainer) return;
        listContainer.innerHTML = '';

        const query = this.filterQuery.toLowerCase().trim();
        const filteredTurns = query
            ? this.turns.filter(t => t.userText.toLowerCase().includes(query) || (t.assistantSnippet && t.assistantSnippet.toLowerCase().includes(query)))
            : this.turns;

        if (filteredTurns.length === 0) {
            listContainer.innerHTML = '<div class="chat-nav-no-results">No matching prompts</div>';
            return;
        }

        filteredTurns.forEach(turn => {
            const originalIdx = turn.index - 1;
            const item = document.createElement('div');
            const isActive = originalIdx === this.activeTurnIndex;
            item.className = `chat-nav-outline-item ${isActive ? 'active' : ''}`;
            item.dataset.turnIndex = originalIdx;

            let displayText = turn.userText;
            if (query) {
                displayText = this.highlightMatch(displayText, query);
            } else {
                displayText = this.escapeHtml(displayText);
            }

            item.innerHTML = `
                <span class="outline-item-badge">#${turn.index}</span>
                <span class="outline-item-text">${displayText}</span>
            `;

            // Hover preview
            item.addEventListener('mouseenter', () => {
                this.showTooltip(turn, item, 'left');
            });
            item.addEventListener('mouseleave', () => {
                this.scheduleHideTooltip();
            });

            // Click jump
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                this.scrollToTurn(originalIdx);
            });

            listContainer.appendChild(item);
        });
    }

    /**
     * Render collapsed trigger button
     */
    renderCollapsedView() {
        const trigger = document.createElement('button');
        trigger.className = 'chat-nav-collapsed-btn';
        trigger.title = `Show navigation (${this.turns.length} turns)`;
        trigger.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                <path fill-rule="evenodd" d="M11.354 1.646a.5.5 0 0 1 0 .708L5.707 8l5.647 5.646a.5.5 0 0 1-.708.708l-6-6a.5.5 0 0 1 0-.708l6-6a.5.5 0 0 1 .708 0z"/>
            </svg>
            <span class="collapsed-count-text">${this.turns.length}</span>
        `;

        trigger.addEventListener('click', (e) => {
            e.stopPropagation();
            // Restore to adaptive default or outline
            const targetMode = this.turns.length >= this.threshold ? 'outline' : 'timeline';
            this.setMode(targetMode);
        });

        this.element.appendChild(trigger);
    }

    /**
     * Show rich hover tooltip preview
     * @param {Object} turn - Turn data
     * @param {HTMLElement} targetEl - Element hovered
     * @param {string} placement - 'left' | 'right'
     */
    showTooltip(turn, targetEl, placement = 'left') {
        if (this.hideTooltipTimeout) {
            clearTimeout(this.hideTooltipTimeout);
            this.hideTooltipTimeout = null;
        }

        if (!this.tooltipElement) return;

        const aiSnippetHtml = turn.assistantSnippet
            ? `<div class="tooltip-ai-snippet"><span class="tooltip-ai-label">AI:</span> ${this.escapeHtml(turn.assistantSnippet)}</div>`
            : '<div class="tooltip-ai-snippet tooltip-empty-ai">No response yet</div>';

        this.tooltipElement.innerHTML = `
            <div class="tooltip-header">
                <span class="tooltip-badge">Turn ${turn.index}</span>
                ${turn.timestamp ? `<span class="tooltip-time">${this.formatShortTime(turn.timestamp)}</span>` : ''}
            </div>
            <div class="tooltip-user-title">${this.escapeHtml(turn.userText)}</div>
            ${aiSnippetHtml}
        `;

        this.tooltipElement.style.display = 'block';
        this.tooltipElement.classList.add('visible');

        // Position tooltip relative to targetEl
        const rect = targetEl.getBoundingClientRect();
        const tooltipRect = this.tooltipElement.getBoundingClientRect();

        let top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
        // Constrain top within viewport
        const padding = 12;
        if (top < padding) top = padding;
        if (top + tooltipRect.height > window.innerHeight - padding) {
            top = window.innerHeight - padding - tooltipRect.height;
        }

        let left = 0;
        if (placement === 'left') {
            left = rect.left - tooltipRect.width - 10;
        } else {
            left = rect.right + 10;
        }

        // If left overflows on left side, flip to right
        if (left < padding) {
            left = rect.right + 10;
        }

        this.tooltipElement.style.top = `${top}px`;
        this.tooltipElement.style.left = `${left}px`;

        // Keep tooltip alive if mouse enters it
        this.tooltipElement.onmouseenter = () => {
            if (this.hideTooltipTimeout) {
                clearTimeout(this.hideTooltipTimeout);
                this.hideTooltipTimeout = null;
            }
        };
        this.tooltipElement.onmouseleave = () => {
            this.scheduleHideTooltip();
        };
    }

    /**
     * Schedule hide tooltip with debounce
     */
    scheduleHideTooltip() {
        if (this.hideTooltipTimeout) clearTimeout(this.hideTooltipTimeout);
        this.hideTooltipTimeout = setTimeout(() => {
            this.hideTooltip();
        }, 120);
    }

    /**
     * Hide tooltip immediately
     */
    hideTooltip() {
        if (this.tooltipElement) {
            this.tooltipElement.classList.remove('visible');
            this.tooltipElement.style.display = 'none';
        }
    }

    /**
     * Scroll chat viewport smoothly and accurately to the selected turn
     * @param {number} turnIndex 
     */
    scrollToTurn(turnIndex) {
        if (turnIndex < 0 || turnIndex >= this.turns.length) return;
        const turn = this.turns[turnIndex];
        const targetEl = document.getElementById(turn.elementId);
        if (!targetEl) return;

        // Set programmatic scroll lock to prevent scroll-event feedback loops
        this.isProgrammaticScroll = true;
        this.activeTurnIndex = turnIndex;
        this.updateActiveHighlight(true);

        if (this.scrollLockTimer) {
            clearTimeout(this.scrollLockTimer);
        }

        // Calculate exact scroll position taking header and container into account
        const containerRect = this.scrollContainer.getBoundingClientRect();
        const targetRect = targetEl.getBoundingClientRect();
        const targetScrollTop = this.scrollContainer.scrollTop + (targetRect.top - containerRect.top) - 16;

        this.scrollContainer.scrollTo({
            top: Math.max(0, targetScrollTop),
            behavior: 'smooth'
        });

        // Release scroll lock after smooth scrolling completes
        this.scrollLockTimer = setTimeout(() => {
            this.isProgrammaticScroll = false;
        }, 700);
    }

    /**
     * Update active highlight in UI
     * @param {boolean} forceScrollOutline - If true, force scroll outline to active item
     */
    updateActiveHighlight(forceScrollOutline = false) {
        if (!this.element) return;

        // Timeline ticks
        const ticks = this.element.querySelectorAll('.chat-nav-tick');
        ticks.forEach((tick, idx) => {
            tick.classList.toggle('active', idx === this.activeTurnIndex);
        });

        // Outline items
        const outlineItems = this.element.querySelectorAll('.chat-nav-outline-item');
        outlineItems.forEach(item => {
            const idx = parseInt(item.dataset.turnIndex, 10);
            const isActive = idx === this.activeTurnIndex;
            item.classList.toggle('active', isActive);
            if (isActive && this.currentMode === 'outline') {
                // If user is actively hovering/scrolling outline drawer, do NOT snap-scroll it
                // unless it was explicitly triggered by clicking an item
                if (forceScrollOutline || !this.isHoveringOutline) {
                    const listContainer = item.parentElement;
                    if (listContainer) {
                        const listRect = listContainer.getBoundingClientRect();
                        const itemRect = item.getBoundingClientRect();
                        if (forceScrollOutline || itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
                            item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                        }
                    }
                }
            }
        });
    }

    /**
     * Setup deterministic scroll tracking on chat viewport
     */
    setupScrollObserver() {
        if (this.onScrollHandler) {
            this.scrollContainer.removeEventListener('scroll', this.onScrollHandler);
            this.onScrollHandler = null;
        }

        let ticking = false;
        this.onScrollHandler = () => {
            if (this.isProgrammaticScroll) return;
            if (!ticking) {
                window.requestAnimationFrame(() => {
                    this.computeActiveTurnOnScroll();
                    ticking = false;
                });
                ticking = true;
            }
        };

        this.scrollContainer.addEventListener('scroll', this.onScrollHandler, { passive: true });
    }

    /**
     * Compute which turn is currently at the top of the reading area
     */
    computeActiveTurnOnScroll() {
        if (this.isProgrammaticScroll || this.turns.length === 0) return;

        // Check if reached the very bottom of the conversation
        const isAtBottom = (this.scrollContainer.scrollTop + this.scrollContainer.clientHeight) >= (this.scrollContainer.scrollHeight - 24);
        if (isAtBottom) {
            const lastIdx = this.turns.length - 1;
            if (lastIdx !== this.activeTurnIndex) {
                this.activeTurnIndex = lastIdx;
                this.updateActiveHighlight(false);
            }
            return;
        }

        const containerRect = this.scrollContainer.getBoundingClientRect();
        const triggerY = containerRect.top + 90; // Scan line near top reading area

        let closestTurnIdx = 0;
        for (let i = 0; i < this.turns.length; i++) {
            const el = document.getElementById(this.turns[i].elementId);
            if (!el) continue;
            const rect = el.getBoundingClientRect();
            if (rect.top <= triggerY) {
                closestTurnIdx = i;
            } else {
                break; // Subsequent turns are lower down in DOM
            }
        }

        if (closestTurnIdx !== this.activeTurnIndex) {
            this.activeTurnIndex = closestTurnIdx;
            this.updateActiveHighlight(false);
        }
    }

    /**
     * Hide and clean up navigator
     */
    hide() {
        if (this.element) {
            this.element.style.display = 'none';
            this.element.innerHTML = '';
        }
        this.hideTooltip();
        if (this.onScrollHandler) {
            this.scrollContainer.removeEventListener('scroll', this.onScrollHandler);
            this.onScrollHandler = null;
        }
        if (this.scrollLockTimer) {
            clearTimeout(this.scrollLockTimer);
            this.scrollLockTimer = null;
        }
    }

    /**
     * Destroy component completely
     */
    destroy() {
        this.hide();
        if (this.element) {
            this.element.remove();
            this.element = null;
        }
        if (this.tooltipElement) {
            this.tooltipElement.remove();
            this.tooltipElement = null;
        }
    }

    /**
     * Highlight search match in text
     */
    highlightMatch(text, query) {
        if (!text || !query) return this.escapeHtml(text || '');
        const escaped = this.escapeHtml(text);
        const escapedQuery = this.escapeHtml(query);
        const regex = new RegExp(`(${this.escapeRegex(escapedQuery)})`, 'gi');
        return escaped.replace(regex, '<mark class="chat-nav-highlight">$1</mark>');
    }

    escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    formatShortTime(dateInput) {
        if (!dateInput) return '';
        const d = new Date(typeof dateInput === 'number' && dateInput < 10000000000 ? dateInput * 1000 : dateInput);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
}
