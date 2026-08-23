/**
 * Export utility for conversations
 * Handles exporting conversations in rich JSON and formatted Markdown formats
 */

/**
 * Safely format any date/timestamp value to ISO string
 * @param {Date|number|string} val
 * @returns {string} ISO date string
 */
function toIsoString(val) {
    if (!val) return new Date().toISOString();
    if (val instanceof Date && !isNaN(val.getTime())) {
        return val.toISOString();
    }
    if (typeof val === 'number') {
        const ms = val < 10000000000 ? val * 1000 : val;
        const d = new Date(ms);
        return !isNaN(d.getTime()) ? d.toISOString() : new Date().toISOString();
    }
    try {
        const d = new Date(val);
        if (!isNaN(d.getTime())) return d.toISOString();
    } catch {}
    return String(val);
}

/**
 * Format timestamp to a human-readable string (YYYY-MM-DD HH:mm:ss)
 * @param {Date|number|string} val
 * @returns {string} Human readable date time
 */
function formatDateTime(val) {
    if (!val) return '';
    try {
        const ms = (typeof val === 'number' && val < 10000000000) ? val * 1000 : val;
        const d = (val instanceof Date) ? val : new Date(ms);
        if (isNaN(d.getTime())) return String(val);
        const pad = (n) => String(n).padStart(2, '0');
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const day = pad(d.getDate());
        const hours = pad(d.getHours());
        const mins = pad(d.getMinutes());
        const secs = pad(d.getSeconds());
        return `${year}-${month}-${day} ${hours}:${mins}:${secs}`;
    } catch {
        return String(val);
    }
}

/**
 * Prepare conversation data for export
 * @param {Object|Array} conversations - Single conversation or array of conversations
 * @returns {Array} - Array of conversations ready for JSON export
 */
export function prepareForExport(conversations) {
    const convArray = Array.isArray(conversations) ? conversations : [conversations];

    return convArray.map(conv => {
        if (!conv) return {};

        const rawCreated = conv.created ?? conv.created_at ?? conv.create_time;
        const rawUpdated = conv.updated ?? conv.updated_at ?? conv.update_time ?? rawCreated;

        // Extract messages array safely from messages, active_branch, or mapping
        let messagesList = [];
        if (Array.isArray(conv.messages) && conv.messages.length > 0) {
            messagesList = conv.messages;
        } else if (Array.isArray(conv.active_branch) && conv.active_branch.length > 0) {
            messagesList = conv.active_branch;
        } else if (conv.mapping && typeof conv.mapping === 'object') {
            // Extract from mapping tree
            Object.values(conv.mapping).forEach(node => {
                if (node && node.message) {
                    messagesList.push({
                        id: node.message.id || node.id,
                        role: node.message.author ? node.message.author.role : (node.message.role || 'unknown'),
                        content: node.message.content ? (
                            typeof node.message.content === 'string' ? node.message.content : 
                            (node.message.content.parts ? node.message.content.parts.join('\n') : JSON.stringify(node.message.content))
                        ) : '',
                        timestamp: node.message.create_time || rawCreated,
                        metadata: node.message.metadata || {}
                    });
                }
            });
        }

        const normalizedMessages = messagesList.map(msg => {
            if (!msg) return {};
            return {
                id: msg.id || 'msg-' + Math.random().toString(36).substr(2, 9),
                role: msg.role || 'user',
                content: msg.content !== undefined ? msg.content : '',
                timestamp: toIsoString(msg.timestamp ?? msg.created_at ?? msg.create_time ?? rawCreated),
                model_slug: msg.model_slug || msg.metadata?.model_slug || msg.metadata?.model || null,
                metadata: msg.metadata || {}
            };
        });

        return {
            id: conv.id || 'conv-' + Math.random().toString(36).substr(2, 9),
            title: conv.title || 'Untitled Conversation',
            custom_title: conv.custom_title || null,
            original_title: conv.original_title || conv.title || 'Untitled Conversation',
            is_starred: Boolean(conv.is_starred),
            created: toIsoString(rawCreated),
            updated: toIsoString(rawUpdated),
            format: conv.format || 'openai',
            summary: conv.summary || '',
            projects: conv.projects || [],
            messages: normalizedMessages,
            ...(conv.mapping ? { mapping: conv.mapping } : {})
        };
    });
}

/**
 * Format a single conversation into a structured Markdown document
 * @param {Object} conversation - Normalized or raw conversation object
 * @returns {string} - Rendered Markdown content
 */
