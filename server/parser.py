"""
Parser for ChatGPT, Claude, and Z.ai conversation exports.
Transforms JSON dumps into normalized conversations and messages preserving full branch trees.
Supports media attachments, images, and audio extraction mapping.
"""

import json
import os
import urllib.parse
from typing import List, Dict, Any, Tuple, Optional

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.jfif', '.gif', '.svg', '.bmp', '.avif'}
AUDIO_EXTENSIONS = {'.wav', '.mp3', '.m4a', '.ogg', '.aac', '.flac'}

def is_image_file(filename: str) -> bool:
    """Check if file extension is an image format."""
    _, ext = os.path.splitext(filename.lower())
    return ext in IMAGE_EXTENSIONS

def resolve_media(
    clean_id: str,
    aname: Optional[str] = None,
    gen_id: Optional[str] = None,
    media_index: Optional[Dict[str, str]] = None
) -> Optional[str]:
    """Resolve an asset identifier or gen_id to a relative file path in media_index."""
    if not media_index:
        return None

    # 1. Direct ID matches
    if clean_id in media_index:
        return media_index[clean_id]
    
    # 2. Underscore / Hyphen variant
    clean_hyphen = clean_id.replace('_', '-')
    if clean_hyphen in media_index:
        return media_index[clean_hyphen]
    clean_underscore = clean_id.replace('-', '_')
    if clean_underscore in media_index:
        return media_index[clean_underscore]

    # 3. Attachment Name
    if aname and aname in media_index:
        return media_index[aname]

    # 4. DALL-E / Generation UUID
    if gen_id and gen_id in media_index:
        return media_index[gen_id]

    # 5. Prefix search for file IDs (e.g. file-xxx prefix)
    if len(clean_id) > 8:
        for k, v in media_index.items():
            if k.startswith(clean_id) or clean_id.startswith(k):
                return v

    return None

def detect_format(data: Any) -> str:
    """Detect format of parsed JSON data."""
    if not isinstance(data, list) or len(data) == 0:
        raise ValueError("Invalid format: expected non-empty list of conversations")
    first = data[0]
    if isinstance(first, dict):
        if first.get('mapping') is not None and ('current_node' in first or 'conversation_id' in first or 'default_model_slug' in first or 'create_time' in first or 'id' in first):
            return 'openai'
        if 'chat_messages' in first and ('uuid' in first or 'name' in first):
            return 'claude'
        if 'chat' in first and isinstance(first.get('chat'), dict):
            return 'zai'
        if 'id' in first and 'messages' in first and 'format' in first:
            return 'normalized'
    raise ValueError("Unknown conversation export format")

