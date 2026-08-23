/**
 * Main application entry point with local SQLite backend & client-side fallback
 */

import { FileHandler } from './utils/file-handler.js';
import { Storage } from './utils/storage.js';
import { Sidebar } from './ui/sidebar.js';
import { ChatView } from './ui/chat-view.js';
import { ThemeManager } from './ui/theme.js';
import { InsightsModal } from './ui/insights-modal.js';
import { ApiClient } from './utils/api-client.js';
import { exportConversations, exportConversationAsMarkdown, generateFilename } from './utils/export.js';
import { extractActiveBranch } from './parsers.js';

/**
 * Application State Manager
 */
class AppState {
    constructor() {
        this.conversations = [];
        this.projects = [];
        this.currentConversation = null;
        this.currentConversationId = null;
        this.activeProjectId = null;
        this.useBackend = false;
        this.listeners = {};
    }

    async addConversations(conversations, persist = true) {
        const existingIds = new Set(this.conversations.map(c => c.id));
        const newConversations = conversations.filter(c => !existingIds.has(c.id));

        this.conversations = [...this.conversations, ...newConversations];

        if (persist && !this.useBackend) {
            await Storage.saveConversations(this.conversations);
        }

        this.emit('conversations-updated', this.conversations);
        return newConversations.length;
    }

    replaceConversations(conversations) {
        this.conversations = conversations;
        this.emit('conversations-updated', this.conversations);
    }

    setProjects(projects) {
        this.projects = projects || [];
        this.emit('projects-updated', this.projects);
    }

    async selectConversation(id, leafNodeId = null) {
        this.currentConversationId = id;
        if (this.useBackend) {
            try {
                const fullConv = await ApiClient.getConversation(id, leafNodeId);
                this.currentConversation = fullConv;
                this.emit('conversation-selected', fullConv);
                return;
            } catch (err) {
                console.error('Error fetching conversation from backend:', err);
            }
        }
        
        const localConv = this.conversations.find(c => c.id === id) || null;
        if (localConv && localConv.mapping && leafNodeId) {
            localConv.active_branch = extractActiveBranch(localConv, leafNodeId);
        }
        this.currentConversation = localConv;
        this.emit('conversation-selected', localConv);
    }

    getCurrentConversation() {
        return this.currentConversation || this.conversations.find(c => c.id === this.currentConversationId) || null;
    }

    getConversations() {
        return this.conversations;
    }

    getProjects() {
        return this.projects;
    }

    on(event, callback) {
        if (!this.listeners[event]) {
            this.listeners[event] = [];
        }
        this.listeners[event].push(callback);
    }

    emit(event, data) {
        if (this.listeners[event]) {
            this.listeners[event].forEach(callback => callback(data));
        }
    }
}

/**
 * Main Application Class
 */
class App {
    constructor() {
        this.themeManager = new ThemeManager();
        this.state = new AppState();
        this.fileHandler = new FileHandler();
        this.sidebar = new Sidebar(document.getElementById('sidebar-content'));
        this.chatView = new ChatView(document.getElementById('chat-content'), {
            onSwitchBranch: async (convId, leafNodeId) => {
                await this.state.selectConversation(convId, leafNodeId);
            }
        });
        this.insightsModal = new InsightsModal({
            onSelectConversation: async (convId) => {
                if (this.sidebar.currentView !== 'chats') {
                    this.sidebar.setView('chats');
                }
                await this.state.selectConversation(convId);
                setTimeout(() => {
                    const card = document.querySelector(`.conv-card[data-conversation-id="${convId}"]`);
                    if (card) {
                        document.querySelectorAll('.conv-card').forEach(c => c.classList.remove('active'));
                        card.classList.add('active');
                        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }
                }, 100);
            }
        });

        this.init();
    }