export function formatConversationToMarkdown(conversation) {
    if (!conversation) return '';

    const preparedList = prepareForExport(conversation);
    const conv = preparedList[0] || conversation;

    const displayTitle = conv.custom_title || conv.title || 'Untitled Conversation';
    const originalTitle = conv.original_title;
    const formatName = (conv.format || 'unknown').toUpperCase();
    const createdStr = formatDateTime(conv.created);
    const updatedStr = formatDateTime(conv.updated);
    const messages = Array.isArray(conv.messages) ? conv.messages : [];

    // Tag / project extraction
    let tagsList = [];
    if (Array.isArray(conv.projects)) {
        tagsList = conv.projects.map(p => (typeof p === 'string' ? p : p.name)).filter(Boolean);
    }

    let md = `# ${displayTitle}\n\n`;

    // Metadata blockquote
    md += `> **Source Format:** ${formatName}  \n`;
    if (createdStr) {
        md += `> **Created:** ${createdStr}  \n`;
    }
    if (updatedStr && updatedStr !== createdStr) {
        md += `> **Updated:** ${updatedStr}  \n`;
    }
    if (originalTitle && originalTitle !== displayTitle) {
        md += `> **Original Title:** ${originalTitle}  \n`;
    }
    if (tagsList.length > 0) {
        md += `> **Tags:** ${tagsList.join(', ')}  \n`;
    }
    if (conv.summary) {
        md += `> **Summary:** ${conv.summary}  \n`;
    }
    md += `> **Total Messages:** ${messages.length}\n\n`;
    md += `---\n\n`;

    // Messages sequence
    messages.forEach((msg, idx) => {
        if (!msg) return;

        const role = (msg.role || 'user').toLowerCase();
        let roleHeading = 'User';
        let roleIcon = '🧑';

        if (role === 'assistant' || role === 'bot') {
            roleHeading = 'Assistant';
            roleIcon = '🤖';
        } else if (role === 'system') {
            roleHeading = 'System';
            roleIcon = '⚙️';
        } else if (role === 'tool') {
            roleHeading = 'Tool';
            roleIcon = '🔧';
        } else if (role !== 'user') {
            roleHeading = role.charAt(0).toUpperCase() + role.slice(1);
            roleIcon = '💬';
        }

        // Model identifier if available (only for assistant / AI messages)
        let modelSuffix = '';
        if (role === 'assistant' || role === 'bot') {
            const model = msg.model_slug ||
                          msg.metadata?.model_slug ||
                          msg.metadata?.model ||
                          conv.model_slug ||
                          conv.default_model_slug ||
                          null;
            if (model) {
                modelSuffix = ` \`[${model}]\``;
            }
        }

        // Message timestamp
        const msgTime = formatDateTime(msg.timestamp || msg.created_at || msg.create_time);

        md += `### ${roleIcon} ${roleHeading}${modelSuffix}\n`;
        if (msgTime) {
            md += `*${msgTime}*\n\n`;
        } else {
            md += `\n`;
        }

        // Thought process / Reasoning if available
        const thought = msg.metadata?.thought || msg.thought || msg.metadata?.reasoning_content;
        if (thought && typeof thought === 'string' && thought.trim()) {
            md += `<details>\n<summary>💭 Thought Process</summary>\n\n${thought.trim()}\n\n</details>\n\n`;
        }

        // Main content
        let contentStr = '';
        if (typeof msg.content === 'string') {
            contentStr = msg.content;
        } else if (Array.isArray(msg.content?.parts)) {
            contentStr = msg.content.parts
                .map(p => (typeof p === 'string' ? p : (p?.text || JSON.stringify(p))))
                .join('\n');
        } else if (msg.content?.text) {
            contentStr = msg.content.text;
        } else if (msg.content !== undefined && msg.content !== null) {
            contentStr = JSON.stringify(msg.content, null, 2);
        }

        md += `${contentStr.trim()}\n\n`;

        // Attachments
        const attachments = msg.metadata?.attachments || msg.attachments || [];
        if (Array.isArray(attachments) && attachments.length > 0) {
            md += `**Attachments:**\n`;
            attachments.forEach(att => {
                const name = typeof att === 'string' ? att : (att.name || att.file_name || att.id || 'attachment');
                const url = typeof att === 'string' ? att : (att.url || att.path || name);
                md += `- 📎 [${name}](${url})\n`;
            });
            md += `\n`;
        }

        if (idx < messages.length - 1) {
            md += `---\n\n`;
        }
    });

    return md;
}

/**
 * Export conversations as JSON file
 * @param {Object|Array} conversations - Single conversation or array of conversations
 * @param {string} filename - Optional filename (defaults to generated or conversations.json)
 */
export function exportConversations(conversations, filename = null) {
    try {
        const data = prepareForExport(conversations);
        const actualFilename = filename || generateFilename(conversations, 'json');
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = actualFilename;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(url);
        }, 150);
    } catch (err) {
        console.error('Failed to export conversations as JSON:', err);
        throw err;
    }
}

/**
 * Export a single conversation as Markdown (.md) file
 * @param {Object} conversation - Single conversation object
 * @param {string} filename - Optional filename (defaults to sanitized title with .md)
 */
export function exportConversationAsMarkdown(conversation, filename = null) {
    try {
        const mdText = formatConversationToMarkdown(conversation);
        const actualFilename = filename || generateFilename(conversation, 'md');
        const blob = new Blob([mdText], { type: 'text/markdown;charset=utf-8' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = actualFilename;
        document.body.appendChild(a);
        a.click();

        setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            URL.revokeObjectURL(url);
        }, 150);
    } catch (err) {
        console.error('Failed to export conversation as Markdown:', err);
        throw err;
    }
}

/**
 * Generate a filename based on conversation(s) metadata
 * @param {Object|Array} conversations - Single conversation or array of conversations
 * @param {string} format - 'json' or 'md'
 * @returns {string} - Generated filename
 */
export function generateFilename(conversations, format = 'json') {
    const isMarkdown = (format === 'md' || format === 'markdown');
    const ext = isMarkdown ? 'md' : 'json';
    const convArray = Array.isArray(conversations) ? conversations : [conversations];

    if (convArray.length === 1 && convArray[0]) {
        // Single conversation: use title (sanitized)
        const rawTitle = convArray[0].custom_title || convArray[0].title || 'conversation';
        const sanitized = rawTitle
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/\s+/g, '_')
            .replace(/-+/g, '-')
            .substring(0, 60);
        return `${sanitized}.${ext}`;
    } else {
        // Multiple conversations: use timestamp
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
        return `conversations-export-${timestamp}.${ext}`;
    }
}
