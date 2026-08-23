/**
 * Local API client for SQLite-backed server
 */

export class ApiClient {
    static baseUrl = (typeof window !== 'undefined' && window.location.protocol === 'file:') ? 'http://127.0.0.1:8000' : '';

    /**
     * Check if the local backend server is accessible
     */
    static async isBackendAvailable() {
        try {
            const resp = await fetch(`${this.baseUrl}/api/stats`, { method: 'GET' });
            return resp.ok;
        } catch {
            return false;
        }
    }

    /**
     * Fetch rich usage statistics and insights
     */
    static async getAnalytics(cutoffHour = 0) {
        const resp = await fetch(`${this.baseUrl}/api/analytics?cutoff_hour=${encodeURIComponent(cutoffHour)}`);
        if (!resp.ok) throw new Error('Failed to fetch analytics');
        const data = await resp.json();
        return data.analytics;
    }

    /**
     * Fetch list of conversations with optional query, pagination, sorting, project filter, and starred filter
     */
    static async getConversations(query = '', limit = 100, offset = 0, sortBy = 'date', sortOrder = 'desc', projectId = null, starred = null) {
        const params = new URLSearchParams({ limit, offset });
        if (query) params.append('q', query);
        if (sortBy) params.append('sort_by', sortBy);
        if (sortOrder) params.append('order', sortOrder);
        if (projectId) params.append('project_id', projectId);
        if (starred !== null && starred !== undefined) params.append('starred', starred ? '1' : '0');
        const resp = await fetch(`${this.baseUrl}/api/conversations?${params.toString()}`);
        if (!resp.ok) throw new Error('Failed to fetch conversations');
        return await resp.json();
    }

    /**
     * Toggle or set star/favorite status for a conversation
     */
    static async toggleStar(id, isStarred = null) {
        const resp = await fetch(`${this.baseUrl}/api/conversations/${encodeURIComponent(id)}/star`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(isStarred !== null ? { is_starred: isStarred } : {})
        });
        if (!resp.ok) {
            let errMsg = 'Failed to toggle star';
            try {
                const err = await resp.json();
                if (err.error) errMsg = err.error;
            } catch {}
            throw new Error(errMsg);
        }
        const data = await resp.json();
        return data.conversation;
    }

    /**
     * Fetch list of all projects
     */
    static async getProjects() {
        const resp = await fetch(`${this.baseUrl}/api/projects`);
        if (!resp.ok) throw new Error('Failed to fetch projects');
        const data = await resp.json();
        return data.projects || [];
    }

    /**
     * Create a new project
     */
    static async createProject(projectData) {
        const resp = await fetch(`${this.baseUrl}/api/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(projectData)
        });
        if (!resp.ok) {
            let errMsg = 'Failed to create project';
            try {
                const err = await resp.json();
                if (err.error) errMsg = err.error;
            } catch {}
            throw new Error(errMsg);
        }
        const data = await resp.json();
        return data.project;
    }

    /**
     * Update an existing project
     */
    static async updateProject(projectId, projectData) {
        const resp = await fetch(`${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(projectData)
        });
        if (!resp.ok) {
            let errMsg = 'Failed to update project';
            try {
                const err = await resp.json();
                if (err.error) errMsg = err.error;
            } catch {}
            throw new Error(errMsg);
        }
        const data = await resp.json();
        return data.project;
    }

    /**
     * Delete a project
     */
    static async deleteProject(projectId) {
        const resp = await fetch(`${this.baseUrl}/api/projects/${encodeURIComponent(projectId)}`, {
            method: 'DELETE'
        });
        return resp.ok;
    }

    /**
     * Assign projects to a single conversation
     */
    static async setConversationProjects(convId, projectIds) {
        const resp = await fetch(`${this.baseUrl}/api/conversations/${encodeURIComponent(convId)}/projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_ids: projectIds })
        });
        if (!resp.ok) throw new Error('Failed to set conversation projects');
        const data = await resp.json();
        return data.projects;
    }

    /**
     * Bulk assign or remove projects for multiple conversations
     */
    static async batchAssignProjects(convIds, addProjectIds = [], removeProjectIds = []) {
        const resp = await fetch(`${this.baseUrl}/api/conversations/batch-projects`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                conversation_ids: convIds,
                add_project_ids: addProjectIds,
                remove_project_ids: removeProjectIds
            })
        });
        if (!resp.ok) throw new Error('Failed to batch assign projects');
        return await resp.json();
    }

    /**
     * Fetch full conversation with specific branch leaf
     */
    static async getConversation(id, leafNodeId = null) {
        const params = new URLSearchParams();
        if (leafNodeId) params.append('leaf_node_id', leafNodeId);
        const url = `${this.baseUrl}/api/conversations/${encodeURIComponent(id)}${params.toString() ? '?' + params.toString() : ''}`;
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Failed to fetch conversation details');
        const data = await resp.json();
        return data.conversation;
    }

    /**
     * Perform full-text search (FTS5)
     */
    static async search(query, limit = 50) {
        const params = new URLSearchParams({ q: query, limit });
        const resp = await fetch(`${this.baseUrl}/api/search?${params.toString()}`);
        if (!resp.ok) throw new Error('Search failed');
        return await resp.json();
    }

    /**
     * Upload file to server via multipart
     */
    static async uploadFile(file) {
        const formData = new FormData();
        formData.append('file', file);
        const resp = await fetch(`${this.baseUrl}/api/import`, {
            method: 'POST',
            body: formData
        });
        if (!resp.ok) {
            let errorMsg = `Server error (${resp.status})`;
            try {
                const errData = await resp.json();
                if (errData.error) errorMsg = errData.error;
            } catch {}
            throw new Error(errorMsg);
        }
        return await resp.json();
    }

    /**
     * Direct local path import on server (instant, no browser memory overhead)
     */
    static async importPath(filePath) {
        const resp = await fetch(`${this.baseUrl}/api/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath })
        });
        if (!resp.ok) {
            let errorMsg = `Server error (${resp.status})`;
            try {
                const errData = await resp.json();
                if (errData.error) errorMsg = errData.error;
            } catch {}
            throw new Error(errorMsg);
        }
        return await resp.json();
    }

    /**
     * Rename a conversation (update custom_title)
     */
    static async renameConversation(id, title) {
        const resp = await fetch(`${this.baseUrl}/api/conversations/${encodeURIComponent(id)}/title`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title })
        });
        if (!resp.ok) {
            let errorMsg = 'Failed to rename conversation';
            try {
                const errData = await resp.json();
                if (errData.error) errorMsg = errData.error;
            } catch {}
            throw new Error(errorMsg);
        }
        const data = await resp.json();
        return data.conversation;
    }

    /**
     * Delete conversation
     */
    static async deleteConversation(id) {
        const resp = await fetch(`${this.baseUrl}/api/conversations/${encodeURIComponent(id)}`, {
            method: 'DELETE'
        });
        return resp.ok;
    }
}