def parse_openai_conversation(
    raw_conv: Dict[str, Any],
    media_index: Optional[Dict[str, str]] = None
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """
    Parse a single OpenAI ChatGPT conversation object from conversations.json.
    Extracts all tree nodes, calculates sibling indexes, resolves attachments, and formats metadata.
    """
    conv_id = raw_conv.get('id') or raw_conv.get('conversation_id') or 'untitled'
    title = raw_conv.get('title') or 'Untitled Conversation'
    create_time = float(raw_conv.get('create_time') or 0.0)
    update_time = float(raw_conv.get('update_time') or create_time or 0.0)
    current_node = raw_conv.get('current_node')
    model_slug = raw_conv.get('default_model_slug')

    mapping = raw_conv.get('mapping', {})
    parsed_messages = []

    # Map each parent to its list of valid children
    parent_to_children = {}
    for node_id, node in mapping.items():
        p_id = node.get('parent')
        parent_to_children.setdefault(p_id, []).append(node_id)

    # Process all nodes
    for node_id, node in mapping.items():
        msg_obj = node.get('message')
        parent_id = node.get('parent')
        children_ids = node.get('children', [])

        if not msg_obj:
            # Empty root/routing placeholder node without message payload
            continue

        author = msg_obj.get('author', {})
        role = author.get('role', 'system')
        content_obj = msg_obj.get('content', {})
        metadata = msg_obj.get('metadata', {})
        status = msg_obj.get('status', 'finished_successfully')
        msg_create_time = float(msg_obj.get('create_time') or update_time or 0.0)
        msg_model = metadata.get('model_slug') or model_slug

        # Build attachment lookup map for this message
        att_list = metadata.get('attachments') or []
        att_map = {}
        if isinstance(att_list, list):
            for att in att_list:
                if isinstance(att, dict) and att.get('id'):
                    clean_aid = att['id'].replace('file-service://', '').replace('sediment://', '')
                    att_map[clean_aid] = att

        # Extract text and multimodal content from parts
        content_parts = []
        referenced_ids = set()

        if isinstance(content_obj, dict):
            parts = content_obj.get('parts', [])
            for p in parts:
                if isinstance(p, str):
                    content_parts.append(p)
                elif isinstance(p, dict):
                    # Handle text field
                    if p.get('text'):
                        content_parts.append(p['text'])
                    # Handle image/multimodal asset pointers
                    elif p.get('asset_pointer') or p.get('content_type') == 'image_asset_pointer':
                        ptr = p.get('asset_pointer') or ''
                        clean_id = ptr.replace('file-service://', '').replace('sediment://', '')
                        if clean_id:
                            referenced_ids.add(clean_id)

                        pmeta = p.get('metadata') or {}
                        gen_id = (pmeta.get('dalle') or {}).get('gen_id') or (pmeta.get('generation') or {}).get('gen_id')
                        att_info = att_map.get(clean_id)
                        att_name = att_info.get('name') if att_info else None

                        rel_file = resolve_media(clean_id, aname=att_name, gen_id=gen_id, media_index=media_index)
                        if rel_file:
                            encoded_rel = urllib.parse.quote(rel_file.replace('\\', '/'), safe='/')
                            if is_image_file(rel_file) or p.get('content_type') == 'image_asset_pointer':
                                label = att_name or 'Image'
                                content_parts.append(f"![{label}](/api/attachments/{encoded_rel})")
                            elif any(rel_file.lower().endswith(ext) for ext in AUDIO_EXTENSIONS):
                                label = att_name or os.path.basename(rel_file)
                                content_parts.append(f"[Audio: {label}](/api/attachments/{encoded_rel})")
                            else:
                                label = att_name or os.path.basename(rel_file)
                                content_parts.append(f"[Attachment: {label}](/api/attachments/{encoded_rel})")
                        else:
                            if att_name:
                                content_parts.append(f"[Attachment: {att_name} (not found in export)]")
                            elif clean_id:
                                content_parts.append(f"[Attachment: {clean_id} (not found in export)]")
                    else:
                        content_parts.append(str(p))
            
            # Handle text field directly if parts was empty
            if not content_parts and content_obj.get('text'):
                content_parts.append(content_obj['text'])

        # Also check message metadata.attachments for images not explicitly in parts
        if isinstance(att_list, list):
            for att in att_list:
                if isinstance(att, dict):
                    aid = att.get('id', '')
                    clean_aid = aid.replace('file-service://', '').replace('sediment://', '')
                    aname = att.get('name', '')
                    if clean_aid and clean_aid not in referenced_ids:
                        referenced_ids.add(clean_aid)
                        rel_file = resolve_media(clean_aid, aname=aname, media_index=media_index)
                        if rel_file:
                            encoded_rel = urllib.parse.quote(rel_file.replace('\\', '/'), safe='/')
                            if is_image_file(rel_file):
                                content_parts.append(f"![{aname or 'Image'}](/api/attachments/{encoded_rel})")
                            else:
                                content_parts.append(f"[{aname or 'Attachment'}](/api/attachments/{encoded_rel})")

        full_content = "\n".join(content_parts).strip()
        is_hidden = bool(metadata.get('is_visually_hidden_from_conversation', False) or (not full_content and role in ('assistant', 'system')))

        # Calculate sibling index
        siblings = parent_to_children.get(parent_id, [node_id])
        try:
            sibling_idx = siblings.index(node_id)
        except ValueError:
            sibling_idx = 0

        parsed_messages.append({
            'id': node_id,
            'parent_id': parent_id,
            'role': role,
            'content': full_content,
            'created_at': msg_create_time,
            'model_slug': msg_model,
            'status': status,
            'is_hidden': is_hidden,
            'sibling_index': sibling_idx,
            'sibling_count': len(siblings),
            'children': children_ids,
            'metadata': metadata
        })

    from server.db import calculate_active_message_count
    active_count = calculate_active_message_count(current_node, parsed_messages)

    conv_metadata = {
        'id': conv_id,
        'title': title,
        'created_at': create_time,
        'updated_at': update_time,
        'current_node': current_node,
        'format': 'openai',
        'model_slug': model_slug,
        'message_count': active_count,
        'metadata': {
            'gizmo_id': raw_conv.get('gizmo_id'),
            'moderation_results': raw_conv.get('moderation_results')
        }
    }

    return conv_metadata, parsed_messages

def parse_claude_conversation(
    raw_conv: Dict[str, Any],
    media_index: Optional[Dict[str, str]] = None
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Parse a single Claude conversation export object."""
    conv_id = raw_conv.get('uuid') or raw_conv.get('id') or 'untitled'
    title = raw_conv.get('name') or raw_conv.get('title') or 'Untitled Conversation'
    created_at = float(raw_conv.get('created_at_ts') or 0.0)
    updated_at = float(raw_conv.get('updated_at_ts') or created_at)

    chat_messages = raw_conv.get('chat_messages', [])
    parsed_messages = []
    prev_id = None

    for idx, msg in enumerate(chat_messages):
        msg_id = msg.get('uuid') or f"{conv_id}_{idx}"
        role = 'user' if msg.get('sender') == 'human' else 'assistant'
        content = msg.get('text', '')
        created = float(msg.get('created_at_ts') or created_at)

        # Check Claude attachments or files
        extra_parts = []
        attachments = msg.get('attachments') or []
        files = msg.get('files') or []
        for att in (attachments + files):
            if isinstance(att, dict):
                file_name = att.get('file_name') or att.get('name')
                clean_id = att.get('id') or ''
                rel_file = resolve_media(clean_id, aname=file_name, media_index=media_index)
                if rel_file:
                    encoded_rel = urllib.parse.quote(rel_file.replace('\\', '/'), safe='/')
                    if is_image_file(rel_file):
                        extra_parts.append(f"![{file_name or 'Image'}](/api/attachments/{encoded_rel})")
                    else:
                        extra_parts.append(f"[{file_name or 'Attachment'}](/api/attachments/{encoded_rel})")

        if extra_parts:
            content = (content + "\n" + "\n".join(extra_parts)).strip()

        parsed_messages.append({
            'id': msg_id,
            'parent_id': prev_id,
            'role': role,
            'content': content,
            'created_at': created,
            'model_slug': 'claude',
            'status': 'finished_successfully',
            'is_hidden': False,
            'sibling_index': 0,
            'sibling_count': 1,
            'children': [],
            'metadata': msg.get('attachments', {})
        })
        # Link previous child
        if parsed_messages and idx > 0:
            parsed_messages[idx - 1]['children'] = [msg_id]
        prev_id = msg_id

    visible_count = len([m for m in parsed_messages if bool((m.get('content') or '').strip())])

    conv_metadata = {
        'id': conv_id,
        'title': title,
        'created_at': created_at,
        'updated_at': updated_at,
        'current_node': prev_id,
        'format': 'claude',
        'model_slug': 'claude',
        'message_count': visible_count,
        'metadata': {}
    }

    return conv_metadata, parsed_messages

def parse_zai_conversation(
    raw_conv: Dict[str, Any],
    media_index: Optional[Dict[str, str]] = None
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    """Parse a single Z.ai conversation export object."""
    conv_id = raw_conv.get('id') or 'untitled'
    chat_obj = raw_conv.get('chat') or {}
    title = raw_conv.get('title') or chat_obj.get('title') or 'Untitled Conversation'
    created_at = float(raw_conv.get('created_at') or (chat_obj.get('timestamp', 0) / 1000) or 0.0)
    updated_at = float(raw_conv.get('updated_at') or created_at)

    history = chat_obj.get('history') or {}
    current_id = history.get('currentId')
    message_map = history.get('messages') or {}

    parsed_messages = []
    for mid, node in message_map.items():
        parsed_messages.append({
            'id': mid,
            'parent_id': node.get('parentId'),
            'role': node.get('role', 'user'),
            'content': node.get('content', ''),
            'created_at': float(node.get('timestamp') or created_at),
            'model_slug': node.get('model') or node.get('modelName'),
            'status': 'finished_successfully' if node.get('done') else (node.get('status') or 'finished_successfully'),
            'is_hidden': False,
            'sibling_index': 0,
            'sibling_count': 1,
            'children': [],
            'metadata': node
        })

    # Active branch count from current_id
    active_count = 0
    curr = current_id
    visited = set()
    while curr and curr in message_map and curr not in visited:
        visited.add(curr)
        node = message_map[curr]
        if bool((node.get('content') or '').strip()):
            active_count += 1
        curr = node.get('parentId')

    conv_metadata = {
        'id': conv_id,
        'title': title,
        'created_at': created_at,
        'updated_at': updated_at,
        'current_node': current_id,
        'format': 'zai',
        'model_slug': None,
        'message_count': active_count or len(parsed_messages),
        'metadata': {}
    }
    return conv_metadata, parsed_messages

def parse_export_data(
    data: List[Dict[str, Any]],
    media_index: Optional[Dict[str, str]] = None
) -> List[Tuple[Dict[str, Any], List[Dict[str, Any]]]]:
    """Parse full export JSON array into list of (conv, messages) tuples with optional media indexing."""
    fmt = detect_format(data)
    results = []
    for raw in data:
        if fmt == 'openai':
            results.append(parse_openai_conversation(raw, media_index=media_index))
        elif fmt == 'claude':
            results.append(parse_claude_conversation(raw, media_index=media_index))
        elif fmt == 'zai':
            results.append(parse_zai_conversation(raw, media_index=media_index))
        elif fmt == 'normalized':
            # Handle normalized format
            msgs = []
            prev_id = None
            for m in raw.get('messages', []):
                mid = m.get('id') or f"{raw['id']}_{len(msgs)}"
                msgs.append({
                    'id': mid,
                    'parent_id': prev_id,
                    'role': m.get('role', 'user'),
                    'content': m.get('content', ''),
                    'created_at': float(m.get('created_at') or float(raw.get('created', 0.0))),
                    'model_slug': m.get('metadata', {}).get('model'),
                    'status': 'finished_successfully',
                    'is_hidden': False,
                    'sibling_index': 0,
                    'sibling_count': 1,
                    'children': []
                })
                if msgs and len(msgs) > 1:
                    msgs[-2]['children'] = [mid]
                prev_id = mid

            visible_count = len([m for m in msgs if bool((m.get('content') or '').strip())])
            conv_meta = {
                'id': raw['id'],
                'title': raw.get('title', 'Untitled'),
                'created_at': float(raw.get('created', 0.0)),
                'updated_at': float(raw.get('updated', 0.0)),
                'current_node': raw.get('current_node') or prev_id,
                'format': 'normalized',
                'model_slug': raw.get('model_slug'),
                'message_count': visible_count
            }
            results.append((conv_meta, msgs))
    return results
