/**
 * Conversation format parsers for OpenAI and Claude exports
 */

/**
 * Detect the format of a conversation JSON
 * @param {Array} data - Parsed JSON data
 * @returns {string} - 'openai', 'claude', 'zai', 'normalized', or 'unknown'
 */
export function detectFormat(data) {
    if (!Array.isArray(data) || data.length === 0) {
        throw new Error('Invalid conversation format: expected non-empty array');
    }

    const first = data[0];
    if (!first || typeof first !== 'object') {
        throw new Error('Unknown conversation format');
    }

    // Normalized format (exported from this app)
    if ('id' in first && 'messages' in first && 'format' in first) {
        return 'normalized';
    }

    // OpenAI format has mapping and current_node / conversation_id / create_time / id
    if (first.mapping !== undefined && ('current_node' in first || 'conversation_id' in first || 'default_model_slug' in first || 'create_time' in first || 'id' in first)) {
        return 'openai';
    }

    // Claude format has chat_messages and uuid / name
    if ('chat_messages' in first && ('uuid' in first || 'name' in first)) {
        return 'claude';
    }

    // Z.ai format has chat.history
    if (first.chat && typeof first.chat === 'object') {
        return 'zai';
    }

    throw new Error('Unknown conversation format');
}

/**
 * Extract active branch messages from OpenAI mapping DAG
 * @param {Object} conv - OpenAI raw conversation
 * @param {string|null} leafNodeId - Target node or leaf ID to trace
 * @returns {Array} - Array of normalized messages
 */
export function extractActiveBranch(conv, leafNodeId = null) {
    if (!conv.mapping) {
        return conv.messages || [];
    }

    const mapping = conv.mapping;
    let targetNodeId = leafNodeId || conv.current_node;

    // Resolve downward to deepest descendant leaf in branch if intermediate node was selected
    if (targetNodeId && mapping[targetNodeId]) {
        let curr = targetNodeId;
        const visited = new Set();
        while (curr && mapping[curr] && !visited.has(curr)) {
            visited.add(curr);
            const node = mapping[curr];
            const children = node.children || [];
            const validChildren = children.filter(cid => mapping[cid] && !visited.has(cid));
            if (validChildren.length === 0) break;

            const contentChildren = validChildren.filter(cid => {
                const m = mapping[cid]?.message;
                return m && !m.metadata?.is_visually_hidden_from_conversation && (m.content?.parts?.length > 0 || m.content?.text);
            });
            const candidates = contentChildren.length > 0 ? contentChildren : validChildren;
            candidates.sort((a, b) => (mapping[b]?.message?.create_time || 0) - (mapping[a]?.message?.create_time || 0));
            curr = candidates[0];
        }
        targetNodeId = curr || targetNodeId;
    }

    // Map parent to children for sibling version calculation
    const parentToChildren = {};
    Object.entries(mapping).forEach(([nid, node]) => {
        const p = node.parent;
        if (!parentToChildren[p]) parentToChildren[p] = [];
        parentToChildren[p].push(nid);
    });

    const activeBranch = [];
    let nodeId = targetNodeId;
    const visitedUp = new Set();

    while (nodeId && mapping[nodeId] && !visitedUp.has(nodeId)) {
        visitedUp.add(nodeId);
        const node = mapping[nodeId];
        if (node.message) {
            const isHidden = node.message.metadata?.is_visually_hidden_from_conversation;
            const parts = node.message.content?.parts || (node.message.content?.text ? [node.message.content.text] : []);
            const content = parts.map(p => {
                if (typeof p === 'string') return p;
                if (p?.text) return p.text;
                if (p?.asset_pointer) {
                    const clean = p.asset_pointer.replace('file-service://', '').replace('sediment://', '');
                    return `[Attachment: ${clean}]`;
                }
                return '';
            }).filter(Boolean).join('\n').trim();

            const isUserOrAsst = ['user', 'assistant'].includes(node.message.author?.role);
            if (!isHidden || isUserOrAsst) {
                // Calculate siblings
                const siblingIds = parentToChildren[node.parent] || [nodeId];
                const validSiblings = siblingIds.filter(sid => {
                    const sm = mapping[sid]?.message;
                    const smUserOrAsst = ['user', 'assistant'].includes(sm?.author?.role);
                    return sm && (!sm.metadata?.is_visually_hidden_from_conversation || smUserOrAsst || sid === nodeId);
                }).map(sid => ({
                    id: sid,
                    created_at: mapping[sid]?.message?.create_time || 0
                })).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

                activeBranch.unshift({
                    id: nodeId,
                    role: node.message.author?.role || 'assistant',
                    content: content,
                    timestamp: new Date((node.message.create_time || conv.create_time || 0) * 1000),
                    model_slug: node.message.metadata?.model_slug || conv.default_model_slug || null,
                    siblings: validSiblings.length > 0 ? validSiblings : [{ id: nodeId, created_at: 0 }],
                    metadata: {
                        model: node.message.metadata?.model_slug || conv.default_model_slug || null,
                        model_slug: node.message.metadata?.model_slug || conv.default_model_slug || null,
                        status: node.message.status
                    }
                });
            }
        }
        nodeId = node.parent;
    }

    return activeBranch;
}

