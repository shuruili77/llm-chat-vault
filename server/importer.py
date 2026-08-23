"""
Import CLI and engine for LLM Conversations Viewer.
Extracts and loads ZIP archives, directories, or JSON files into local SQLite database
and copies media attachments to the attachments storage directory with Windows long-path safety.
Supports single-file exports, chunked multi-file exports (conversations-000.json ...),
export_manifest.json, and conversation_asset_file_names.json mapping for .dat files.
"""

import sys
import os
import json
import shutil
import zipfile
import re
import mimetypes
from typing import Dict, Any, Optional, Tuple, List
from server.db import Database, DEFAULT_DB_PATH, get_default_attachments_dir
from server.parser import parse_export_data

MEDIA_EXTENSIONS = {
    '.png', '.jpg', '.jpeg', '.webp', '.jfif', '.gif', '.svg', '.bmp', '.avif',
    '.wav', '.mp3', '.m4a', '.ogg', '.aac', '.flac',
    '.mp4', '.webm', '.mov',
    '.pdf', '.txt', '.csv', '.json', '.dat'
}

NON_ATTACHMENT_JSONS = {
    'conversations.json', 'chat_history.json', 'chat.html', 'user.json',
    'shared_conversations.json', 'message_feedback.json', 'model_comparisons.json',
    'export_manifest.json', 'conversation_asset_file_names.json', 'ads.json'
}

def win_safe_path(p: str) -> str:
    """Return Windows extended-length path (\\\\?\\...) to bypass MAX_PATH 260 limit if on Windows."""
    if os.name == 'nt':
        abs_p = os.path.abspath(p)
        if not abs_p.startswith('\\\\?\\') and not abs_p.startswith('\\\\'):
            return f'\\\\?\\{abs_p}'
    return p

def build_media_index_entry(rel_path: str, media_index: Dict[str, str], mapped_original_name: Optional[str] = None):
    """Add multi-key lookup mappings for a relative attachment file."""
    rel_normalized = rel_path.replace('\\', '/')
    fname = os.path.basename(rel_normalized)
    name_no_ext, ext = os.path.splitext(fname)

    # 1. Exact relative path & base filename
    media_index[rel_normalized] = rel_normalized
    media_index[fname] = rel_normalized
    media_index[name_no_ext] = rel_normalized

    # 2. File ID prefix: e.g. "file-00jYTMg2M5kql4ncOVocsDyu.dat" -> "file-00jYTMg2M5kql4ncOVocsDyu"
    if '-' in fname:
        parts = fname.split('-')
        if len(parts) >= 2 and parts[0] == 'file':
            clean_part1 = parts[1].split('.')[0]
            file_id = f"{parts[0]}-{clean_part1}"
            media_index[file_id] = rel_normalized
            media_index[f"file-{parts[1]}"] = rel_normalized
        elif len(parts) > 1:
            media_index[parts[0]] = rel_normalized
            possible_uuid = parts[-1].split('.')[0]
            if len(possible_uuid) >= 8:
                media_index[possible_uuid] = rel_normalized

    # 3. Gen UUID / DALL-E pattern extraction
    if len(name_no_ext) >= 32:
        media_index[name_no_ext] = rel_normalized

    # 4. If an original human-readable or path name was mapped (e.g. from conversation_asset_file_names.json)
    if mapped_original_name:
        mapped_normalized = mapped_original_name.replace('\\', '/')
        mapped_fname = os.path.basename(mapped_normalized)
        mapped_name_no_ext, _ = os.path.splitext(mapped_fname)

        media_index[mapped_normalized] = rel_normalized
        media_index[mapped_fname] = rel_normalized
        media_index[mapped_name_no_ext] = rel_normalized

