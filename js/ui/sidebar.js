/**
 * Sidebar component for displaying conversation list, project hierarchies,
 * interactive tagging, and context menus.
 */

export class Sidebar {
    constructor(container) {
        this.container = container;
        this.currentConversationId = null;
        this.currentView = 'chats'; // 'chats' | 'projects' | 'project-detail'
        this.currentProjectId = null;
        this.activeContextConvId = null;

        // Callback registrations
        this.onSelectCallback = null;
        this.onSelectionChangeCallback = null;
        this.onSortChangeCallback = null;
        this.onSearchChangeCallback = null;
        this.onLoadMoreCallback = null;
        this.onViewChangeCallback = null;
        this.onCreateProjectCallback = null;
        this.onUpdateProjectCallback = null;
        this.onDeleteProjectCallback = null;
        this.onAssignProjectsCallback = null;
        this.onBatchAssignProjectsCallback = null;
        this.onDeleteConversationCallback = null;
        this.onExportConversationCallback = null;
        this.onRenameConversationCallback = null;
        this.onToggleStarCallback = null;
        this.activeExportConversation = null;
        this.onExportModalCallback = null;

        // Data cache
        this.allConversations = [];
        this.totalConversations = 0;
        this.totalAllChatsCount = 0;
        this.projects = [];
        this.isLoadingMore = false;
        this.searchQuery = '';
        this.selectedIds = new Set();
        this.isSelectionMode = false;
        this.sortBy = localStorage.getItem('llm_viewer_sort_by') || 'date';
        this.sortOrder = localStorage.getItem('llm_viewer_sort_order') || 'desc';
        this.debounceTimer = null;

        // Recent Projects Memory
        try {
            this.recentProjectIds = JSON.parse(localStorage.getItem('llm_viewer_recent_projects')) || [];
        } catch {
            this.recentProjectIds = [];
        }

        // Color & Icon Presets for Project Modals
        this.colorPresets = [
            '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b',
            '#f43f5e', '#06b6d4', '#6366f1', '#64748b',
            '#ec4899', '#14b8a6'
        ];
        this.iconPresets = [
            '📁', '🚀', '💡', '🔬', '📚', '⚙️',
            '💻', '🎯', '🎨', '📝', '⚡', '📊',
            '🌐', '🛠️', '🤖', '🔍'
        ];

        this.setupViewTabs();
        this.setupSearchInput();
        this.setupSortControls();
        this.setupSelectionModeToggle();
        this.setupScrollPagination();
        this.setupModals();
        this.setupContextMenu();
        this.setupProjectFlyout();
        this.updateSortUI();
    }

    /**
     * Recent Projects Tracking
     */
    getRecentProjects(limit = 5) {
        if (!this.projects || this.projects.length === 0) return [];
        const projectMap = new Map(this.projects.map(p => [p.id, p]));
        const recents = [];

        // Add from recentProjectIds
        for (const id of this.recentProjectIds) {
            if (projectMap.has(id)) {
                recents.push(projectMap.get(id));
                projectMap.delete(id);
                if (recents.length >= limit) break;
            }
        }

        // Backfill if fewer than limit
        if (recents.length < limit) {
            for (const p of this.projects) {
                if (!recents.some(r => r.id === p.id)) {
                    recents.push(p);
                    if (recents.length >= limit) break;
                }
            }
        }

        return recents;
    }

    markProjectAsRecent(projectId) {
        if (!projectId) return;
        this.recentProjectIds = [projectId, ...this.recentProjectIds.filter(id => id !== projectId)].slice(0, 15);
        try {
            localStorage.setItem('llm_viewer_recent_projects', JSON.stringify(this.recentProjectIds));
        } catch {}
    }

    /**
     * Setup View Switcher Tabs (All Chats vs Tags)
     */
    setupViewTabs() {
        const tabChats = document.getElementById('tab-all-chats');
        const tabProjects = document.getElementById('tab-projects');

        if (tabChats) {
            tabChats.addEventListener('click', () => {
                this.setView('chats');
            });
        }

        if (tabProjects) {
            tabProjects.addEventListener('click', () => {
                this.setView('projects');
            });
        }
    }

    /**
     * Switch current view
     */
    setView(view, projectId = null) {
        this.currentView = view;
        this.currentProjectId = projectId;

        // Update tab styling
        const tabChats = document.getElementById('tab-all-chats');
        const tabProjects = document.getElementById('tab-projects');
        const filtersWrap = document.getElementById('sidebar-filters-wrap');

        const tabs = [
            { el: tabChats, name: 'chats' },
            { el: tabProjects, name: ['projects', 'project-detail', 'starred'] }
        ];

        tabs.forEach(t => {
            if (!t.el) return;
            const isMatch = Array.isArray(t.name) ? t.name.includes(view) : t.name === view;
            t.el.classList.toggle('active', isMatch);
            t.el.setAttribute('aria-selected', isMatch ? 'true' : 'false');
        });

        if (filtersWrap) {
            filtersWrap.style.display = (view === 'projects') ? 'none' : 'block';
        }

        if (this.onViewChangeCallback) {
            this.onViewChangeCallback(view, projectId);
        } else {
            this.render(this.allConversations);
        }
    }

    /**
     * Open a specific project detail view
     */
    openProject(projectId) {
        this.markProjectAsRecent(projectId);
        this.setView('project-detail', projectId);
    }

    /**
     * Setup infinite scroll pagination
     */
    setupScrollPagination() {
        if (!this.container) return;
        this.container.addEventListener('scroll', () => {
            if (this.currentView === 'projects') return;
            if (this.isLoadingMore) return;
            if (this.allConversations.length >= this.totalConversations) return;
            const { scrollTop, scrollHeight, clientHeight } = this.container;
            if (scrollTop + clientHeight >= scrollHeight - 120) {
                this.triggerLoadMore();
            }
        });
    }

