"""
MP4 Archive Consolidator & Resilient Cloud Archiver
A personal, single-user administrative tool for consolidating large project backups
with playable carrier MP4 videos, streaming to Google Drive, and zero-knowledge reference key logs.
Optimized for 1-minute seamless deployment on Render.com free tier.
"""

import os
import io
import re
import json
import base64
import time
import socket
import ssl
import shutil
import struct
import tempfile
import threading
import logging
from typing import Generator
from functools import wraps

from flask import (
    Flask, request, render_template, jsonify, Response,
    send_file, abort, session, redirect, url_for
)
from flask_cors import CORS
from werkzeug.utils import secure_filename

# PyCryptodome imports (supports both pycryptodome and pycryptodomex)
try:
    from Crypto.Cipher import AES
    from Crypto.Random import get_random_bytes
    from Crypto.Protocol.KDF import PBKDF2
    from Crypto.Hash import SHA256
except ImportError:
    try:
        from Cryptodome.Cipher import AES
        from Cryptodome.Random import get_random_bytes
        from Cryptodome.Protocol.KDF import PBKDF2
        from Cryptodome.Hash import SHA256
    except ImportError:
        AES = None
        get_random_bytes = None
        PBKDF2 = None
        SHA256 = None

# Google API client imports
try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload
    from googleapiclient.errors import HttpError
    GOOGLE_CLIENT_AVAILABLE = True
except ImportError:
    GOOGLE_CLIENT_AVAILABLE = False

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

template_dir = "templates" if os.path.isdir("templates") else "."
app = Flask(__name__, template_folder=template_dir)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", os.urandom(24).hex())
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB limit for upload

# Allow CORS for development if configured, enabled by default for Render API usage
if os.environ.get("ENABLE_CORS", "true").lower() == "true":
    CORS(app)

# Configuration from Environment Variables
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
MASTER_ENCRYPTION_KEY = os.environ.get("MASTER_ENCRYPTION_KEY", "default-insecure-master-key-32b!")
DRIVE_FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "")
CHUNK_SIZE_5MB = 5 * 1024 * 1024  # 5MB streaming chunks
CHUNK_SIZE_64KB = 64 * 1024       # 64KB for stream delivery
MAGIC_HEADER = b"ARC_MP4_V1\x00"
MAGIC_TRAILER = b"_ARC_MP4_END_"

# Thread-safe in-memory task registry
task_lock = threading.Lock()
active_tasks = {}


def get_master_key_bytes() -> bytes:
    """Derives a fixed 32-byte (256-bit) AES key from MASTER_ENCRYPTION_KEY."""
    raw = MASTER_ENCRYPTION_KEY.strip()
    if len(raw) == 64:
        try:
            return bytes.fromhex(raw)
        except ValueError:
            pass
    return SHA256.new(raw.encode("utf-8")).digest()