def load_asset_names_map_from_dir(dir_path: str) -> Dict[str, str]:
    """Load conversation_asset_file_names.json if present in directory."""
    asset_file = os.path.join(dir_path, 'conversation_asset_file_names.json')
    if os.path.exists(asset_file):
        try:
            with open(win_safe_path(asset_file), 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception as e:
            print(f"[Warning] Failed to parse conversation_asset_file_names.json: {e}", file=sys.stderr)
    return {}

def load_asset_names_map_from_zip(z: zipfile.ZipFile) -> Dict[str, str]:
    """Load conversation_asset_file_names.json if present in ZIP archive."""
    for name in z.namelist():
        if os.path.basename(name).lower() == 'conversation_asset_file_names.json':
            try:
                with z.open(name) as f:
                    return json.load(f)
            except Exception as e:
                print(f"[Warning] Failed to parse conversation_asset_file_names.json in zip: {e}", file=sys.stderr)
    return {}

def extract_media_from_zip(z: zipfile.ZipFile, attachments_dir: str) -> Dict[str, str]:
    """Extract media files from ZIP archive and build media index."""
    os.makedirs(win_safe_path(attachments_dir), exist_ok=True)
    media_index: Dict[str, str] = {}
    asset_map = load_asset_names_map_from_zip(z)

    for name in z.namelist():
        if name.endswith('/') or name.endswith('\\'):
            continue
        base_name = os.path.basename(name).lower()
        if base_name in NON_ATTACHMENT_JSONS:
            continue
        if re.match(r'^conversations(-\d+)?\.json$', base_name):
            continue

        _, ext = os.path.splitext(base_name)
        if ext in MEDIA_EXTENSIONS or base_name.startswith('file-') or base_name.startswith('file_'):
            clean_rel = os.path.normpath(name).lstrip('/\\')
            target_path = os.path.join(attachments_dir, clean_rel)

            try:
                if os.path.commonpath([os.path.abspath(attachments_dir), os.path.abspath(target_path)]) != os.path.abspath(attachments_dir):
                    continue
            except ValueError:
                continue

            try:
                safe_target = win_safe_path(target_path)
                safe_target_dir = os.path.dirname(safe_target)
                os.makedirs(safe_target_dir, exist_ok=True)
                with z.open(name) as src, open(safe_target, 'wb') as dst:
                    shutil.copyfileobj(src, dst)
                
                mapped_name = asset_map.get(base_name) or asset_map.get(clean_rel)
                build_media_index_entry(clean_rel, media_index, mapped_name)
            except Exception as e:
                print(f"[Warning] Could not extract media file {name}: {e}", file=sys.stderr)

    return media_index

def extract_media_from_directory(dir_path: str, attachments_dir: str) -> Dict[str, str]:
    """Copy media files from export directory into attachments directory and build index."""
    os.makedirs(win_safe_path(attachments_dir), exist_ok=True)
    media_index: Dict[str, str] = {}
    asset_map = load_asset_names_map_from_dir(dir_path)

    abs_src = os.path.abspath(dir_path)
    abs_dst = os.path.abspath(attachments_dir)

    for root, _, files in os.walk(dir_path):
        for f in files:
            base_lower = f.lower()
            if base_lower in NON_ATTACHMENT_JSONS:
                continue
            if re.match(r'^conversations(-\d+)?\.json$', base_lower):
                continue

            _, ext = os.path.splitext(base_lower)
            if ext in MEDIA_EXTENSIONS or base_lower.startswith('file-') or base_lower.startswith('file_'):
                src_path = os.path.join(root, f)
                rel_path = os.path.relpath(src_path, dir_path)
                clean_rel = os.path.normpath(rel_path).lstrip('/\\')
                target_path = os.path.join(attachments_dir, clean_rel)

                if abs_src != abs_dst:
                    try:
                        safe_src = win_safe_path(src_path)
                        safe_dst = win_safe_path(target_path)
                        safe_dst_dir = os.path.dirname(safe_dst)
                        os.makedirs(safe_dst_dir, exist_ok=True)
                        if not os.path.exists(safe_dst) or os.path.getsize(safe_dst) != os.path.getsize(safe_src):
                            shutil.copy2(safe_src, safe_dst)
                    except Exception as e:
                        print(f"[Warning] Could not copy media file {f}: {e}", file=sys.stderr)

                mapped_name = asset_map.get(f) or asset_map.get(clean_rel)
                build_media_index_entry(clean_rel, media_index, mapped_name)

    return media_index

def find_conversation_files_in_dir(dir_path: str) -> List[str]:
    """Find all conversation JSON files (single or chunked) in directory."""
    # 1. Single conversations.json or chat_history.json
    for cand in ['conversations.json', 'chat_history.json']:
        p = os.path.join(dir_path, cand)
        if os.path.exists(p):
            return [p]

    # 2. Chunked files: conversations-000.json, conversations-001.json, etc.
    try:
        entries = os.listdir(dir_path)
    except Exception:
        return []

    chunk_files = []
    chunk_pattern = re.compile(r'^conversations-\d+\.json$', re.IGNORECASE)
    for entry in entries:
        if chunk_pattern.match(entry):
            chunk_files.append(os.path.join(dir_path, entry))

    if chunk_files:
        chunk_files.sort()
        return chunk_files

    return []

def find_conversation_files_in_zip(z: zipfile.ZipFile) -> List[str]:
    """Find all conversation JSON files (single or chunked) in ZIP archive."""
    namelist = z.namelist()

    # 1. Single file match
    for name in namelist:
        base = os.path.basename(name).lower()
        if base in ('conversations.json', 'chat_history.json'):
            return [name]

    # 2. Chunked files match
    chunk_pattern = re.compile(r'(^|/)conversations-\d+\.json$', re.IGNORECASE)
    chunk_names = [name for name in namelist if chunk_pattern.search(name)]
    if chunk_names:
        chunk_names.sort()
        return chunk_names

    return []

def import_file(
    file_path: str,
    db_path: str = DEFAULT_DB_PATH,
    attachments_dir: Optional[str] = None
) -> Dict[str, Any]:
    """
    Import conversations from a .zip file, directory, or .json file into the SQLite database.
    Supports single JSON files, chunked multi-JSON exports (conversations-000.json ...),
    export_manifest.json directories, and links media attachments with full .dat resolution.
    """
    if not os.path.exists(file_path):
        raise FileNotFoundError(f"Path not found: {file_path}")

    if not attachments_dir:
        attachments_dir = get_default_attachments_dir(db_path)

    os.makedirs(win_safe_path(attachments_dir), exist_ok=True)
    db = Database(db_path)
    raw_data: List[Dict[str, Any]] = []
    media_index: Dict[str, str] = {}

    # Case 1: Directory import
    if os.path.isdir(file_path):
        conv_files = find_conversation_files_in_dir(file_path)
        if not conv_files:
            raise ValueError(f"Could not find conversations.json or conversations-*.json inside directory: {file_path}")

        media_index = extract_media_from_directory(file_path, attachments_dir)
        for cf in conv_files:
            with open(win_safe_path(cf), 'r', encoding='utf-8') as f:
                chunk = json.load(f)
                if isinstance(chunk, list):
                    raw_data.extend(chunk)
                elif isinstance(chunk, dict) and 'mapping' in chunk:
                    raw_data.append(chunk)

    # Case 2: ZIP archive import
    elif file_path.lower().endswith('.zip'):
        with zipfile.ZipFile(file_path, 'r') as z:
            conv_files = find_conversation_files_in_zip(z)
            if not conv_files:
                raise ValueError("Could not find conversations.json or conversations-*.json inside ZIP archive")

            media_index = extract_media_from_zip(z, attachments_dir)
            for cf in conv_files:
                with z.open(cf) as f:
                    chunk = json.load(f)
                    if isinstance(chunk, list):
                        raw_data.extend(chunk)
                    elif isinstance(chunk, dict) and 'mapping' in chunk:
                        raw_data.append(chunk)

    # Case 3: Single JSON file (or dropped export_manifest.json / chunk file)
    elif file_path.lower().endswith('.json'):
        base_name = os.path.basename(file_path).lower()
        json_parent = os.path.dirname(os.path.abspath(file_path))

        # If user dropped export_manifest.json or conversation_asset_file_names.json or conversations-000.json
        # and sibling chunks/conversations exist in that directory, automatically import all conversation files!
        sibling_chunks = find_conversation_files_in_dir(json_parent)
        if len(sibling_chunks) >= 1 and (base_name in NON_ATTACHMENT_JSONS or re.match(r'^conversations(-\d+)?\.json$', base_name)):
            media_index = extract_media_from_directory(json_parent, attachments_dir)
            for cf in sibling_chunks:
                with open(win_safe_path(cf), 'r', encoding='utf-8') as f:
                    chunk = json.load(f)
                    if isinstance(chunk, list):
                        raw_data.extend(chunk)
                    elif isinstance(chunk, dict) and 'mapping' in chunk:
                        raw_data.append(chunk)
        else:
            with open(win_safe_path(file_path), 'r', encoding='utf-8') as f:
                loaded = json.load(f)
                if isinstance(loaded, list):
                    raw_data = loaded
                elif isinstance(loaded, dict) and 'mapping' in loaded:
                    raw_data = [loaded]
                else:
                    raise ValueError(f"File {base_name} is not a valid conversation export or contains no conversation list.")
            media_index = extract_media_from_directory(json_parent, attachments_dir)

    else:
        raise ValueError("Unsupported input format. Please provide a .zip archive, directory, or .json file.")

    if not raw_data:
        raise ValueError("No conversations found in the specified export files.")

    parsed_pairs = parse_export_data(raw_data, media_index=media_index)
    total_messages = db.insert_conversations_batch(parsed_pairs)
    imported_count = len(parsed_pairs)

    return {
        "status": "success",
        "imported_conversations": imported_count,
        "imported_messages": total_messages,
        "extracted_attachments": len(media_index),
        "database_path": db_path,
        "attachments_dir": attachments_dir
    }

def main():
    if len(sys.argv) < 2:
        print("Usage: python -m server.importer <path_to_export_zip_folder_or_json> [db_path] [attachments_dir]")
        sys.exit(1)

    input_path = sys.argv[1]
    target_db = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DB_PATH
    target_att = sys.argv[3] if len(sys.argv) > 3 else get_default_attachments_dir(target_db)

    print(f"Importing {input_path} into {target_db} (attachments -> {target_att})...")
    try:
        res = import_file(input_path, target_db, target_att)
        print(f"Successfully imported {res['imported_conversations']} conversations ({res['imported_messages']} messages).")
        print(f"Extracted/Indexed {res['extracted_attachments']} media attachments.")
    except Exception as e:
        print(f"Import failed: {e}", file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