    async init() {
        this.setupEventHandlers();

        // Check if local SQLite backend is active with retry loop for smooth startup
        let hasBackend = false;
        for (let attempt = 0; attempt < 15; attempt++) {
            hasBackend = await ApiClient.isBackendAvailable();
            if (hasBackend) break;
            await new Promise(r => setTimeout(r, 200));
        }

        if (hasBackend) {
            this.state.useBackend = true;
            console.log('Connected to local SQLite backend.');
            try {
                const [convData, projects] = await Promise.all([
                    ApiClient.getConversations('', 100, 0, this.sidebar.sortBy, this.sidebar.sortOrder),
                    ApiClient.getProjects()
                ]);

                this.state.setProjects(projects);
                this.sidebar.setProjects(projects);

                if (convData.conversations && convData.conversations.length > 0) {
                    this.state.conversations = convData.conversations;
                    this.sidebar.render(convData.conversations, convData.total, projects);
                    this.state.selectConversation(convData.conversations[0].id);
                    return;
                }
            } catch (err) {
                console.warn('Failed to load initial data from backend, falling back to local storage', err);
            }
        }

        // Fallback to URL parameter or browser IndexedDB
        const urlParams = new URLSearchParams(window.location.search);
        const importUrl = urlParams.get('url');

        if (importUrl) {
            const urlInput = document.getElementById('url-input');
            if (urlInput) {
                urlInput.value = importUrl;
                this.fileHandler.handleUrlLoad();
            }
        } else {
            const [savedConversations, savedProjects] = await Promise.all([
                Storage.loadConversations(),
                Storage.loadProjects()
            ]);

            this.state.setProjects(savedProjects);
            this.sidebar.setProjects(savedProjects);

            if (savedConversations.length > 0) {
                this.state.conversations = savedConversations;
                this.sidebar.render(savedConversations, savedConversations.length, savedProjects);
            }
        }
    }

    /**
     * Refresh conversation list for current view
     */
    async refreshCurrentView() {
        const isStarredView = (this.sidebar.currentView === 'starred' || this.sidebar.currentProjectId === 'starred');
        const filterProjectId = (this.sidebar.currentProjectId === 'starred') ? null : this.sidebar.currentProjectId;

        if (this.state.useBackend) {
            try {
                const [convData, projects, statsResp] = await Promise.all([
                    ApiClient.getConversations(
                        this.sidebar.searchQuery,
                        100,
                        0,
                        this.sidebar.sortBy,
                        this.sidebar.sortOrder,
                        filterProjectId,
                        isStarredView ? true : null
                    ),
                    ApiClient.getProjects(),
                    fetch(`${ApiClient.baseUrl}/api/stats`).then(r => r.json()).catch(() => null)
                ]);

                this.state.conversations = convData.conversations || [];
                this.state.setProjects(projects);
                const starredTotal = statsResp?.stats?.starred_conversations ?? (this.state.conversations ? this.state.conversations.filter(c => c.is_starred).length : 0);
                const allChatsTotal = statsResp?.stats?.total_conversations ?? convData.total;
                const viewTotal = convData.total;

                this.sidebar.render(convData.conversations, viewTotal, projects, starredTotal, allChatsTotal);
                return;
            } catch (err) {
                console.warn('Failed to refresh view from backend:', err);
            }
        }

        // Offline / client-side filtering
        let allConvs = this.state.getConversations();
        const starredTotal = allConvs.filter(c => c.is_starred).length;
        let convs = allConvs;
        if (isStarredView) {
            convs = convs.filter(c => c.is_starred);
        } else if (filterProjectId) {
            convs = convs.filter(c => c.projects && c.projects.some(p => p.id === filterProjectId));
        }
        this.sidebar.render(convs, convs.length, this.state.getProjects(), starredTotal, allConvs.length);
    }