    /**
     * Setup multi-select mode toggle and batch actions
     */
    setupSelectionModeToggle() {
        const toggleBtn = document.getElementById('toggle-select-mode-btn');
        const selectionBar = document.getElementById('selection-controls');
        const batchAssignBtn = document.getElementById('batch-assign-project-btn');

        if (toggleBtn) {
            toggleBtn.addEventListener('click', () => {
                this.isSelectionMode = !this.isSelectionMode;
                toggleBtn.classList.toggle('active', this.isSelectionMode);
                if (selectionBar) {
                    selectionBar.style.display = this.isSelectionMode ? 'flex' : 'none';
                }
                if (!this.isSelectionMode) {
                    this.clearSelection();
                }
                this.render(this.allConversations);
            });
        }

        if (batchAssignBtn) {
            batchAssignBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const selected = this.getSelectedIds();
                if (selected.length > 0) {
                    this.showProjectFlyout(batchAssignBtn, selected);
                }
            });
        }
    }

    /**
     * Setup search input event listener with debouncing
     */
    setupSearchInput() {
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value;
                clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    if (this.onSearchChangeCallback) {
                        this.onSearchChangeCallback(this.searchQuery, this.currentProjectId);
                    } else {
                        this.render(this.allConversations);
                    }
                }, 200);
            });
        }
    }

    /**
     * Setup sort control buttons and listeners
     */
    setupSortControls() {
        const dateBtn = document.getElementById('sort-date-btn');
        const messagesBtn = document.getElementById('sort-messages-btn');
        const orderBtn = document.getElementById('sort-order-btn');

        if (dateBtn) {
            dateBtn.addEventListener('click', () => {
                if (this.sortBy === 'date') {
                    this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
                } else {
                    this.sortBy = 'date';
                }
                this.handleSortChange();
            });
        }

        if (messagesBtn) {
            messagesBtn.addEventListener('click', () => {
                if (this.sortBy === 'messages') {
                    this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
                } else {
                    this.sortBy = 'messages';
                }
                this.handleSortChange();
            });
        }

        if (orderBtn) {
            orderBtn.addEventListener('click', () => {
                this.sortOrder = this.sortOrder === 'desc' ? 'asc' : 'desc';
                this.handleSortChange();
            });
        }
    }

    /**
     * Update sort controls UI to reflect current state
     */
    updateSortUI() {
        const dateBtn = document.getElementById('sort-date-btn');
        const messagesBtn = document.getElementById('sort-messages-btn');
        const orderIcon = document.getElementById('sort-order-icon');
        const orderBtn = document.getElementById('sort-order-btn');

        if (dateBtn) {
            dateBtn.classList.toggle('active', this.sortBy === 'date');
        }
        if (messagesBtn) {
            messagesBtn.classList.toggle('active', this.sortBy === 'messages');
        }
        if (orderIcon) {
            orderIcon.innerHTML = this.sortOrder === 'asc' ? '&uarr;' : '&darr;';
        }
        if (orderBtn) {
            const orderLabel = this.sortOrder === 'asc' ? 'Ascending (lowest/oldest first)' : 'Descending (highest/newest first)';
            orderBtn.setAttribute('title', `Order: ${orderLabel} - Click to toggle`);
        }
    }

    /**
     * Set active sort state programmatically
     */
    setSort(sortBy, sortOrder = 'desc') {
        this.sortBy = sortBy;
        this.sortOrder = sortOrder;
        localStorage.setItem('llm_viewer_sort_by', this.sortBy);
        localStorage.setItem('llm_viewer_sort_order', this.sortOrder);
        this.updateSortUI();
    }

    /**
     * Trigger sort change persistence, UI update, and notify listeners
     */
    handleSortChange() {
        localStorage.setItem('llm_viewer_sort_by', this.sortBy);
        localStorage.setItem('llm_viewer_sort_order', this.sortOrder);
        this.updateSortUI();

        if (this.onSortChangeCallback) {
            this.onSortChangeCallback(this.sortBy, this.sortOrder, this.currentProjectId);
        } else {
            this.render(this.allConversations);
        }
    }

    /**
     * Setup Modals (Create/Edit Project)
     */
    setupModals() {
        this.setupRenameModal();
        this.setupExportModal();
        // Color presets
        const colorContainer = document.getElementById('project-color-presets');
        if (colorContainer) {
            colorContainer.innerHTML = '';
            this.colorPresets.forEach((color, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `color-preset-btn ${idx === 0 ? 'selected' : ''}`;
                btn.style.backgroundColor = color;
                btn.dataset.color = color;
                btn.setAttribute('aria-label', `Color ${color}`);
                btn.addEventListener('click', () => {
                    colorContainer.querySelectorAll('.color-preset-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    const colorInput = document.getElementById('project-form-color');
                    if (colorInput) colorInput.value = color;
                });
                colorContainer.appendChild(btn);
            });
        }

        // Icon presets
        const iconContainer = document.getElementById('project-icon-presets');
        if (iconContainer) {
            iconContainer.innerHTML = '';
            this.iconPresets.forEach((icon, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `icon-preset-btn ${idx === 0 ? 'selected' : ''}`;
                btn.textContent = icon;
                btn.dataset.icon = icon;
                btn.setAttribute('aria-label', `Icon ${icon}`);
                btn.addEventListener('click', () => {
                    iconContainer.querySelectorAll('.icon-preset-btn').forEach(b => b.classList.remove('selected'));
                    btn.classList.add('selected');
                    const iconInput = document.getElementById('project-form-icon');
                    if (iconInput) iconInput.value = icon;
                });
                iconContainer.appendChild(btn);
            });
        }

        // Project Modal Actions
        const projModalClose = document.getElementById('project-modal-close');
        const projModalCancel = document.getElementById('project-modal-cancel');
        const projModalOverlay = document.getElementById('project-modal-overlay');
        const projModalSave = document.getElementById('project-modal-save');

        const closeProjModal = () => {
            if (projModalOverlay) projModalOverlay.style.display = 'none';
        };

        if (projModalClose) projModalClose.addEventListener('click', closeProjModal);
        if (projModalCancel) projModalCancel.addEventListener('click', closeProjModal);
        if (projModalOverlay) {
            projModalOverlay.addEventListener('click', (e) => {
                if (e.target === projModalOverlay) closeProjModal();
            });
        }

        if (projModalSave) {
            projModalSave.addEventListener('click', () => {
                const idInput = document.getElementById('project-form-id');
                const nameInput = document.getElementById('project-form-name');
                const colorInput = document.getElementById('project-form-color');
                const iconInput = document.getElementById('project-form-icon');
                const descInput = document.getElementById('project-form-desc');

                const name = nameInput ? nameInput.value.trim() : '';
                if (!name) {
                    if (nameInput) nameInput.focus();
                    return;
                }

                const projId = idInput ? idInput.value : '';
                const projectData = {
                    name,
                    color: colorInput ? colorInput.value : '#3b82f6',
                    icon: iconInput ? iconInput.value : '📁',
                    description: descInput ? descInput.value.trim() : ''
                };

                closeProjModal();

                if (projId) {
                    if (this.onUpdateProjectCallback) {
                        this.onUpdateProjectCallback(projId, projectData);
                    }
                } else {
                    if (this.onCreateProjectCallback) {
                        this.onCreateProjectCallback(projectData);
                    }
                }
            });
        }

        // Assign Modal Actions (legacy modal buttons if present)
        const assignModalClose = document.getElementById('assign-modal-close');
        const assignModalCancel = document.getElementById('assign-modal-cancel');
        const assignModalOverlay = document.getElementById('assign-project-overlay');
        const closeAssignModal = () => {
            if (assignModalOverlay) assignModalOverlay.style.display = 'none';
        };
        if (assignModalClose) assignModalClose.addEventListener('click', closeAssignModal);
        if (assignModalCancel) assignModalCancel.addEventListener('click', closeAssignModal);

        // Global Escape Key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeProjModal();
                closeAssignModal();
                this.hideContextMenu();
                this.hideProjectFlyout();
            }
        });
    }

    /**
     * Open Create / Edit Project Modal Dialog
     */
    openProjectModal(existingProject = null, initialName = '') {
        const overlay = document.getElementById('project-modal-overlay');
        const heading = document.getElementById('project-modal-title');
        const idInput = document.getElementById('project-form-id');
        const nameInput = document.getElementById('project-form-name');
        const colorInput = document.getElementById('project-form-color');
        const iconInput = document.getElementById('project-form-icon');
        const descInput = document.getElementById('project-form-desc');
        const colorContainer = document.getElementById('project-color-presets');
        const iconContainer = document.getElementById('project-icon-presets');

        if (!overlay) return;

        if (existingProject) {
            if (heading) heading.textContent = 'Edit Tag';
            if (idInput) idInput.value = existingProject.id;
            if (nameInput) nameInput.value = existingProject.name || '';
            if (colorInput) colorInput.value = existingProject.color || '#3b82f6';
            if (iconInput) iconInput.value = existingProject.icon || '📁';
            if (descInput) descInput.value = existingProject.description || '';

            if (colorContainer) {
                colorContainer.querySelectorAll('.color-preset-btn').forEach(btn => {
                    btn.classList.toggle('selected', btn.dataset.color === existingProject.color);
                });
            }
            if (iconContainer) {
                iconContainer.querySelectorAll('.icon-preset-btn').forEach(btn => {
                    btn.classList.toggle('selected', btn.dataset.icon === existingProject.icon);
                });
            }
        } else {
            if (heading) heading.textContent = 'Create New Tag';
            if (idInput) idInput.value = '';
            if (nameInput) nameInput.value = initialName || '';
            const randomColor = this.colorPresets[Math.floor(Math.random() * this.colorPresets.length)];
            if (colorInput) colorInput.value = randomColor;
            if (iconInput) iconInput.value = '📁';
            if (descInput) descInput.value = '';

            if (colorContainer) {
                colorContainer.querySelectorAll('.color-preset-btn').forEach((btn) => {
                    btn.classList.toggle('selected', btn.dataset.color === randomColor);
                });
            }
            if (iconContainer) {
                iconContainer.querySelectorAll('.icon-preset-btn').forEach((btn, i) => {
                    btn.classList.toggle('selected', i === 0);
                });
            }
        }

        overlay.style.display = 'flex';
        setTimeout(() => {
            if (nameInput) nameInput.focus();
        }, 50);
    }

    /**
     * Setup Rename Conversation Modal
     */
    setupRenameModal() {
        const overlay = document.getElementById('rename-modal-overlay');
        const closeBtn = document.getElementById('rename-modal-close');
        const cancelBtn = document.getElementById('rename-modal-cancel');
        const saveBtn = document.getElementById('rename-modal-save');
        const restoreBtn = document.getElementById('rename-btn-restore');
        const titleInput = document.getElementById('rename-input-title');
        const idInput = document.getElementById('rename-conv-id');
        const originalText = document.getElementById('rename-original-text');

        const closeModal = () => {
            if (overlay) overlay.style.display = 'none';
        };

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeModal();
            });
        }

        if (restoreBtn) {
            restoreBtn.addEventListener('click', () => {
                const orig = originalText ? originalText.textContent : '';
                if (titleInput && orig) {
                    titleInput.value = orig;
                    titleInput.focus();
                    titleInput.select();
                }
            });
        }

        const handleSave = () => {
            const convId = idInput ? idInput.value : null;
            const newTitle = titleInput ? titleInput.value.trim() : '';
            if (!convId) return;
            if (!newTitle) {
                titleInput?.focus();
                return;
            }
            closeModal();
            if (this.onRenameConversationCallback) {
                this.onRenameConversationCallback({ id: convId, title: newTitle });
            }
        };

        if (saveBtn) saveBtn.addEventListener('click', handleSave);
        if (titleInput) {
            titleInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    handleSave();
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    closeModal();
                }
            });
        }
    }

    /**
     * Open Rename Conversation Modal
     */
    openRenameModal(convId) {
        const conv = this.allConversations.find(c => c.id === convId);
        const overlay = document.getElementById('rename-modal-overlay');
        const idInput = document.getElementById('rename-conv-id');
        const titleInput = document.getElementById('rename-input-title');
        const originalHint = document.getElementById('rename-original-hint');
        const originalText = document.getElementById('rename-original-text');

        if (!overlay || !titleInput || !idInput) return;

        idInput.value = convId;
        const currentTitle = conv?.title || '';
        const originalTitle = conv?.original_title || conv?.title || '';

        titleInput.value = currentTitle;

        if (originalHint && originalText) {
            originalText.textContent = originalTitle;
            originalHint.style.display = 'block';
        }

        overlay.style.display = 'flex';
        setTimeout(() => {
            titleInput.focus();
            titleInput.select();
        }, 50);
    }

    /**
     * Setup Export Format Selection Modal
     */
    setupExportModal() {
        const overlay = document.getElementById('export-modal-overlay');
        const closeBtn = document.getElementById('export-modal-close');
        const cancelBtn = document.getElementById('export-modal-cancel');
        const confirmBtn = document.getElementById('export-modal-confirm');
        const optionMarkdown = document.getElementById('export-option-markdown');
        const optionJson = document.getElementById('export-option-json');

        const closeModal = () => {
            if (overlay) overlay.style.display = 'none';
            this.activeExportConversation = null;
            this.onExportModalCallback = null;
        };

        const selectFormat = (format) => {
            if (optionMarkdown && optionJson) {
                const isMd = (format === 'markdown');
                optionMarkdown.classList.toggle('selected', isMd);
                optionJson.classList.toggle('selected', !isMd);
                const mdRadio = optionMarkdown.querySelector('input[type="radio"]');
                const jsonRadio = optionJson.querySelector('input[type="radio"]');
                if (mdRadio) mdRadio.checked = isMd;
                if (jsonRadio) jsonRadio.checked = !isMd;
            }
        };

        if (optionMarkdown) {
            optionMarkdown.addEventListener('click', () => selectFormat('markdown'));
        }
        if (optionJson) {
            optionJson.addEventListener('click', () => selectFormat('json'));
        }

        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) closeModal();
            });
        }

        const handleConfirm = () => {
            const isMd = optionMarkdown ? optionMarkdown.classList.contains('selected') : true;
            const format = isMd ? 'markdown' : 'json';
            const conv = this.activeExportConversation;
            const cb = this.onExportModalCallback;
            closeModal();
            if (cb && conv) {
                cb(conv, format);
            }
        };

        if (confirmBtn) confirmBtn.addEventListener('click', handleConfirm);

        window.addEventListener('keydown', (e) => {
            if (overlay && overlay.style.display === 'flex') {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    closeModal();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    handleConfirm();
                }
            }
        });
    }

    /**
     * Open Export Format Selection Modal
     * @param {Object} conversation - Full conversation object
     * @param {Function} onExport - Callback function (conv, format) => {}
     */
    openExportModal(conversation, onExport) {
        if (!conversation) return;
        this.activeExportConversation = conversation;
        this.onExportModalCallback = onExport;

        const overlay = document.getElementById('export-modal-overlay');
        const titleEl = document.getElementById('export-modal-conv-title');
        const metaEl = document.getElementById('export-modal-conv-meta');
        const optionMarkdown = document.getElementById('export-option-markdown');
        const optionJson = document.getElementById('export-option-json');

        if (titleEl) {
            titleEl.textContent = conversation.custom_title || conversation.title || 'Untitled Conversation';
        }

        if (metaEl) {
            const rawMessages = conversation.active_branch || conversation.messages || [];
            const msgCount = Array.isArray(rawMessages) ? rawMessages.length : 0;
            const fmt = (conversation.format || 'openai').toUpperCase();
            metaEl.textContent = `${msgCount} messages • ${fmt}`;
        }

        // Default select markdown
        if (optionMarkdown && optionJson) {
            optionMarkdown.classList.add('selected');
            optionJson.classList.remove('selected');
            const mdRadio = optionMarkdown.querySelector('input[type="radio"]');
            const jsonRadio = optionJson.querySelector('input[type="radio"]');
            if (mdRadio) mdRadio.checked = true;
            if (jsonRadio) jsonRadio.checked = false;
        }

        if (overlay) {
            overlay.style.display = 'flex';
            const confirmBtn = document.getElementById('export-modal-confirm');
            if (confirmBtn) confirmBtn.focus();
        }
    }

    /**
     * Setup Floating Context Menu & Handlers
     */
    setupContextMenu() {
        const menu = document.getElementById('conv-context-menu');
        const submenuTrigger = document.getElementById('ctx-projects-submenu-trigger');
        const starBtn = document.getElementById('ctx-star');
        const renameBtn = document.getElementById('ctx-rename');
        const copyTitleBtn = document.getElementById('ctx-copy-title');
        const exportBtn = document.getElementById('ctx-export');
        const deleteBtn = document.getElementById('ctx-delete');

        if (submenuTrigger) {
            submenuTrigger.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.activeContextConvId) {
                    this.showProjectFlyout(submenuTrigger, this.activeContextConvId);
                }
            });

            submenuTrigger.addEventListener('mouseenter', () => {
                if (this.activeContextConvId) {
                    this.showProjectFlyout(submenuTrigger, this.activeContextConvId);
                }
            });
        }

        if (starBtn) {
            starBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = this.activeContextConvId;
                this.hideContextMenu();
                if (targetId && this.onToggleStarCallback) {
                    const conv = this.allConversations.find(c => c.id === targetId);
                    this.onToggleStarCallback(targetId, !(conv && conv.is_starred));
                }
            });
        }

        if (renameBtn) {
            renameBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = this.activeContextConvId;
                this.hideContextMenu();
                if (targetId) {
                    this.openRenameModal(targetId);
                }
            });
        }

        if (copyTitleBtn) {
            copyTitleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = this.activeContextConvId;
                this.hideContextMenu();
                if (targetId) {
                    const conv = this.allConversations.find(c => c.id === targetId);
                    if (conv && conv.title) {
                        navigator.clipboard.writeText(conv.title).then(() => {
                            this.showToast('Copied title to clipboard');
                        }).catch(() => {});
                    }
                }
            });
        }

        if (exportBtn) {
            exportBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = this.activeContextConvId;
                this.hideContextMenu();
                if (targetId && this.onExportConversationCallback) {
                    this.onExportConversationCallback(targetId);
                }
            });
        }

        if (deleteBtn) {
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const targetId = this.activeContextConvId;
                this.hideContextMenu();
                if (targetId && this.onDeleteConversationCallback) {
                    const conv = this.allConversations.find(c => c.id === targetId);
                    const title = conv ? `"${conv.title || 'Untitled'}"` : 'this conversation';
                    if (confirm(`Are you sure you want to delete ${title}?`)) {
                        this.onDeleteConversationCallback(targetId);
                    }
                }
            });
        }

        // Close on outside click
        document.addEventListener('click', (e) => {
            const flyout = document.getElementById('project-flyout-popover');
            const clickedInsideMenu = menu && menu.contains(e.target);
            const clickedInsideFlyout = flyout && flyout.contains(e.target);

            if (!clickedInsideMenu && !clickedInsideFlyout) {
                this.hideContextMenu();
                this.hideProjectFlyout();
            }
        });
        window.addEventListener('blur', () => {
            this.hideContextMenu();
            this.hideProjectFlyout();
        });
        window.addEventListener('resize', () => {
            this.hideContextMenu();
            this.hideProjectFlyout();
        });
    }

    /**
     * Show Context Menu with Instant Top 5 Quick Tags
     */
    showContextMenu(x, y, conversationId) {
        const menu = document.getElementById('conv-context-menu');
        const recentStrip = document.getElementById('ctx-recent-tags-strip');
        if (!menu) return;

        this.activeContextConvId = conversationId;
        this.hideProjectFlyout();

        // Find currently assigned projects for this conversation
        const conv = this.allConversations.find(c => c.id === conversationId);
        const assignedIds = new Set((conv && conv.projects) ? conv.projects.map(p => p.id) : []);

        // Populate Top 5 Quick Tags Strip
        if (recentStrip) {
            recentStrip.innerHTML = '';
            const recents = this.getRecentProjects(5);

            if (recents.length === 0) {
                const emptyChip = document.createElement('button');
                emptyChip.type = 'button';
                emptyChip.className = 'ctx-tag-pill empty-new-pill';
                emptyChip.innerHTML = `<span>+ New Tag</span>`;
                emptyChip.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.hideContextMenu();
                    this.openProjectModal();
                });
                recentStrip.appendChild(emptyChip);
            } else {
                recents.forEach(proj => {
                    const isAssigned = assignedIds.has(proj.id);
                    const pill = document.createElement('button');
                    pill.type = 'button';
                    pill.className = `ctx-tag-pill ${isAssigned ? 'active' : ''}`;
                    const color = proj.color || '#3b82f6';
                    pill.style.setProperty('--pill-color', color);

                    pill.innerHTML = `
                        <span class="pill-check-indicator">${isAssigned ? '✓' : ''}</span>
                        <span class="pill-icon">${proj.icon || '📁'}</span>
                        <span class="pill-name">${this.escapeHtml(proj.name)}</span>
                    `;

                    pill.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.toggleProjectOnConversation(conversationId, proj.id);
                        // Update pill active state instantly
                        const nowAssigned = !isAssigned;
                        pill.classList.toggle('active', nowAssigned);
                        pill.querySelector('.pill-check-indicator').textContent = nowAssigned ? '✓' : '';
                        this.showToast(nowAssigned ? `Tagged "${proj.name}"` : `Removed "${proj.name}"`);
                    });

                    recentStrip.appendChild(pill);
                });
            }
        }

        // Update star icon & label in context menu
        const starIcon = document.getElementById('ctx-star-icon');
        const starLabel = document.getElementById('ctx-star-label');
        if (starIcon && starLabel) {
            if (conv && conv.is_starred) {
                starIcon.textContent = '⭐';
                starLabel.textContent = 'Unstar Chat';
            } else {
                starIcon.textContent = '☆';
                starLabel.textContent = 'Star Chat';
            }
        }

        menu.style.display = 'flex';

        const menuRect = menu.getBoundingClientRect();
        let left = x;
        let top = y;

        if (left + menuRect.width > window.innerWidth - 8) {
            left = window.innerWidth - menuRect.width - 8;
        }
        if (top + menuRect.height > window.innerHeight - 8) {
            top = window.innerHeight - menuRect.height - 8;
        }

        menu.style.left = `${Math.max(8, left)}px`;
        menu.style.top = `${Math.max(8, top)}px`;
    }

    /**
     * Hide Context Menu
     */
    hideContextMenu() {
        const menu = document.getElementById('conv-context-menu');
        if (menu) menu.style.display = 'none';
    }

    /**
     * Setup Floating Project Flyout Popover
     */
    setupProjectFlyout() {
        const searchInput = document.getElementById('flyout-search-input');
        const createBtn = document.getElementById('flyout-btn-create');

        if (searchInput) {
            searchInput.addEventListener('input', () => {
                const query = searchInput.value.trim();
                this.renderFlyoutProjectsList(query);
            });

            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const query = searchInput.value.trim();
                    if (query) {
                        this.handleQuickCreateAndAssign(query);
                    }
                }
            });
        }

        if (createBtn) {
            createBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const query = searchInput ? searchInput.value.trim() : '';
                if (query) {
                    this.handleQuickCreateAndAssign(query);
                } else {
                    this.hideProjectFlyout();
                    this.hideContextMenu();
                    this.openProjectModal();
                }
            });
        }
    }

    /**
     * Show Project Tagging Flyout (Searchable List)
     */
    showProjectFlyout(anchorElementOrPos, targetConvIds) {
        const flyout = document.getElementById('project-flyout-popover');
        const searchInput = document.getElementById('flyout-search-input');
        if (!flyout) return;

        this.flyoutTargetConvIds = Array.isArray(targetConvIds) ? targetConvIds : [targetConvIds];

        if (searchInput) {
            searchInput.value = '';
        }

        this.renderFlyoutProjectsList('');

        flyout.style.display = 'flex';

        // Position flyout
        let left = 0;
        let top = 0;

        if (anchorElementOrPos instanceof HTMLElement) {
            const rect = anchorElementOrPos.getBoundingClientRect();
            // If anchored to context menu trigger row
            if (anchorElementOrPos.id === 'ctx-projects-submenu-trigger') {
                left = rect.right + 4;
                top = rect.top - 6;
                if (left + 240 > window.innerWidth) {
                    left = rect.left - 244;
                }
            } else {
                // Anchored to a card button
                left = rect.left;
                top = rect.bottom + 6;
            }
        } else if (anchorElementOrPos && typeof anchorElementOrPos.x === 'number') {
            left = anchorElementOrPos.x;
            top = anchorElementOrPos.y;
        }

        const flyoutRect = flyout.getBoundingClientRect();
        if (left + flyoutRect.width > window.innerWidth - 8) {
            left = window.innerWidth - flyoutRect.width - 8;
        }
        if (top + flyoutRect.height > window.innerHeight - 8) {
            top = window.innerHeight - flyoutRect.height - 8;
        }

        flyout.style.left = `${Math.max(8, left)}px`;
        flyout.style.top = `${Math.max(8, top)}px`;

        setTimeout(() => {
            if (searchInput) searchInput.focus();
        }, 50);
    }

    /**
     * Hide Project Flyout
     */
    hideProjectFlyout() {
        const flyout = document.getElementById('project-flyout-popover');
        if (flyout) flyout.style.display = 'none';
        this.flyoutTargetConvIds = null;
    }

    /**
     * Render items in Flyout Popover list
     */
    renderFlyoutProjectsList(query = '') {
        const list = document.getElementById('flyout-projects-list');
        const createLabel = document.getElementById('flyout-create-label');
        if (!list) return;

        list.innerHTML = '';
        const q = query.toLowerCase().trim();

        // Find active project IDs for targeted conversation(s)
        const targetIds = this.flyoutTargetConvIds || [];
        let assignedIds = new Set();

        if (targetIds.length === 1) {
            const conv = this.allConversations.find(c => c.id === targetIds[0]);
            if (conv && conv.projects) {
                conv.projects.forEach(p => assignedIds.add(p.id));
            }
        }

        const filtered = this.projects.filter(p => {
            if (!q) return true;
            return (p.name || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q);
        });

        const exactMatch = this.projects.some(p => (p.name || '').toLowerCase() === q);

        if (createLabel) {
            if (q && !exactMatch) {
                createLabel.textContent = `Create tag "${query}"`;
            } else {
                createLabel.textContent = `New Project...`;
            }
        }

        if (filtered.length === 0) {
            const emptyNotice = document.createElement('div');
            emptyNotice.className = 'flyout-empty-notice';
            emptyNotice.textContent = q ? `No matching tags found` : `No projects yet`;
            list.appendChild(emptyNotice);
            return;
        }

        filtered.forEach(proj => {
            const isAssigned = assignedIds.has(proj.id);
            const item = document.createElement('div');
            item.className = `flyout-item ${isAssigned ? 'checked' : ''}`;
            const color = proj.color || '#3b82f6';

            item.innerHTML = `
                <div class="flyout-item-left">
                    <span class="flyout-item-check">${isAssigned ? '✓' : ''}</span>
                    <span class="flyout-item-dot" style="background-color: ${color};"></span>
                    <span class="flyout-item-icon">${proj.icon || '📁'}</span>
                    <span class="flyout-item-name">${this.escapeHtml(proj.name)}</span>
                </div>
                <span class="flyout-item-count">${proj.conversation_count || 0}</span>
            `;

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                if (targetIds.length === 1) {
                    this.toggleProjectOnConversation(targetIds[0], proj.id);
                    const nowChecked = !isAssigned;
                    item.classList.toggle('checked', nowChecked);
                    item.querySelector('.flyout-item-check').textContent = nowChecked ? '✓' : '';
                    this.showToast(nowChecked ? `Tagged "${proj.name}"` : `Removed "${proj.name}"`);
                } else if (targetIds.length > 1) {
                    if (this.onBatchAssignProjectsCallback) {
                        this.onBatchAssignProjectsCallback(targetIds, [proj.id]);
                        this.hideProjectFlyout();
                    }
                }
            });

            list.appendChild(item);
        });
    }

    /**
     * Handle Quick Create Tag from Flyout Input
     */
    async handleQuickCreateAndAssign(name) {
        if (!name.trim()) return;
        const targetIds = this.flyoutTargetConvIds || [];
        const randomColor = this.colorPresets[Math.floor(Math.random() * this.colorPresets.length)];
        const projectData = {
            name: name.trim(),
            color: randomColor,
            icon: '📁',
            description: ''
        };

        this.hideProjectFlyout();
        this.hideContextMenu();

        if (this.onCreateProjectCallback) {
            const newProj = await this.onCreateProjectCallback(projectData);
            if (newProj && newProj.id && targetIds.length > 0) {
                this.markProjectAsRecent(newProj.id);
                if (targetIds.length === 1) {
                    this.toggleProjectOnConversation(targetIds[0], newProj.id, true);
                } else {
                    if (this.onBatchAssignProjectsCallback) {
                        this.onBatchAssignProjectsCallback(targetIds, [newProj.id]);
                    }
                }
            }
        }
    }

    /**
     * Toggle a project assignment on a single conversation with optimistic updates
     */
    toggleProjectOnConversation(convId, projectId, forceAdd = false) {
        const conv = this.allConversations.find(c => c.id === convId);
        if (!conv) return;

        let currentProjects = conv.projects ? [...conv.projects] : [];
        const exists = currentProjects.some(p => p.id === projectId);

        if (exists && !forceAdd) {
            currentProjects = currentProjects.filter(p => p.id !== projectId);
        } else if (!exists) {
            const projObj = this.projects.find(p => p.id === projectId) || { id: projectId, name: 'Project', color: '#3b82f6', icon: '📁' };
            currentProjects.push(projObj);
        }

        // Optimistic update
        conv.projects = currentProjects;
        this.markProjectAsRecent(projectId);

        // Update conversation card chips in DOM in-place
        this.updateCardProjectChips(convId, currentProjects);

        // Notify backend / storage
        const projectIds = currentProjects.map(p => p.id);
        if (this.onAssignProjectsCallback) {
            this.onAssignProjectsCallback(convId, projectIds);
        }
    }

    /**
     * Update project chips on a specific card in DOM in real-time
     */
    updateCardProjectChips(conversationId, projects) {
        const card = this.container.querySelector(`.conv-card[data-conversation-id="${conversationId}"]`);
        if (!card) return;

        let chipsWrap = card.querySelector('.conv-project-chips-wrap');
        if (!chipsWrap) {
            chipsWrap = document.createElement('div');
            chipsWrap.className = 'conv-project-chips-wrap';
            const meta = card.querySelector('.conv-card-meta');
            if (meta) meta.insertAdjacentElement('afterend', chipsWrap);
        }

        chipsWrap.innerHTML = '';

        if (projects && projects.length > 0) {
            projects.forEach(p => {
                const chip = document.createElement('span');
                chip.className = 'conv-project-chip';
                chip.dataset.projectId = p.id;
                chip.style.setProperty('--chip-color', p.color || '#3b82f6');
                chip.title = `Project: ${p.name}`;
                chip.innerHTML = `
                    <span class="chip-icon">${p.icon || '📁'}</span>
                    <span class="chip-label">${this.escapeHtml(p.name)}</span>
                `;
                chip.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.openProject(p.id);
                });
                chipsWrap.appendChild(chip);
            });
        }

        // Add `+ Tag` quick button
        const addTagBtn = document.createElement('button');
        addTagBtn.type = 'button';
        addTagBtn.className = 'btn-card-add-tag';
        addTagBtn.title = 'Add or manage tags';
        addTagBtn.innerHTML = `+ Tag`;
        addTagBtn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showProjectFlyout(addTagBtn, conversationId);
        });
        chipsWrap.appendChild(addTagBtn);
    }

    /**
     * Update project list data and counts
     */
    setProjects(projects) {
        this.projects = [...(projects || [])].sort((a, b) => {
            const countA = a.conversation_count || 0;
            const countB = b.conversation_count || 0;
            if (countA !== countB) return countB - countA;
            return (a.name || '').localeCompare(b.name || '');
        });
        const countBadge = document.getElementById('tab-projects-count');
        if (countBadge) {
            countBadge.textContent = String(this.projects.length);
        }
        if (this.currentView === 'projects') {
            this.renderProjectsOverview();
        }
    }

    /**
     * Render sidebar based on current view
     */
    render(conversations, total = null, projects = null, starredCount = null, allChatsCount = null) {
        this.isLoadingMore = false;
        if (projects) {
            this.setProjects(projects);
        }

        // Store all conversations for current view
        this.allConversations = conversations || [];
        this.totalConversations = total !== null ? total : this.allConversations.length;

        if (starredCount !== null && starredCount !== undefined) {
            this.starredConversationsCount = starredCount;
        } else if (this.allConversations) {
            this.starredConversationsCount = this.allConversations.filter(c => c.is_starred).length;
        }

        if (allChatsCount !== null && allChatsCount !== undefined) {
            this.totalAllChatsCount = allChatsCount;
        } else if (this.currentView === 'chats' && !this.searchQuery) {
            this.totalAllChatsCount = this.totalConversations;
        }

        // Update count pills
        const countBadge = document.getElementById('conv-count-badge');
        const tabChatsCount = document.getElementById('tab-chats-count');
        const tabProjCount = document.getElementById('tab-projects-count');

        if (countBadge) countBadge.textContent = String(this.totalConversations);
        if (tabChatsCount) tabChatsCount.textContent = String(this.totalAllChatsCount || this.totalConversations);
        if (tabProjCount) tabProjCount.textContent = String(this.projects.length);

        if (this.currentView === 'projects') {
            this.renderProjectsOverview();
        } else if (this.currentView === 'project-detail') {
            this.renderProjectDetail();
        } else {
            this.renderConversationsList();
        }
    }

    /**
     * Render the list of conversations for 'All Chats' view
     */
    renderConversationsList() {
        if (!this.allConversations || this.allConversations.length === 0) {
            this.renderEmpty();
            return;
        }

        // Filter based on search query if client-side fallback
        let filtered = this.allConversations;
        if (this.searchQuery && !this.onSearchChangeCallback) {
            filtered = this.allConversations.filter(conv => this.matchesSearch(conv));
        }

        // Sort conversations
        const sorted = [...filtered].sort((a, b) => {
            if (this.sortBy === 'messages') {
                const countA = this.getConversationMessageCount(a);
                const countB = this.getConversationMessageCount(b);
                if (countA !== countB) {
                    return this.sortOrder === 'asc' ? countA - countB : countB - countA;
                }
            }
            const dateA = this.getConversationDate(a);
            const dateB = this.getConversationDate(b);
            return this.sortOrder === 'asc' ? dateA - dateB : dateB - dateA;
        });

        this.container.innerHTML = '';

        if (sorted.length === 0) {
            this.renderNoResults();
            return;
        }

        const listWrap = document.createElement('div');
        listWrap.className = 'conv-list-wrap';

        sorted.forEach(conv => {
            const item = this.createConversationItem(conv);
            listWrap.appendChild(item);
        });

        this.container.appendChild(listWrap);

        // Append Load More button if applicable
        if (this.allConversations.length < this.totalConversations) {
            this.appendLoadMoreButton();
        }
    }

    /**
     * Render Tags Directory (Level 1 overview)
     */
    renderProjectsOverview() {
        this.container.innerHTML = '';

        const projectsWrap = document.createElement('div');
        projectsWrap.className = 'projects-overview-wrap';

        // Toolbar with "+ New Tag" button
        const toolbar = document.createElement('div');
        toolbar.className = 'projects-toolbar';
        toolbar.innerHTML = `
            <div class="d-flex justify-content-between align-items-center mb-2">
                <span class="projects-section-title">TAGS</span>
                <button type="button" id="btn-create-new-project" class="btn-create-project-primary" title="Create a new tag">
                    <span>+ New Tag</span>
                </button>
            </div>
        `;

        toolbar.querySelector('#btn-create-new-project').addEventListener('click', () => {
            this.openProjectModal();
        });

        projectsWrap.appendChild(toolbar);

        const list = document.createElement('div');
        list.className = 'projects-cards-list';

        // 1. Permanently Pinned Starred System Tag Card at Index 0
        const starredCount = (this.starredConversationsCount !== undefined && this.starredConversationsCount !== null) ?
            this.starredConversationsCount :
            (this.allConversations ? this.allConversations.filter(c => c.is_starred).length : 0);

        const starredCard = document.createElement('div');
        starredCard.className = 'project-card starred-pinned-card';
        starredCard.dataset.projectId = 'starred';
        starredCard.innerHTML = `
            <div class="project-card-main">
                <div class="project-card-left">
                    <span class="project-avatar starred-pinned-avatar" style="background-color: rgba(245, 158, 11, 0.18); color: #f59e0b; border-color: rgba(245, 158, 11, 0.45);">
                        ⭐
                    </span>
                    <div class="project-info-block">
                        <div class="d-flex align-items-center gap-2">
                            <h6 class="project-card-name text-warning-emphasis">Starred</h6>
                            <span class="badge rounded-pill bg-warning-subtle text-warning" style="font-size: 0.65rem; padding: 2px 6px; border: 1px solid rgba(245, 158, 11, 0.3);">PINNED</span>
                        </div>
                        <span class="project-card-count">${starredCount} chat${starredCount === 1 ? '' : 's'}</span>
                    </div>
                </div>
                <div class="project-card-actions">
                    <span class="text-muted small me-2" style="font-size: 0.8rem;">Favorite chats</span>
                </div>
            </div>
        `;
        starredCard.addEventListener('click', () => {
            this.openProject('starred');
        });
        list.appendChild(starredCard);

        // 2. Sort User Tags by conversation count descending
        const sortedProjects = [...(this.projects || [])].sort((a, b) => {
            const countA = a.conversation_count || 0;
            const countB = b.conversation_count || 0;
            if (countA !== countB) return countB - countA;
            return (a.name || '').localeCompare(b.name || '');
        });

        sortedProjects.forEach(proj => {
            const card = document.createElement('div');
            card.className = 'project-card';
            card.dataset.projectId = proj.id;

            const color = proj.color || '#3b82f6';
            const icon = proj.icon || '📁';
            const count = proj.conversation_count || 0;
            const desc = proj.description ? `<p class="project-card-desc">${this.escapeHtml(proj.description)}</p>` : '';

            card.innerHTML = `
                <div class="project-card-main">
                    <div class="project-card-left">
                        <span class="project-avatar" style="background-color: ${color}20; color: ${color}; border-color: ${color}50;">
                            ${icon}
                        </span>
                        <div class="project-info-block">
                            <h6 class="project-card-name">${this.escapeHtml(proj.name)}</h6>
                            <span class="project-card-count">${count} chat${count === 1 ? '' : 's'}</span>
                            ${desc}
                        </div>
                    </div>
                    <div class="project-card-actions">
                        <button type="button" class="project-action-btn edit-proj-btn" title="Edit tag" onclick="event.stopPropagation()">
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                                <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.5-.5V10h-.5a.5.5 0 0 1-.175-.032z"/>
                            </svg>
                        </button>
                        <button type="button" class="project-action-btn delete-proj-btn text-danger" title="Delete tag" onclick="event.stopPropagation()">
                            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                                <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
                                <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                            </svg>
                        </button>
                    </div>
                </div>
            `;

            // Click card to open scoped view
            card.addEventListener('click', () => {
                this.openProject(proj.id);
            });

            // Edit button handler
            const editBtn = card.querySelector('.edit-proj-btn');
            if (editBtn) {
                editBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.openProjectModal(proj);
                });
            }

            // Delete button handler
            const deleteBtn = card.querySelector('.delete-proj-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete tag "${proj.name}"?\n(Conversations with this tag will NOT be deleted).`)) {
                        if (this.onDeleteProjectCallback) {
                            this.onDeleteProjectCallback(proj.id);
                        }
                    }
                });
            }

            list.appendChild(card);
        });

        projectsWrap.appendChild(list);
        this.container.appendChild(projectsWrap);
    }

    /**
     * Render Scoped Tag Detail View (Level 2)
     */
    renderProjectDetail() {
        this.container.innerHTML = '';

        const isStarred = this.currentProjectId === 'starred';
        const starredCount = (this.starredConversationsCount !== undefined && this.starredConversationsCount !== null) ?
            this.starredConversationsCount :
            (this.allConversations ? this.allConversations.filter(c => c.is_starred).length : 0);

        const currentProj = isStarred ? {
            id: 'starred',
            name: 'Starred',
            color: '#f59e0b',
            icon: '⭐',
            conversation_count: starredCount
        } : (this.projects.find(p => p.id === this.currentProjectId) || {
            id: this.currentProjectId,
            name: 'Tag',
            color: '#3b82f6',
            icon: '🏷️',
            conversation_count: 0
        });

        const headerWrap = document.createElement('div');
        headerWrap.className = 'scoped-project-header';
        const color = currentProj.color || '#3b82f6';

        headerWrap.innerHTML = `
            <div class="scoped-project-nav-row">
                <button type="button" id="btn-back-to-projects" class="btn-back-projects" title="Back to all tags">
                    <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                        <path fill-rule="evenodd" d="M15 8a.5.5 0 0 0-.5-.5H2.707l3.147-3.146a.5.5 0 1 0-.708-.708l-4 4a.5.5 0 0 0 0 .708l4 4a.5.5 0 0 0 .708-.708L2.707 8.5H14.5A.5.5 0 0 0 15 8z"/>
                    </svg>
                    <span>All Tags</span>
                </button>
                <div class="scoped-project-actions">
                    ${isStarred ? '' : `
                    <button type="button" id="scoped-edit-btn" class="project-action-btn" title="Edit this tag">
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                            <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5z"/>
                        </svg>
                    </button>
                    `}
                </div>
            </div>
            <div class="scoped-project-title-row">
                <span class="project-avatar" style="background-color: ${color}20; color: ${color}; border-color: ${color}50;">
                    ${currentProj.icon || '🏷️'}
                </span>
                <div class="scoped-title-meta">
                    <h5 class="scoped-project-name">${this.escapeHtml(currentProj.name)}</h5>
                    <span class="scoped-project-badge">${this.totalConversations} conversation${this.totalConversations === 1 ? '' : 's'}</span>
                </div>
            </div>
        `;

        headerWrap.querySelector('#btn-back-to-projects').addEventListener('click', () => {
            this.setView('projects');
        });

        const editBtn = headerWrap.querySelector('#scoped-edit-btn');
        if (editBtn) {
            editBtn.addEventListener('click', () => {
                this.openProjectModal(currentProj);
            });
        }

        this.container.appendChild(headerWrap);

        // Render conversations list inside this project
        if (!this.allConversations || this.allConversations.length === 0) {
            const emptyWrap = document.createElement('div');
            emptyWrap.className = 'empty-state text-center p-4';
            if (isStarred) {
                emptyWrap.innerHTML = `
                    <div class="empty-state-icon mb-2">⭐</div>
                    <h6 class="empty-state-title">No starred chats yet</h6>
                    <p class="empty-state-subtitle text-muted mb-3">Click the star button on any conversation to add it to your favorites.</p>
                    <button type="button" id="btn-browse-all-chats" class="btn-primary-compact">Browse All Chats</button>
                `;
            } else {
                emptyWrap.innerHTML = `
                    <div class="empty-state-icon mb-2">🏷️</div>
                    <h6 class="empty-state-title">No chats with this tag</h6>
                    <p class="empty-state-subtitle text-muted mb-3">Right-click any chat in "All Chats" or click "+ Tag" on the card to add it here.</p>
                    <button type="button" id="btn-browse-all-chats" class="btn-primary-compact">Browse All Chats</button>
                `;
            }
            emptyWrap.querySelector('#btn-browse-all-chats').addEventListener('click', () => {
                this.setView('chats');
            });
            this.container.appendChild(emptyWrap);
            return;
        }

        const listWrap = document.createElement('div');
        listWrap.className = 'conv-list-wrap';

        this.allConversations.forEach(conv => {
            const item = this.createConversationItem(conv);
            listWrap.appendChild(item);
        });

        this.container.appendChild(listWrap);

        if (this.allConversations.length < this.totalConversations) {
            this.appendLoadMoreButton();
        }
    }

    /**
     * Append newly fetched conversations to existing list
     */
    appendConversations(newConversations, total = null) {
        this.isLoadingMore = false;
        if (total !== null) {
            this.totalConversations = total;
        }

        const existingIds = new Set(this.allConversations.map(c => c.id));
        const uniqueNew = (newConversations || []).filter(c => !existingIds.has(c.id));
        if (uniqueNew.length === 0) {
            this.isLoadingMore = false;
            const loadMoreWrap = this.container.querySelector('.load-more-wrap');
            if (loadMoreWrap) loadMoreWrap.remove();
            return;
        }

        this.allConversations = [...this.allConversations, ...uniqueNew];

        let listWrap = this.container.querySelector('.conv-list-wrap');
        if (!listWrap) {
            listWrap = document.createElement('div');
            listWrap.className = 'conv-list-wrap';
            this.container.innerHTML = '';
            this.container.appendChild(listWrap);
        }

        uniqueNew.forEach(conv => {
            const item = this.createConversationItem(conv);
            listWrap.appendChild(item);
        });

        // Update count badge
        const countBadge = document.getElementById('conv-count-badge');
        if (countBadge) {
            countBadge.textContent = String(this.totalConversations);
        }

        // Update or remove load more button
        const existingLoadMore = this.container.querySelector('.load-more-wrap');
        if (this.allConversations.length < this.totalConversations) {
            if (existingLoadMore) {
                const btn = existingLoadMore.querySelector('#load-more-btn');
                if (btn) {
                    btn.innerHTML = `Load More (${this.allConversations.length} of ${this.totalConversations})`;
                    btn.disabled = false;
                }
                this.container.appendChild(existingLoadMore);
            } else {
                this.appendLoadMoreButton();
            }
        } else if (existingLoadMore) {
            existingLoadMore.remove();
        }
    }

    /**
     * Append the Load More button at the bottom of the sidebar
     */
    appendLoadMoreButton() {
        const existing = this.container.querySelector('.load-more-wrap');
        if (existing) existing.remove();

        const loadMoreWrap = document.createElement('div');
        loadMoreWrap.className = 'load-more-wrap';
        loadMoreWrap.innerHTML = `
            <button id="load-more-btn" class="btn-load-more" type="button">
                Load More (${this.allConversations.length} of ${this.totalConversations})
            </button>
        `;

        const btn = loadMoreWrap.querySelector('#load-more-btn');
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            this.triggerLoadMore();
        });

        this.container.appendChild(loadMoreWrap);
    }

    /**
     * Trigger loading more conversations
     */
    triggerLoadMore() {
        if (this.isLoadingMore || !this.onLoadMoreCallback) return;
        if (this.totalConversations > 0 && this.allConversations.length >= this.totalConversations) return;

        this.isLoadingMore = true;
        const btn = this.container.querySelector('#load-more-btn');
        if (btn) {
            btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span> Loading...`;
            btn.disabled = true;
        }

        this.onLoadMoreCallback(this.allConversations.length, 100, this.currentProjectId);
    }

    /**
     * Create a conversation list item with project chips, add-tag button, and context menu triggers
     */
    createConversationItem(conversation) {
        const item = document.createElement('a');
        item.href = '#';
        item.className = 'conv-card';
        item.dataset.conversationId = conversation.id;

        if (conversation.id === this.currentConversationId) {
            item.classList.add('active');
        }

        // Format badge
        const formatBadge = this.getFormatBadge(conversation.format);

        // Date
        const dateVal = conversation.updated ?? conversation.updated_at ?? conversation.created ?? conversation.created_at;
        const dateStr = this.formatDate(dateVal);

        // Message count
        const messageCount = this.getConversationMessageCount(conversation);

        // Checkbox state
        const isChecked = this.selectedIds.has(conversation.id);
        const checkboxHtml = this.isSelectionMode ? `
            <input type="checkbox" class="form-check-input conversation-checkbox me-2 flex-shrink-0"
                   data-conversation-id="${conversation.id}"
                   ${isChecked ? 'checked' : ''}
                   onclick="event.stopPropagation()">
        ` : '';

        // Project chips HTML
        let projectChipsHtml = '';
        const chipsList = (conversation.projects || []).map(p => {
            const pColor = p.color || '#3b82f6';
            const pIcon = p.icon || '📁';
            return `
                <span class="conv-project-chip" 
                      data-project-id="${p.id}"
                      style="--chip-color: ${pColor};"
                      title="Project: ${this.escapeHtml(p.name)}">
                    <span class="chip-icon">${pIcon}</span>
                    <span class="chip-label">${this.escapeHtml(p.name)}</span>
                </span>
            `;
        }).join('');

        projectChipsHtml = `
            <div class="conv-project-chips-wrap">
                ${chipsList}
                <button type="button" class="btn-card-add-tag" title="Add or manage tags" onclick="event.stopPropagation()">+ Tag</button>
            </div>
        `;

        const snippetHtml = conversation.search_snippet ? `
            <div class="conv-card-snippet">${this.highlightMatches(conversation.search_snippet)}</div>
        ` : '';

        const isStarred = Boolean(conversation.is_starred);
        const starBtnHtml = `
            <button type="button" class="btn-card-star ${isStarred ? 'starred' : ''}" title="${isStarred ? 'Unstar conversation' : 'Star conversation'}" aria-label="Star" onclick="event.stopPropagation()">
                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="${isStarred ? '#f59e0b' : 'currentColor'}" viewBox="0 0 16 16">
                    ${isStarred ?
                        '<path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/>' :
                        '<path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767-3.686 1.894.694-3.957a.565.565 0 0 0-.163-.505L1.71 6.745l4.052-.576a.525.525 0 0 0 .393-.288L8 2.223l1.847 3.658a.525.525 0 0 0 .393.288l4.052.575-2.906 2.77a.565.565 0 0 0-.163.506l.694 3.957-3.686-1.895a.564.564 0 0 0-.532 0z"/>'
                    }
                </svg>
            </button>
        `;

        item.innerHTML = `
            <div class="d-flex w-100 align-items-start">
                ${checkboxHtml}
                <div class="flex-grow-1" style="min-width: 0;">
                    <div class="conv-card-header">
                        <h6 class="conv-card-title" title="${conversation.custom_title && conversation.original_title && conversation.custom_title !== conversation.original_title ? `Custom Title (Original: ${this.escapeHtml(conversation.original_title)})` : this.escapeHtml(conversation.title || 'Untitled')}">${this.highlightMatches(conversation.title || 'Untitled')}</h6>
                        <div class="conv-card-header-right">
                            ${formatBadge}
                            ${starBtnHtml}
                            <button type="button" class="btn-card-menu" title="Actions (or Right Click)" aria-label="Menu" onclick="event.stopPropagation()">
                                <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" fill="currentColor" viewBox="0 0 16 16">
                                    <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0zm0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="conv-card-meta">
                        <span class="meta-count-chip">${messageCount} message${messageCount === 1 ? '' : 's'}</span>
                        <span class="meta-date">${dateStr}</span>
                    </div>
                    ${projectChipsHtml}
                    ${snippetHtml}
                </div>
            </div>
        `;

        // Star button click handler
        const starBtn = item.querySelector('.btn-card-star');
        if (starBtn) {
            starBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (this.onToggleStarCallback) {
                    this.onToggleStarCallback(conversation.id, !conversation.is_starred);
                }
            });
        }

        // Click handler for selection
        item.addEventListener('click', (e) => {
            e.preventDefault();
            this.selectConversation(conversation.id);
        });

        // Right click handler -> context menu
        item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showContextMenu(e.clientX, e.clientY, conversation.id);
        });

        // 3-dot button click -> context menu
        const menuBtn = item.querySelector('.btn-card-menu');
        if (menuBtn) {
            menuBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = menuBtn.getBoundingClientRect();
                this.showContextMenu(rect.left, rect.bottom + 4, conversation.id);
            });
        }

        // Project chip click handler -> jump to that project
        item.querySelectorAll('.conv-project-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const pid = chip.dataset.projectId;
                if (pid) this.openProject(pid);
            });
        });

        // `+ Tag` button click handler -> open flyout tagging
        const addTagBtn = item.querySelector('.btn-card-add-tag');
        if (addTagBtn) {
            addTagBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showProjectFlyout(addTagBtn, conversation.id);
            });
        }

        // Checkbox handler
        const checkbox = item.querySelector('.conversation-checkbox');
        if (checkbox) {
            checkbox.addEventListener('change', (e) => {
                e.stopPropagation();
                if (e.target.checked) {
                    this.selectedIds.add(conversation.id);
                } else {
                    this.selectedIds.delete(conversation.id);
                }
                this.notifySelectionChange();
            });
        }

        return item;
    }

    /**
     * Select a conversation
     */
    selectConversation(conversationId) {
        this.currentConversationId = conversationId;

        // Update active state
        this.container.querySelectorAll('.conv-card').forEach(item => {
            if (item.dataset.conversationId === conversationId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        if (this.onSelectCallback) {
            this.onSelectCallback(conversationId);
        }
    }

    /**
     * Check if conversation matches search query
     */
    matchesSearch(conversation) {
        const query = (this.searchQuery || '').toLowerCase().trim();
        if (!query) return true;
        if (conversation.search_snippet) return true;

        const searchWords = query.split(/\s+/).filter(word => word.length > 0);
        const titleLower = (conversation.title || '').toLowerCase();
        if (searchWords.every(word => titleLower.includes(word))) {
            return true;
        }

        // Also search in project names
        if (conversation.projects && conversation.projects.some(p => searchWords.every(w => (p.name || '').toLowerCase().includes(w)))) {
            return true;
        }

        // Search in messages
        const msgs = conversation.messages || conversation.active_branch || [];
        if (msgs.length > 0) {
            return msgs.some(message => {
                const content = (message.content || '').toLowerCase();
                return searchWords.every(word => content.includes(word));
            });
        }

        return false;
    }

    /**
     * Render empty state
     */
    renderEmpty() {
        if (this.currentView === 'starred') {
            this.container.innerHTML = `
                <div class="empty-state text-center p-4">
                    <div class="empty-state-icon mb-3" style="font-size: 2rem;">
                        ⭐
                    </div>
                    <p class="empty-state-title">No Starred Chats Yet</p>
                    <p class="empty-state-subtitle">Click the star icon on any conversation to add it to your favorites</p>
                </div>
            `;
            return;
        }

        this.container.innerHTML = `
            <div class="empty-state text-center p-4">
                <div class="empty-state-icon mb-3">
                    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M14 1a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4.414A2 2 0 0 0 3 11.586l-2 2V2a1 1 0 0 1 1-1h12zM2 0a2 2 0 0 0-2 2v12.793a.5.5 0 0 0 .854.353l2.853-2.853A1 1 0 0 1 4.414 12H14a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2H2z"/>
                    </svg>
                </div>
                <p class="empty-state-title">No conversations loaded</p>
                <p class="empty-state-subtitle">Drop a .json or .zip export file here</p>
            </div>
        `;
    }

    /**
     * Render no search results state
     */
    renderNoResults() {
        this.container.innerHTML = `
            <div class="empty-state text-center p-4">
                <div class="empty-state-icon mb-3">
                    <svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" fill="currentColor" viewBox="0 0 16 16">
                        <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
                    </svg>
                </div>
                <p class="empty-state-title">No matching chats</p>
                <p class="empty-state-subtitle">Try a different search query</p>
            </div>
        `;
    }

    /**
     * Format badge HTML
     */
    getFormatBadge(format) {
        const f = (format || '').toLowerCase();
        if (f === 'openai') return '<span class="format-chip chip-openai">OpenAI</span>';
        if (f === 'claude') return '<span class="format-chip chip-claude">Claude</span>';
        if (f === 'zai') return '<span class="format-chip chip-zai">Z.ai</span>';
        return '<span class="format-chip chip-default">Chat</span>';
    }

    /**
     * Format date
     */
    formatDate(dateVal) {
        if (!dateVal) return '';
        let dateObj;
        if (dateVal instanceof Date) {
            dateObj = dateVal;
        } else if (typeof dateVal === 'number') {
            dateObj = new Date(dateVal < 10000000000 ? dateVal * 1000 : dateVal);
        } else {
            dateObj = new Date(dateVal);
        }

        if (isNaN(dateObj.getTime())) return '';

        return dateObj.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    /**
     * Extract epoch timestamp
     */
    getConversationDate(conv) {
        const val = conv.updated ?? conv.updated_at ?? conv.created ?? conv.created_at ?? 0;
        if (val instanceof Date) return val.getTime();
        if (typeof val === 'number') return val < 10000000000 ? val * 1000 : val;
        const parsed = new Date(val).getTime();
        return isNaN(parsed) ? 0 : parsed;
    }

    /**
     * Extract visible message count
     */
    getConversationMessageCount(conv) {
        if (conv.message_count !== undefined && conv.message_count !== null) {
            return Number(conv.message_count) || 0;
        }
        if (Array.isArray(conv.active_branch)) {
            return conv.active_branch.length;
        }
        if (Array.isArray(conv.messages)) {
            return conv.messages.length;
        }
        return 0;
    }

    /**
     * Escape HTML
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }

    /**
     * Highlight search terms
     */
    highlightMatches(text) {
        if (!text) return '';
        const cleanText = String(text).replace(/<\/?mark[^>]*>/gi, '');
        if (!this.searchQuery) return this.escapeHtml(cleanText);

        const searchWords = this.searchQuery.toLowerCase().trim().split(/\s+/).filter(word => word.length > 0);
        if (searchWords.length === 0) return this.escapeHtml(cleanText);

        const pattern = new RegExp(`(${searchWords.map(w => this.escapeRegex(w)).join('|')})`, 'gi');
        const parts = cleanText.split(pattern);

        return parts.map(part => {
            if (!part) return '';
            if (searchWords.some(w => w.toLowerCase() === part.toLowerCase())) {
                return `<mark class="search-highlight">${this.escapeHtml(part)}</mark>`;
            }
            return this.escapeHtml(part);
        }).join('');
    }

    escapeRegex(str) {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Selection Management
     */
    getSelectedIds() {
        return Array.from(this.selectedIds);
    }

    clearSelection() {
        this.selectedIds.clear();
        this.updateSelectionUI();
        this.notifySelectionChange();
    }

    selectAll() {
        this.allConversations.forEach(conv => this.selectedIds.add(conv.id));
        this.updateSelectionUI();
        this.notifySelectionChange();
    }

    notifySelectionChange() {
        if (this.onSelectionChangeCallback) {
            this.onSelectionChangeCallback(this.getSelectedIds());
        }
    }

    updateSelectionUI() {
        this.container.querySelectorAll('.conversation-checkbox').forEach(checkbox => {
            const convId = checkbox.dataset.conversationId;
            checkbox.checked = this.selectedIds.has(convId);
        });
    }

    showToast(message) {
        const toast = document.createElement('div');
        toast.className = 'mini-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(() => toast.classList.add('visible'), 10);
        setTimeout(() => {
            toast.classList.remove('visible');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    // Callbacks registrations
    onSelect(callback) { this.onSelectCallback = callback; }
    onSelectionChange(callback) { this.onSelectionChangeCallback = callback; }
    onSortChange(callback) { this.onSortChangeCallback = callback; }
    onSearchChange(callback) { this.onSearchChangeCallback = callback; }
    onLoadMore(callback) { this.onLoadMoreCallback = callback; }
    onViewChange(callback) { this.onViewChangeCallback = callback; }
    onCreateProject(callback) { this.onCreateProjectCallback = callback; }
    onUpdateProject(callback) { this.onUpdateProjectCallback = callback; }
    onDeleteProject(callback) { this.onDeleteProjectCallback = callback; }
    onAssignProjects(callback) { this.onAssignProjectsCallback = callback; }
    onBatchAssignProjects(callback) { this.onBatchAssignProjectsCallback = callback; }
    onDeleteConversation(callback) { this.onDeleteConversationCallback = callback; }
    onExportConversation(callback) { this.onExportConversationCallback = callback; }
    onRenameConversation(callback) { this.onRenameConversationCallback = callback; }
    onToggleStar(callback) { this.onToggleStarCallback = callback; }
}