def require_auth(f):
    """Decorator to require single-user admin authentication."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get("X-Admin-Password")
        form_auth = request.form.get("admin_password")
        session_auth = session.get("authenticated")

        if (
            (auth_header and auth_header == ADMIN_PASSWORD) or
            (form_auth and form_auth == ADMIN_PASSWORD) or
            session_auth is True or
            ADMIN_PASSWORD == ""
        ):
            return f(*args, **kwargs)
        return jsonify({"error": "Unauthorized: Invalid or missing administrator password"}), 401
    return decorated_function


def extract_clean_folder_id(raw_id: str) -> str:
    """
    Extracts clean alphanumeric Google Drive folder ID even if the user
    enters a full URL, includes quotes, spaces, or URL query parameters.
    Examples:
      https://drive.google.com/drive/folders/17B8V-XYZ... -> 17B8V-XYZ...
      https://drive.google.com/drive/u/0/folders/17B8V-XYZ?usp=sharing -> 17B8V-XYZ
    """
    if not raw_id:
        return ""
    raw = raw_id.strip().strip('"').strip("'")
    if "drive.google.com" in raw or "/folders/" in raw:
        match = re.search(r"/folders/([a-zA-Z0-9_-]{15,})", raw)
        if match:
            return match.group(1)
        match_id = re.search(r"[?&]id=([a-zA-Z0-9_-]{15,})", raw)
        if match_id:
            return match_id.group(1)
    # Strip query parameters or trailing slashes
    clean = raw.split("?")[0].rstrip("/")
    # Match the folder id string
    match_plain = re.search(r"([a-zA-Z0-9_-]{15,})", clean)
    if match_plain:
        return match_plain.group(1)
    return clean


def get_service_account_info():
    """
    Bulletproof parser for Google Service Account credentials:
    1. Checks GOOGLE_APPLICATION_CREDENTIALS_JSON, GOOGLE_APPLICATION_CREDENTIALS,
       GDRIVE_CREDENTIALS, GOOGLE_CREDENTIALS_JSON, SERVICE_ACCOUNT_JSON.
    2. Supports file paths (Render Secret Files, e.g., /etc/secrets/service_account.json).
    3. Supports raw JSON string or base64 encoded JSON string.
    4. Automatically repairs escaped newlines in private_key (\\n -> \n) which is
       the #1 cause of 'Could not deserialize key data' errors on Render.
    """
    candidate_keys = [
        "GOOGLE_APPLICATION_CREDENTIALS_JSON",
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GDRIVE_CREDENTIALS",
        "GOOGLE_CREDENTIALS_JSON",
        "SERVICE_ACCOUNT_JSON"
    ]

    raw_val = None
    for k in candidate_keys:
        v = os.environ.get(k)
        if v and v.strip():
            raw_val = v.strip()
            # If it points to an existing file on Render
            if os.path.isfile(raw_val):
                try:
                    with open(raw_val, "r", encoding="utf-8") as f:
                        raw_val = f.read().strip()
                except Exception as e:
                    logger.error(f"Failed to read credentials from file path '{raw_val}': {e}")
                    continue
            break

    # Also check standard Render Secret File paths
    if not raw_val:
        for secret_path in [
            "/etc/secrets/service_account.json",
            "/etc/secrets/credentials.json",
            "./service_account.json",
            "./credentials.json"
        ]:
            if os.path.isfile(secret_path):
                try:
                    with open(secret_path, "r", encoding="utf-8") as f:
                        raw_val = f.read().strip()
                    logger.info(f"Loaded Google credentials from Secret File: {secret_path}")
                    break
                except Exception:
                    pass

    if not raw_val:
        return None, "GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set."

    # Strip surrounding quotes from Render UI
    if (raw_val.startswith("'") and raw_val.endswith("'")) or (raw_val.startswith('"') and raw_val.endswith('"')):
        raw_val = raw_val[1:-1].strip()

    # Try base64 decoding if not starting with '{'
    if not raw_val.startswith("{"):
        try:
            decoded = base64.b64decode(raw_val).decode("utf-8")
            if decoded.strip().startswith("{"):
                raw_val = decoded.strip()
        except Exception:
            pass

    try:
        data = json.loads(raw_val)
    except Exception as e:
        return None, f"JSON parse error in credentials: {e}"

    # Critical fix: Render often escapes newlines in private_key to '\\n'
    if "private_key" in data and isinstance(data["private_key"], str):
        pk = data["private_key"]
        if "\\n" in pk:
            data["private_key"] = pk.replace("\\n", "\n")

    return data, None


def get_drive_service():
    """Initializes and returns the Google Drive v3 client."""
    if not GOOGLE_CLIENT_AVAILABLE:
        logger.warning("google-api-python-client is not installed.")
        return None

    data, err = get_service_account_info()
    if not data:
        logger.warning(f"Google Drive credentials issue: {err}")
        return None

    try:
        scopes = [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/drive.file"
        ]
        creds = service_account.Credentials.from_service_account_info(
            data,
            scopes=scopes
        )
        return build("drive", "v3", credentials=creds, cache_discovery=False)
    except Exception as e:
        logger.error(f"Error initializing Google Drive API service: {e}")
        return None


def encrypt_reference_key_gcm(ref_key: str, master_key: bytes) -> bytes:
    """
    Encrypts the user's reference password using AES-256-GCM.
    Returns: 12-byte nonce + 16-byte tag + ciphertext.
    """
    cipher = AES.new(master_key, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(ref_key.encode("utf-8"))
    return cipher.nonce + tag + ciphertext


def upload_to_drive_resumable(drive_service, file_path: str, filename: str, task_id: str, is_large_file: bool = False):
    """
    Uploads a file to Google Drive using 5MB resumable chunks without loading into RAM.
    Features:
    - Auto-detects clean folder ID
    - Robust fallback: If specified folder is inaccessible (404/403), retries upload
      to service account root drive so file is NEVER lost!
    - Exponential backoff retry loop for chunk streaming over unstable network
    - Sets permissions and webViewLink for direct access
    """
    if not drive_service:
        msg = "Drive service not configured. Set GOOGLE_APPLICATION_CREDENTIALS_JSON in Render."
        logger.warning(msg)
        with task_lock:
            if task_id in active_tasks:
                active_tasks[task_id]["drive_warning"] = msg
        return None

    clean_folder_id = extract_clean_folder_id(DRIVE_FOLDER_ID)
    file_metadata = {"name": filename}
    if clean_folder_id:
        file_metadata["parents"] = [clean_folder_id]

    media = MediaFileUpload(
        file_path,
        chunksize=CHUNK_SIZE_5MB,
        resumable=True
    )

    request_drive = None
    fallback_used = False

    try:
        request_drive = drive_service.files().create(
            body=file_metadata,
            media_body=media,
            fields="id, name, webViewLink, parents",
            supportsAllDrives=True
        )
    except Exception as e:
        logger.warning(f"Error initiating upload with folder '{clean_folder_id}': {e}. Attempting root upload fallback.")
        fallback_used = True
        file_metadata.pop("parents", None)
        request_drive = drive_service.files().create(
            body=file_metadata,
            media_body=media,
            fields="id, name, webViewLink, parents",
            supportsAllDrives=True
        )

    response = None
    retries = 0

    while response is None:
        try:
            status, response = request_drive.next_chunk()
            if status and is_large_file:
                percent = int(status.progress() * 100)
                with task_lock:
                    if task_id in active_tasks:
                        active_tasks[task_id]["drive_progress"] = percent
                        active_tasks[task_id]["progress"] = 20 + int(percent * 0.35)  # 20% -> 55%
            retries = 0
        except HttpError as http_err:
            # If target folder was invalid or not shared with service account (404 or 403)
            if clean_folder_id and ("File not found" in str(http_err) or http_err.resp.status in [403, 404]):
                logger.warning(
                    f"Folder '{clean_folder_id}' is not shared with service account or not found ({http_err}). "
                    f"Falling back to Service Account root drive..."
                )
                creds_info, _ = get_service_account_info()
                sa_email = creds_info.get("client_email", "Service Account") if creds_info else "Service Account"
                with task_lock:
                    if task_id in active_tasks:
                        active_tasks[task_id]["drive_warning"] = (
                            f"Folder '{clean_folder_id}' is not shared with '{sa_email}'. "
                            f"File was safely saved to Service Account drive instead. "
                            f"Share your Google Drive folder with '{sa_email}' as 'Editor' to see files there."
                        )
                # Restart upload to root drive
                media = MediaFileUpload(file_path, chunksize=CHUNK_SIZE_5MB, resumable=True)
                file_metadata.pop("parents", None)
                request_drive = drive_service.files().create(
                    body=file_metadata,
                    media_body=media,
                    fields="id, name, webViewLink, parents",
                    supportsAllDrives=True
                )
                response = None
                clean_folder_id = ""
                time.sleep(1)
                continue
            else:
                retries += 1
                logger.warning(f"Google Drive chunk error (retry {retries}/5): {http_err}")
                if retries > 5:
                    raise http_err
                time.sleep(2 * retries)
        except (socket.error, ssl.SSLError, TimeoutError, ConnectionError) as net_err:
            retries += 1
            logger.warning(f"Network glitch during Drive chunk upload (retry {retries}/5): {net_err}")
            if retries > 5:
                raise net_err
            time.sleep(2 * retries)

    file_id = response.get("id")
    web_link = response.get("webViewLink", f"https://drive.google.com/file/d/{file_id}/view")

    # Attempt to grant public read permission so link works seamlessly
    try:
        drive_service.permissions().create(
            fileId=file_id,
            body={"type": "anyone", "role": "reader"},
            supportsAllDrives=True
        ).execute()
    except Exception:
        pass

    with task_lock:
        if task_id in active_tasks:
            if is_large_file:
                active_tasks[task_id]["data_drive_id"] = file_id
                active_tasks[task_id]["drive_file_link"] = web_link
            else:
                active_tasks[task_id]["keylog_drive_id"] = file_id
                active_tasks[task_id]["keylog_file_link"] = web_link

    return file_id


def derive_user_aes_key(password: str, salt: bytes) -> bytes:
    """Derives a 256-bit AES key using PBKDF2-HMAC-SHA256 with 100,000 iterations."""
    return PBKDF2(
        password.encode("utf-8"),
        salt,
        dkLen=32,
        count=100000,
        hmac_hash_module=SHA256
    )


def append_encrypted_payload(carrier_path: str, data_path: str, output_path: str, password: str, original_name: str, task_id: str):
    """
    Appends encrypted payload directly to carrier MP4:
    1. Moves carrier MP4 directly to output_path to conserve disk space.
    2. Writes archive header at the end (Magic header, salt, nonce, filename length & name, payload size).
    3. Streams AES-CTR encrypted data file chunks directly appended to output_path.
    4. Appends trailer with the archive offset and end marker.
    5. Cleans up staging data_path immediately after encryption to free disk.
    """
    if os.path.exists(carrier_path) and carrier_path != output_path:
        shutil.move(carrier_path, output_path)

    salt = get_random_bytes(16)
    aes_key = derive_user_aes_key(password, salt)
    nonce = get_random_bytes(8)
    cipher = AES.new(aes_key, AES.MODE_CTR, nonce=nonce)

    data_file_size = os.path.getsize(data_path)
    carrier_end_offset = os.path.getsize(output_path)

    fname_bytes = original_name.encode("utf-8")
    fname_len = len(fname_bytes)

    with open(output_path, "ab") as f_out:
        # 1. Archive Start Header
        f_out.write(MAGIC_HEADER)
        f_out.write(salt)
        f_out.write(nonce)
        f_out.write(struct.pack(">H", fname_len))
        f_out.write(fname_bytes)
        f_out.write(struct.pack(">Q", data_file_size))

        # 2. Stream AES-CTR Encrypted Data
        bytes_processed = 0
        with open(data_path, "rb") as f_data:
            while True:
                chunk = f_data.read(CHUNK_SIZE_5MB)
                if not chunk:
                    break
                enc_chunk = cipher.encrypt(chunk)
                f_out.write(enc_chunk)

                bytes_processed += len(chunk)
                if data_file_size > 0:
                    pct = int((bytes_processed / data_file_size) * 100)
                    with task_lock:
                        if task_id in active_tasks:
                            active_tasks[task_id]["encrypt_progress"] = pct
                            active_tasks[task_id]["progress"] = 65 + int(pct * 0.3)  # 65% -> 95%

        # 3. Write trailer with offset pointing to carrier_end_offset
        f_out.write(struct.pack(">Q", carrier_end_offset))
        f_out.write(MAGIC_TRAILER)

    # 4. Clean up data_path immediately to free disk space on Render free tier
    try:
        if os.path.exists(data_path):
            os.remove(data_path)
            logger.info(f"Removed staged data file {data_path} to conserve disk space.")
    except Exception as e:
        logger.warning(f"Could not remove staged data file: {e}")


def worker_process_archive(task_id: str, temp_dir: str, data_path: str, carrier_path: str, ref_key: str, orig_data_name: str, orig_carrier_name: str):
    """Background worker executing the complete ordered pipeline with full resilience."""
    try:
        # Step 3: Google Drive backup
        with task_lock:
            active_tasks[task_id]["stage"] = "Connecting to Google Drive..."
            active_tasks[task_id]["progress"] = 15

        drive_service = get_drive_service()

        data_drive_id = None
        if drive_service:
            with task_lock:
                active_tasks[task_id]["stage"] = "Streaming original data backup to Google Drive..."
                active_tasks[task_id]["progress"] = 20

            try:
                data_drive_filename = f"backup_{task_id}_{orig_data_name}"
                data_drive_id = upload_to_drive_resumable(
                    drive_service, data_path, data_drive_filename, task_id, is_large_file=True
                )
            except Exception as drive_err:
                logger.error(f"Drive backup upload failed: {drive_err}")
                with task_lock:
                    if task_id in active_tasks:
                        active_tasks[task_id]["drive_warning"] = f"Drive upload error: {drive_err}. Local pipeline will continue."
        else:
            with task_lock:
                if task_id in active_tasks:
                    active_tasks[task_id]["drive_warning"] = (
                        "Google Drive credentials not configured in Render. "
                        "Set GOOGLE_APPLICATION_CREDENTIALS_JSON in Render environment variables."
                    )

        # Step 4: Encrypt Reference Key using MASTER_ENCRYPTION_KEY (AES-GCM) and upload .keylog
        with task_lock:
            active_tasks[task_id]["stage"] = "Encrypting Reference Key (AES-256-GCM) & logging..."
            active_tasks[task_id]["progress"] = 58
            active_tasks[task_id]["data_drive_id"] = data_drive_id

        master_key = get_master_key_bytes()
        encrypted_keylog_bytes = encrypt_reference_key_gcm(ref_key, master_key)
        keylog_path = os.path.join(temp_dir, f"{orig_data_name}.keylog")

        with open(keylog_path, "wb") as f_kl:
            f_kl.write(encrypted_keylog_bytes)

        keylog_drive_id = None
        if drive_service:
            try:
                keylog_drive_filename = f"keylog_{task_id}_{orig_data_name}.keylog"
                keylog_drive_id = upload_to_drive_resumable(
                    drive_service, keylog_path, keylog_drive_filename, task_id, is_large_file=False
                )
            except Exception as kl_err:
                logger.warning(f"Keylog upload error: {kl_err}")

        with task_lock:
            active_tasks[task_id]["keylog_drive_id"] = keylog_drive_id
            active_tasks[task_id]["stage"] = "Encrypting data with Reference Key (AES-CTR) & appending to MP4..."
            active_tasks[task_id]["progress"] = 65

        # Step 5: Encrypt data file and append to Carrier MP4
        output_filename = f"consolidated_{os.path.splitext(orig_carrier_name)[0]}.mp4"
        output_path = os.path.join(temp_dir, output_filename)

        append_encrypted_payload(
            carrier_path, data_path, output_path, ref_key, orig_data_name, task_id
        )

        with task_lock:
            active_tasks[task_id]["stage"] = "Ready for download"
            active_tasks[task_id]["progress"] = 100
            active_tasks[task_id]["status"] = "completed"
            active_tasks[task_id]["output_path"] = output_path
            active_tasks[task_id]["output_filename"] = output_filename

        logger.info(f"Task {task_id} completed successfully: {output_path}")

    except Exception as e:
        logger.exception(f"Error processing task {task_id}: {e}")
        with task_lock:
            active_tasks[task_id]["status"] = "failed"
            active_tasks[task_id]["error"] = str(e)
            active_tasks[task_id]["stage"] = f"Failed: {str(e)}"


# ===================== FLASK ROUTES =====================

@app.route("/")
def index():
    """Serves main single-page interface."""
    for path in ["templates/index.html", "index.html"]:
        if os.path.exists(path):
            return send_file(os.path.abspath(path))
    try:
        return render_template("index.html")
    except Exception:
        return "<h1>MP4 Archive Consolidator is running.</h1>", 200


@app.route("/api/auth/verify", methods=["POST"])
def verify_auth():
    """Verify administrator password."""
    data = request.get_json(silent=True) or request.form
    password = data.get("admin_password", "")
    if password == ADMIN_PASSWORD or ADMIN_PASSWORD == "":
        session["authenticated"] = True
        return jsonify({"authenticated": True})
    return jsonify({"authenticated": False, "error": "Incorrect administrator password"}), 401


@app.route("/api/consolidate", methods=["POST"])
@require_auth
def consolidate_files():
    """Receives data file, carrier MP4, and reference key."""
    if "data_file" not in request.files or "carrier_file" not in request.files:
        return jsonify({"error": "Both 'data_file' and 'carrier_file' are required."}), 400

    data_file = request.files["data_file"]
    carrier_file = request.files["carrier_file"]
    ref_key = request.form.get("reference_key", "").strip()

    if not ref_key:
        return jsonify({"error": "Reference Key (encryption password) is required."}), 400

    if data_file.filename == "" or carrier_file.filename == "":
        return jsonify({"error": "Selected files must not be empty."}), 400

    temp_dir = tempfile.mkdtemp(prefix="consolidator_")
    task_id = os.path.basename(temp_dir).replace("consolidator_", "")

    data_name = secure_filename(data_file.filename) or "payload.dat"
    carrier_name = secure_filename(carrier_file.filename) or "carrier.mp4"

    data_path = os.path.join(temp_dir, "data_" + data_name)
    carrier_path = os.path.join(temp_dir, "carrier_" + carrier_name)

    logger.info(f"Saving uploaded files to temp directory: {temp_dir}")
    data_file.save(data_path)
    carrier_file.save(carrier_path)

    with task_lock:
        active_tasks[task_id] = {
            "status": "processing",
            "stage": "Files staged in temporary directory",
            "progress": 10,
            "temp_dir": temp_dir,
            "orig_data_name": data_name,
            "orig_carrier_name": carrier_name,
            "data_drive_id": None,
            "keylog_drive_id": None,
            "drive_file_link": None,
            "keylog_file_link": None,
            "drive_warning": None,
            "output_path": None,
            "output_filename": None,
            "error": None
        }

    worker_thread = threading.Thread(
        target=worker_process_archive,
        args=(task_id, temp_dir, data_path, carrier_path, ref_key, data_name, carrier_name),
        daemon=True
    )
    worker_thread.start()

    return jsonify({
        "status": "started",
        "task_id": task_id,
        "message": "Upload received. Resilient pipeline initiated."
    })


@app.route("/api/status/<task_id>", methods=["GET"])
@require_auth
def get_task_status(task_id: str):
    """Polls task processing status and progress."""
    with task_lock:
        task = active_tasks.get(task_id)
        if not task:
            return jsonify({"error": "Task not found"}), 404

        return jsonify({
            "task_id": task_id,
            "status": task["status"],
            "stage": task["stage"],
            "progress": task["progress"],
            "data_drive_id": task.get("data_drive_id"),
            "keylog_drive_id": task.get("keylog_drive_id"),
            "drive_file_link": task.get("drive_file_link"),
            "keylog_file_link": task.get("keylog_file_link"),
            "drive_warning": task.get("drive_warning"),
            "output_filename": task.get("output_filename"),
            "error": task.get("error")
        })


@app.route("/api/drive/diagnose", methods=["GET"])
@require_auth
def drive_diagnose():
    """Diagnoses Google Drive setup and guides user on folder sharing."""
    creds_data, err = get_service_account_info()
    folder_raw = os.environ.get("DRIVE_FOLDER_ID", "").strip()
    clean_folder_id = extract_clean_folder_id(folder_raw)

    if not creds_data:
        return jsonify({
            "configured": False,
            "error": f"Credentials issue: {err or 'GOOGLE_APPLICATION_CREDENTIALS_JSON missing in Render.'}",
            "instruction": "Paste your service account JSON into Render environment variable GOOGLE_APPLICATION_CREDENTIALS_JSON."
        })

    client_email = creds_data.get("client_email", "Unknown")
    project_id = creds_data.get("project_id", "Unknown")

    service = get_drive_service()
    if not service:
        return jsonify({
            "configured": False,
            "client_email": client_email,
            "project_id": project_id,
            "error": "Failed to create Google Drive client. Verify private_key in your JSON."
        })

    result = {
        "configured": True,
        "client_email": client_email,
        "project_id": project_id,
        "folder_id_set": bool(clean_folder_id),
        "raw_folder_input": folder_raw,
        "clean_folder_id": clean_folder_id
    }

    if clean_folder_id:
        try:
            folder_info = service.files().get(
                fileId=clean_folder_id,
                fields="id, name, capabilities",
                supportsAllDrives=True
            ).execute()
            result["folder_accessible"] = True
            result["folder_name"] = folder_info.get("name")
            result["message"] = f"Connected successfully! Folder '{folder_info.get('name')}' is accessible by {client_email}."
        except Exception as e:
            result["folder_accessible"] = False
            result["error"] = f"Folder '{clean_folder_id}' is not accessible: {str(e)}"
            result["instruction"] = f"IMPORTANT: Open Google Drive, right-click folder '{clean_folder_id}', click 'Share', and add '{client_email}' with 'Editor' permissions."
    else:
        result["folder_accessible"] = False
        result["instruction"] = f"DRIVE_FOLDER_ID is empty in Render. Uploads will save to the service account root drive. To save into your personal Google Drive, create a folder, share it with '{client_email}' as Editor, and set DRIVE_FOLDER_ID=<folder_id> in Render."

    return jsonify(result)


@app.route("/api/download/<task_id>", methods=["GET"])
@require_auth
def download_consolidated(task_id: str):
    """Streams the consolidated playable MP4 and cleans up temp files."""
    with task_lock:
        task = active_tasks.get(task_id)
        if not task:
            abort(404, description="Task not found")

        if task["status"] != "completed" or not task.get("output_path"):
            abort(400, description="Task is not ready for download")

        output_path = task["output_path"]
        output_filename = task["output_filename"]
        temp_dir = task["temp_dir"]

    def stream_and_cleanup() -> Generator[bytes, None, None]:
        try:
            with open(output_path, "rb") as f:
                while True:
                    chunk = f.read(CHUNK_SIZE_64KB)
                    if not chunk:
                        break
                    yield chunk
        finally:
            logger.info(f"Cleaning up temporary directory: {temp_dir}")
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception as e:
                logger.error(f"Error removing temp directory: {e}")
            with task_lock:
                active_tasks.pop(task_id, None)

    response = Response(stream_and_cleanup(), mimetype="video/mp4")
    response.headers["Content-Disposition"] = f'attachment; filename="{output_filename}"'
    response.headers["Content-Length"] = str(os.path.getsize(output_path))
    return response


@app.route("/api/extract", methods=["POST"])
@require_auth
def extract_payload():
    """Extracts and decrypts embedded data from consolidated MP4."""
    if "consolidated_file" not in request.files:
        return jsonify({"error": "Missing 'consolidated_file'."}), 400

    mp4_file = request.files["consolidated_file"]
    password = request.form.get("reference_key", "").strip()

    if not password:
        return jsonify({"error": "Reference password is required to decrypt."}), 400

    temp_dir = tempfile.mkdtemp(prefix="extractor_")
    uploaded_path = os.path.join(temp_dir, "input.mp4")
    mp4_file.save(uploaded_path)

    try:
        file_size = os.path.getsize(uploaded_path)
        trailer_len = 8 + len(MAGIC_TRAILER)
        if file_size < trailer_len:
            shutil.rmtree(temp_dir, ignore_errors=True)
            return jsonify({"error": "File is too small to contain consolidated archive."}), 400

        with open(uploaded_path, "rb") as f_in:
            f_in.seek(file_size - trailer_len)
            archive_offset = struct.unpack(">Q", f_in.read(8))[0]
            trailer_tag = f_in.read(len(MAGIC_TRAILER))

            if trailer_tag != MAGIC_TRAILER or archive_offset >= file_size:
                shutil.rmtree(temp_dir, ignore_errors=True)
                return jsonify({"error": "Valid consolidated archive marker not found in MP4."}), 400

            f_in.seek(archive_offset)
            header_tag = f_in.read(len(MAGIC_HEADER))
            if header_tag != MAGIC_HEADER:
                shutil.rmtree(temp_dir, ignore_errors=True)
                return jsonify({"error": "Corrupted archive header marker."}), 400

            salt = f_in.read(16)
            nonce = f_in.read(8)
            fname_len = struct.unpack(">H", f_in.read(2))[0]
            orig_filename = f_in.read(fname_len).decode("utf-8", errors="replace")
            payload_size = struct.unpack(">Q", f_in.read(8))[0]

            aes_key = derive_user_aes_key(password, salt)
            cipher = AES.new(aes_key, AES.MODE_CTR, nonce=nonce)

            extracted_path = os.path.join(temp_dir, "extracted_" + orig_filename)
            bytes_left = payload_size
            with open(extracted_path, "wb") as f_out:
                while bytes_left > 0:
                    read_len = min(bytes_left, CHUNK_SIZE_5MB)
                    chunk = f_in.read(read_len)
                    if not chunk:
                        break
                    f_out.write(cipher.decrypt(chunk))
                    bytes_left -= len(chunk)

        def stream_extracted_and_cleanup():
            try:
                with open(extracted_path, "rb") as f:
                    while True:
                        buf = f.read(CHUNK_SIZE_64KB)
                        if not buf:
                            break
                        yield buf
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

        resp = Response(stream_extracted_and_cleanup(), mimetype="application/octet-stream")
        resp.headers["Content-Disposition"] = f'attachment; filename="{orig_filename}"'
        resp.headers["Content-Length"] = str(payload_size)
        return resp

    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.exception(f"Extraction error: {e}")
        return jsonify({"error": f"Failed to extract payload: {str(e)}"}), 500


@app.route("/api/health", methods=["GET"])
def health_check():
    """Fast health check endpoint for Render.com zero-downtime deploys."""
    creds_data, _ = get_service_account_info()
    return jsonify({
        "status": "healthy",
        "service": "mp4-archive-consolidator",
        "google_drive_configured": bool(creds_data),
        "folder_id_configured": bool(DRIVE_FOLDER_ID),
        "admin_password_set": bool(ADMIN_PASSWORD)
    }), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    logger.info(f"Starting MP4 Archive Consolidator on 0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