    setupEventHandlers() {
        // View change (All Chats <-> Projects <-> Project Detail)
        this.sidebar.onViewChange(async (view, projectId) => {
            await this.refreshCurrentView();
        });

        // Create Project
        this.sidebar.onCreateProject(async (projectData) => {
            try {
                let newProj;
                if (this.state.useBackend) {
                    newProj = await ApiClient.createProject(projectData);
                    this.sidebar.showToast(`Created project "${newProj.name}"`);
                } else {
                    const projects = await Storage.loadProjects();
                    newProj = {
                        id: 'proj-' + Date.now(),
                        name: projectData.name,
                        color: projectData.color || '#3b82f6',
                        icon: projectData.icon || '📁',
                        description: projectData.description || '',
                        created_at: Date.now() / 1000,
                        updated_at: Date.now() / 1000,
                        conversation_count: 0
                    };
                    projects.push(newProj);
                    await Storage.saveProjects(projects);
                    this.sidebar.showToast(`Created project "${newProj.name}"`);
                }

                const updatedProjects = this.state.useBackend ? await ApiClient.getProjects() : await Storage.loadProjects();
                this.state.setProjects(updatedProjects);
                this.sidebar.setProjects(updatedProjects);
                await this.refreshCurrentView();
                return newProj;
            } catch (err) {
                this.fileHandler.showError(`Failed to create project: ${err.message}`);
                return null;
            }
        });

        // Update Project
        this.sidebar.onUpdateProject(async (projectId, projectData) => {
            try {
                if (this.state.useBackend) {
                    const updated = await ApiClient.updateProject(projectId, projectData);
                    this.sidebar.showToast(`Updated project "${updated.name}"`);
                } else {
                    let projects = await Storage.loadProjects();
                    projects = projects.map(p => p.id === projectId ? { ...p, ...projectData, updated_at: Date.now() / 1000 } : p);
                    await Storage.saveProjects(projects);
                    this.sidebar.showToast(`Updated project`);
                }
                const updatedProjects = this.state.useBackend ? await ApiClient.getProjects() : await Storage.loadProjects();
                this.state.setProjects(updatedProjects);
                this.sidebar.setProjects(updatedProjects);
                await this.refreshCurrentView();
            } catch (err) {
                this.fileHandler.showError(`Failed to update project: ${err.message}`);
            }
        });

        // Delete Project
        this.sidebar.onDeleteProject(async (projectId) => {
            try {
                if (this.state.useBackend) {
                    await ApiClient.deleteProject(projectId);
                    this.sidebar.showToast('Project deleted');
                } else {
                    let projects = await Storage.loadProjects();
                    projects = projects.filter(p => p.id !== projectId);
                    await Storage.saveProjects(projects);
                    // Remove from in-memory conversations
                    this.state.conversations.forEach(c => {
                        if (c.projects) c.projects = c.projects.filter(p => p.id !== projectId);
                    });
                    await Storage.saveConversations(this.state.conversations);
                    this.sidebar.showToast('Project deleted');
                }

                if (this.sidebar.currentProjectId === projectId) {
                    this.sidebar.setView('projects');
                } else {
                    await this.refreshCurrentView();
                }
            } catch (err) {
                this.fileHandler.showError(`Failed to delete project: ${err.message}`);
            }
        });

        // Assign Projects to a single conversation
        this.sidebar.onAssignProjects(async (convId, projectIds) => {
            try {
                if (this.state.useBackend) {
                    await ApiClient.setConversationProjects(convId, projectIds);
                    const projects = await ApiClient.getProjects();
                    this.state.setProjects(projects);
                    this.sidebar.setProjects(projects);
                } else {
                    const projects = this.state.getProjects();
                    const assignedObjs = projects.filter(p => projectIds.includes(p.id));
                    const conv = this.state.conversations.find(c => c.id === convId);
                    if (conv) {
                        conv.projects = assignedObjs;
                        await Storage.saveConversations(this.state.conversations);
                    }
                }
            } catch (err) {
                this.fileHandler.showError(`Failed to assign projects: ${err.message}`);
            }
        });

        // Batch Assign Projects to multiple conversations
        this.sidebar.onBatchAssignProjects(async (convIds, projectIds) => {
            try {
                if (this.state.useBackend) {
                    await ApiClient.batchAssignProjects(convIds, projectIds, []);
                    this.sidebar.showToast(`Assigned ${convIds.length} chat(s) to project(s)`);
                } else {
                    const projects = this.state.getProjects();
                    const assignedObjs = projects.filter(p => projectIds.includes(p.id));
                    this.state.conversations.forEach(conv => {
                        if (convIds.includes(conv.id)) {
                            const existing = conv.projects || [];
                            const combined = [...existing];
                            assignedObjs.forEach(p => {
                                if (!combined.some(cp => cp.id === p.id)) combined.push(p);
                            });
                            conv.projects = combined;
                        }
                    });
                    await Storage.saveConversations(this.state.conversations);
                    this.sidebar.showToast(`Assigned ${convIds.length} chat(s) to project(s)`);
                }
                this.sidebar.clearSelection();
                await this.refreshCurrentView();
            } catch (err) {
                this.fileHandler.showError(`Failed to batch assign projects: ${err.message}`);
            }
        });

        // Delete Conversation
        this.sidebar.onDeleteConversation(async (convId) => {
            try {
                if (this.state.useBackend) {
                    await ApiClient.deleteConversation(convId);
                    this.sidebar.showToast('Conversation deleted');
                } else {
                    this.state.conversations = this.state.conversations.filter(c => c.id !== convId);
                    await Storage.saveConversations(this.state.conversations);
                    this.sidebar.showToast('Conversation deleted');
                }

                if (this.state.currentConversationId === convId) {
                    this.state.currentConversationId = null;
                    this.state.currentConversation = null;
                    this.chatView.render(null);
                }
                await this.refreshCurrentView();
            } catch (err) {
                this.fileHandler.showError(`Failed to delete conversation: ${err.message}`);
            }
        });

        // Rename Conversation
        this.sidebar.onRenameConversation(async ({ id, title }) => {
            await this.handleRenameConversation(id, title);
        });

        this.chatView.onRename((conv) => {
            if (conv && conv.id) {
                this.sidebar.openRenameModal(conv.id);
            }
        });

        // Toggle Star Conversation
        this.sidebar.onToggleStar(async (convId, isStarred) => {
            await this.handleToggleStar(convId, isStarred);
        });

        this.chatView.onToggleStar(async (convId, isStarred) => {
            await this.handleToggleStar(convId, isStarred);
        });

        // Export Single Conversation
        this.sidebar.onExportConversation(async (convId) => {
            await this.handleExportSingleConversation(convId);
        });

        // Search Queries
        this.sidebar.onSearchChange(async (query, projectId) => {
            if (this.state.useBackend) {
                try {
                    const isStarredView = (this.sidebar.currentView === 'starred' || projectId === 'starred');
                    const filterProjectId = (projectId === 'starred') ? null : projectId;
                    const data = await ApiClient.getConversations(
                        query,
                        100,
                        0,
                        this.sidebar.sortBy,
                        this.sidebar.sortOrder,
                        filterProjectId,
                        isStarredView ? true : null
                    );
                    if (data.conversations) {
                        this.state.conversations = data.conversations;
                        this.sidebar.render(data.conversations, data.total);
                        return;
                    }
                } catch (err) {
                    console.warn('Failed to query backend search, fallback to local filtering:', err);
                }
            }
            this.sidebar.render(this.state.getConversations());
        });

        // Sort changes
        this.sidebar.onSortChange(async (sortBy, sortOrder, projectId) => {
            if (this.state.useBackend) {
                try {
                    const isStarredView = (this.sidebar.currentView === 'starred' || projectId === 'starred');
                    const filterProjectId = (projectId === 'starred') ? null : projectId;
                    const data = await ApiClient.getConversations(
                        this.sidebar.searchQuery,
                        100,
                        0,
                        sortBy,
                        sortOrder,
                        filterProjectId,
                        isStarredView ? true : null
                    );
                    if (data.conversations) {
                        this.state.conversations = data.conversations;
                        this.sidebar.render(data.conversations, data.total);
                        return;
                    }
                } catch (err) {
                    console.warn('Failed to fetch sorted conversations from backend, sorting client-side:', err);
                }
            }
            this.sidebar.render(this.state.getConversations());
        });

        // Load More (Pagination)
        this.sidebar.onLoadMore(async (offset, limit, projectId) => {
            if (this.state.useBackend) {
                try {
                    const isStarredView = (this.sidebar.currentView === 'starred' || projectId === 'starred');
                    const filterProjectId = (projectId === 'starred') ? null : projectId;
                    const data = await ApiClient.getConversations(
                        this.sidebar.searchQuery,
                        limit,
                        offset,
                        this.sidebar.sortBy,
                        this.sidebar.sortOrder,
                        filterProjectId,
                        isStarredView ? true : null
                    );
                    if (data.conversations && data.conversations.length > 0) {
                        this.state.conversations = [...this.state.conversations, ...data.conversations];
                        this.sidebar.appendConversations(data.conversations, data.total);
                    } else {
                        this.sidebar.appendConversations([], data.total ?? this.sidebar.allConversations.length);
                    }
                } catch (err) {
                    console.warn('Failed to load more conversations from backend:', err);
                    this.sidebar.appendConversations([], this.sidebar.allConversations.length);
                }
            }
        });

        // Listen for file drops / uploads
        document.addEventListener('conversations-loaded', async (e) => {
            const { conversations, source, fromUrl, file } = e.detail;

            if (this.state.useBackend && file) {
                try {
                    const sourceName = source || file.name || 'archive';
                    this.fileHandler.showToast(`Importing ${sourceName} into database... This may take a few moments.`, 'info');
                    
                    let res;
                    if (file.path) {
                        res = await ApiClient.importPath(file.path);
                    } else {
                        res = await ApiClient.uploadFile(file);
                    }

                    // Reset sort to date descending so newly imported conversations appear at the top
                    this.sidebar.setSort('date', 'desc');
                    const searchInput = document.getElementById('search-input');
                    if (searchInput) searchInput.value = '';
                    this.sidebar.searchQuery = '';

                    const [convData, projects] = await Promise.all([
                        ApiClient.getConversations('', 100, 0, 'date', 'desc'),
                        ApiClient.getProjects()
                    ]);

                    this.state.setProjects(projects);
                    this.sidebar.setProjects(projects);

                    if (convData.conversations && convData.conversations.length > 0) {
                        this.state.conversations = convData.conversations;
                        this.sidebar.render(convData.conversations, convData.total, projects);
                        const targetId = convData.conversations[0].id;
                        await this.state.selectConversation(targetId);
                    }
                    const count = res.imported_conversations ?? res.imported ?? (conversations ? conversations.length : 0);
                    const msgCount = res.imported_messages ? ` (${res.imported_messages} messages)` : '';
                    const mediaMsg = res.extracted_attachments ? ` and extracted ${res.extracted_attachments} media files` : '';
                    this.fileHandler.showSuccess(`Successfully saved ${count} conversation(s)${msgCount}${mediaMsg} to database.`);
                    return;
                } catch (err) {
                    console.error('Failed to upload file to SQLite backend, falling back to local session:', err);
                    this.fileHandler.showError(`Backend import failed: ${err.message}. Loaded in local session.`);
                }
            }

            // Fallback for offline / browser-only mode without backend
            if (fromUrl) {
                this.state.replaceConversations(conversations);
            } else {
                const newCount = await this.state.addConversations(conversations);
                if (newCount > 0) {
                    console.log(`Added ${newCount} new conversation(s) from ${source}`);
                }
            }
        });

        // State changes
        this.state.on('conversations-updated', (conversations) => {
            this.sidebar.render(conversations, null, this.state.getProjects());

            if (!this.state.currentConversationId && conversations.length > 0) {
                this.state.selectConversation(conversations[0].id);
            }

            const exportAllBtn = document.getElementById('export-all-btn');
            if (exportAllBtn) {
                exportAllBtn.style.display = conversations.length > 0 ? 'block' : 'none';
            }
        });

        this.state.on('projects-updated', (projects) => {
            this.sidebar.setProjects(projects);
        });

        this.state.on('conversation-selected', (conversation) => {
            const searchInput = document.getElementById('search-input');
            if (searchInput) {
                this.chatView.setSearchQuery(searchInput.value);
            }
            this.chatView.render(conversation);

            const exportCurrentBtn = document.getElementById('export-current-btn');
            if (exportCurrentBtn) {
                exportCurrentBtn.style.display = conversation ? 'block' : 'none';
            }
        });

        // Sidebar selection
        this.sidebar.onSelect((conversationId) => {
            this.state.selectConversation(conversationId);
        });

        // Selection changes
        this.sidebar.onSelectionChange((selectedIds) => {
            const exportSelectedBtn = document.getElementById('export-selected-btn');
            const selectionControls = document.getElementById('selection-controls');

            if (exportSelectedBtn) {
                exportSelectedBtn.style.display = selectedIds.length > 0 ? 'block' : 'none';
            }
            if (selectionControls) {
                selectionControls.style.display = this.sidebar.isSelectionMode ? 'flex' : 'none';
            }
        });

        // Export current conversation button
        const exportCurrentBtn = document.getElementById('export-current-btn');
        if (exportCurrentBtn) {
            exportCurrentBtn.addEventListener('click', async () => {
                await this.handleExportSingleConversation(this.state.currentConversationId);
            });
        }

        // Export selected conversations button
        const exportSelectedBtn = document.getElementById('export-selected-btn');
        if (exportSelectedBtn) {
            exportSelectedBtn.addEventListener('click', async () => {
                try {
                    const selectedIds = this.sidebar.getSelectedIds();
                    if (selectedIds.length > 0) {
                        this.fileHandler.showToast(`Exporting ${selectedIds.length} conversation(s)...`, 'info');
                        let selectedConversations = [];
                        if (this.state.useBackend) {
                            selectedConversations = await Promise.all(
                                selectedIds.map(id => ApiClient.getConversation(id))
                            );
                        } else {
                            selectedConversations = this.state.getConversations()
                                .filter(conv => selectedIds.includes(conv.id));
                        }
                        const filename = generateFilename(selectedConversations);
                        exportConversations(selectedConversations, filename);
                        this.sidebar.showToast(`Exported ${selectedConversations.length} conversation(s)`);
                    }
                } catch (err) {
                    console.error('Failed to export selected:', err);
                    this.fileHandler.showError(`Export failed: ${err.message}`);
                }
            });
        }

        // Export all conversations button
        const exportAllBtn = document.getElementById('export-all-btn');
        if (exportAllBtn) {
            exportAllBtn.addEventListener('click', async () => {
                try {
                    const conversations = this.state.getConversations();
                    if (conversations.length > 0) {
                        this.fileHandler.showToast(`Exporting ${conversations.length} conversation(s)...`, 'info');
                        let fullConvs = [];
                        if (this.state.useBackend) {
                            fullConvs = await Promise.all(
                                conversations.map(c => ApiClient.getConversation(c.id))
                            );
                        } else {
                            fullConvs = conversations;
                        }
                        const filename = generateFilename(fullConvs);
                        exportConversations(fullConvs, filename);
                        this.sidebar.showToast(`Exported ${fullConvs.length} conversation(s)`);
                    }
                } catch (err) {
                    console.error('Failed to export all:', err);
                    this.fileHandler.showError(`Export failed: ${err.message}`);
                }
            });
        }

        const selectAllBtn = document.getElementById('select-all-btn');
        if (selectAllBtn) {
            selectAllBtn.addEventListener('click', () => this.sidebar.selectAll());
        }

        const selectNoneBtn = document.getElementById('select-none-btn');
        if (selectNoneBtn) {
            selectNoneBtn.addEventListener('click', () => this.sidebar.clearSelection());
        }
    }