/**
 * Parse OpenAI conversation format
 * @param {Array} data - OpenAI conversation array
 * @returns {Array} - Array of normalized conversations
 */
export function parseOpenAI(data) {
    return data.map(conv => {
        const activeMessages = extractActiveBranch(conv, conv.current_node);
        return {
            id: conv.conversation_id || conv.id,
            title: conv.title || 'Untitled Conversation',
            created: new Date(conv.create_time * 1000),
            updated: new Date(conv.update_time * 1000),
            format: 'openai',
            current_node: conv.current_node,
            mapping: conv.mapping,
            active_branch: activeMessages,
            messages: activeMessages,
            message_count: activeMessages.length
        };
    });
}

/**
 * Parse Claude conversation format
 * Transforms linear chat_messages array to normalized format
 * @param {Array} data - Claude conversation array
 * @returns {Array} - Array of normalized conversations
 */
export function parseClaude(data) {
    return data.map(conv => {
        const messages = conv.chat_messages.map((msg, idx) => {
            let contentStr = '';
            if (typeof msg.text === 'string') {
                contentStr = msg.text;
            } else if (Array.isArray(msg.content)) {
                contentStr = msg.content
                    .filter(c => c && c.type === 'text')
                    .map(c => c.text || '')
                    .join('\n');
            } else if (typeof msg.content === 'string') {
                contentStr = msg.content;
            }

            const rawTime = msg.created_at || (msg.created_at_ts ? msg.created_at_ts * 1000 : conv.created_at || Date.now());
            const msgDate = (rawTime instanceof Date) ? rawTime : new Date(typeof rawTime === 'number' && rawTime < 1e10 ? rawTime * 1000 : rawTime);

            return {
                id: msg.uuid || `${conv.uuid || 'conv'}_${idx}`,
                role: msg.sender === 'human' ? 'user' : 'assistant',
                content: contentStr,
                timestamp: isNaN(msgDate.getTime()) ? new Date() : msgDate,
                model_slug: msg.model || conv.model || 'claude',
                metadata: {
                    model: msg.model || conv.model || 'claude',
                    model_slug: msg.model || conv.model || 'claude',
                    attachments: msg.attachments,
                    files: msg.files
                }
            };
        });

        return {
            id: conv.uuid,
            title: conv.name || 'Untitled Conversation',
            created: new Date(conv.created_at),
            updated: new Date(conv.updated_at),
            format: 'claude',
            summary: conv.summary,
            model_slug: 'claude',
            messages,
            message_count: messages.length
        };
    });
}