    async handleRenameConversation(convId, newTitle) {
        try {
            if (this.state.useBackend) {
                const updatedConv = await ApiClient.renameConversation(convId, newTitle);
                if (this.state.currentConversationId === convId) {
                    this.state.currentConversation = updatedConv;
                    this.chatView.render(updatedConv);
                }
                this.sidebar.showToast('Conversation renamed');
            } else {
                const conv = this.state.conversations.find(c => c.id === convId);
                if (conv) {
                    conv.original_title = conv.original_title || conv.title;
                    conv.custom_title = newTitle;
                    conv.title = newTitle;
                    await Storage.saveConversations(this.state.conversations);
                    if (this.state.currentConversationId === convId) {
                        this.state.currentConversation = conv;
                        this.chatView.render(conv);
                    }
                    this.sidebar.showToast('Conversation renamed');
                }
            }
            await this.refreshCurrentView();
        } catch (err) {
            console.error('Failed to rename conversation:', err);
            this.fileHandler.showError(`Failed to rename conversation: ${err.message}`);
        }
    }

    async handleToggleStar(convId, isStarred) {
        try {
            // Optimistically update in state
            const conv = this.state.conversations.find(c => c.id === convId);
            if (conv) {
                conv.is_starred = isStarred;
            }
            if (this.state.currentConversation && this.state.currentConversation.id === convId) {
                this.state.currentConversation.is_starred = isStarred;
                this.chatView.render(this.state.currentConversation);
            }

            if (this.state.useBackend) {
                const updated = await ApiClient.toggleStar(convId, isStarred);
                if (updated && this.state.currentConversationId === convId) {
                    this.state.currentConversation = updated;
                    this.chatView.render(updated);
                }
            } else {
                await Storage.saveConversations(this.state.conversations);
            }

            this.sidebar.showToast(isStarred ? 'Added to Starred ⭐' : 'Removed from Starred');
            await this.refreshCurrentView();
        } catch (err) {
            console.error('Failed to toggle star:', err);
            this.fileHandler.showError(`Failed to toggle star: ${err.message}`);
        }
    }

    /**
     * Handle single conversation export by loading complete conversation data and opening format selection modal
     */
    async handleExportSingleConversation(convId = null) {
        try {
            const targetId = convId || this.state.currentConversationId;
            let conv = this.state.getCurrentConversation();
            const hasMessages = (c) => Boolean(c && ((c.messages && c.messages.length > 0) || (c.active_branch && c.active_branch.length > 0)));

            if (!conv || (targetId && conv.id !== targetId) || !hasMessages(conv)) {
                if (this.state.useBackend && targetId) {
                    conv = await ApiClient.getConversation(targetId);
                } else if (targetId) {
                    conv = this.state.getConversations().find(c => c.id === targetId);
                }
            }
            if (conv) {
                if (this.state.useBackend && !hasMessages(conv)) {
                    conv = await ApiClient.getConversation(conv.id);
                }
                this.sidebar.openExportModal(conv, (targetConv, format) => {
                    this.executeSingleExport(targetConv, format);
                });
            }
        } catch (err) {
            console.error('Failed to prepare conversation export:', err);
            this.fileHandler.showError(`Export failed: ${err.message}`);
        }
    }

    /**
     * Execute download of conversation in selected format
     */
    executeSingleExport(conversation, format = 'markdown') {
        try {
            if (format === 'markdown' || format === 'md') {
                const filename = generateFilename(conversation, 'md');
                exportConversationAsMarkdown(conversation, filename);
                this.sidebar.showToast('Exported conversation as Markdown (.md)');
            } else {
                const filename = generateFilename(conversation, 'json');
                exportConversations(conversation, filename);
                this.sidebar.showToast('Exported conversation as JSON (.json)');
            }
        } catch (err) {
            console.error('Failed to export conversation:', err);
            this.fileHandler.showError(`Export failed: ${err.message}`);
        }
    }
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { window.app = new App(); });
} else {
    window.app = new App();
}