/**
 * Parse Z.ai conversation format
 * Extracts the current conversation path by walking from currentId backwards
 * @param {Array} data - Z.ai conversation array
 * @returns {Array} - Array of normalized conversations
 */
export function parseZai(data) {
    return data.map(conv => {
        const messages = [];
        let nodeId = conv.chat.history.currentId;
        const messageMap = conv.chat.history.messages;

        // Walk backwards from currentId to root
        while (nodeId) {
            const node = messageMap[nodeId];
            if (!node) break;

            const rawNodeTime = node.timestamp;
            const nodeDate = (rawNodeTime instanceof Date) ? rawNodeTime : new Date(typeof rawNodeTime === 'number' && rawNodeTime < 1e10 ? rawNodeTime * 1000 : rawNodeTime);

            // Add message to the beginning of the array
            messages.unshift({
                id: node.id,
                role: node.role,
                content: node.content || '',
                timestamp: isNaN(nodeDate.getTime()) ? new Date() : nodeDate,
                model_slug: node.model || node.modelName || 'zai',
                metadata: {
                    model: node.model || node.modelName || 'zai',
                    model_slug: node.model || node.modelName || 'zai',
                    models: node.models,
                    done: node.done,
                    status: node.status,
                    usage: node.usage
                }
            });

            nodeId = node.parentId;
        }

        const rawCreated = conv.created_at || conv.chat?.timestamp || Date.now();
        const createdDate = new Date(typeof rawCreated === 'number' && rawCreated < 1e10 ? rawCreated * 1000 : rawCreated);

        const rawUpdated = conv.updated_at || conv.created_at || conv.chat?.timestamp || Date.now();
        const updatedDate = new Date(typeof rawUpdated === 'number' && rawUpdated < 1e10 ? rawUpdated * 1000 : rawUpdated);

        return {
            id: conv.id,
            title: conv.title || conv.chat?.title || 'Untitled Conversation',
            created: isNaN(createdDate.getTime()) ? new Date() : createdDate,
            updated: isNaN(updatedDate.getTime()) ? new Date() : updatedDate,
            format: 'zai',
            model_slug: 'zai',
            messages,
            message_count: messages.length
        };
    });
}

/**
 * Parse normalized conversation format (exported from this app)
 * Converts ISO date strings back to Date objects
 * @param {Array} data - Normalized conversation array
 * @returns {Array} - Array of normalized conversations with Date objects
 */
export function parseNormalized(data) {
    return data.map(conv => ({
        id: conv.id,
        title: conv.custom_title || conv.title || 'Untitled Conversation',
        custom_title: conv.custom_title || null,
        original_title: conv.original_title || conv.title || 'Untitled Conversation',
        is_starred: Boolean(conv.is_starred),
        created: new Date(conv.created),
        updated: new Date(conv.updated),
        format: conv.format,
        summary: conv.summary,
        model_slug: conv.model_slug || null,
        message_count: conv.message_count !== undefined ? conv.message_count : (conv.messages || []).length,
        messages: (conv.messages || []).map(msg => ({
            id: msg.id,
            role: msg.role,
            content: msg.content,
            timestamp: new Date(msg.timestamp),
            model_slug: msg.model_slug || msg.metadata?.model_slug || msg.metadata?.model || null,
            metadata: msg.metadata || {}
        }))
    }));
}

/**
 * Main parsing function - auto-detects format and returns normalized conversations
 * @param {Array} data - Raw conversation JSON data
 * @returns {Array} - Array of normalized conversations
 */
export function parseConversations(data) {
    const format = detectFormat(data);

    switch (format) {
        case 'openai':
            return parseOpenAI(data);
        case 'claude':
            return parseClaude(data);
        case 'zai':
            return parseZai(data);
        case 'normalized':
            return parseNormalized(data);
        default:
            throw new Error(`Unsupported format: ${format}`);
    }
}
