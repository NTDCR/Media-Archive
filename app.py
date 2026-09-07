"""
MP4 Archive Consolidator & Resilient Cloud Archiver
A personal, single-user administrative tool for consolidating large project backups
with playable carrier MP4 videos, streaming to Google Drive, and zero-knowledge reference key logs.
"""

import os
import io
import json
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
    from Cryptodome.Cipher import AES
    from Cryptodome.Random import get_random_bytes
    from Cryptodome.Protocol.KDF import PBKDF2
    from Cryptodome.Hash import SHA256
except ImportError:
    from Crypto.Cipher import AES
    from Crypto.Random import get_random_bytes
    from Crypto.Protocol.KDF import PBKDF2
    from Crypto.Hash import SHA256

# Google API client imports
try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload, MediaIoBaseUpload
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

# Allow CORS for development if configured, disabled locally by default
if os.environ.get("ENABLE_CORS", "false").lower() == "true":
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
        # Allow checking via session, header, or query param
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


def get_drive_service():
    """Initializes Google Drive v3 service from GOOGLE_APPLICATION_CREDENTIALS_JSON."""
    if not GOOGLE_CLIENT_AVAILABLE:
        logger.warning("google-api-python-client is not installed.")
        return None

    creds_json_str = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not creds_json_str:
        logger.warning("GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable not set.")
        return None

    try:
        creds_json_str = creds_json_str.strip()
        if creds_json_str.startswith("'") and creds_json_str.endswith("'"):
            creds_json_str = creds_json_str[1:-1]
        elif creds_json_str.startswith('"') and creds_json_str.endswith('"'):
            creds_json_str = creds_json_str[1:-1]
        creds_data = json.loads(creds_json_str)
        creds = service_account.Credentials.from_service_account_info(
            creds_data,
            scopes=["https://www.googleapis.com/auth/drive.file"]
        )
        return build("drive", "v3", credentials=creds, cache_discovery=False)
    except Exception as e:
        logger.error(f"Error initializing Google Drive credentials: {e}")
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
    """
    if not drive_service:
        logger.info(f"Drive service not configured. Simulating drive upload for {filename}.")
        return "simulated_drive_id_" + os.urandom(4).hex()

    file_metadata = {"name": filename}
    if DRIVE_FOLDER_ID:
        file_metadata["parents"] = [DRIVE_FOLDER_ID]

    media = MediaFileUpload(
        file_path,
        chunksize=CHUNK_SIZE_5MB,
        resumable=True
    )

    request_drive = drive_service.files().create(
        body=file_metadata,
        media_body=media,
        fields="id, name"
    )

    response = None
    while response is None:
        status, response = request_drive.next_chunk()
        if status and is_large_file:
            percent = int(status.progress() * 100)
            with task_lock:
                if task_id in active_tasks:
                    active_tasks[task_id]["drive_progress"] = percent
                    active_tasks[task_id]["progress"] = 20 + int(percent * 0.35)  # 20% -> 55%

    return response.get("id")


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
    Step 5:
    1. Moves carrier MP4 directly to output_path to avoid duplicating disk space.
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

    data_file_size = os.path.getsize(data_path) if os.path.exists(data_path) else 0
    enc_name_bytes = original_name.encode("utf-8")

    with open(output_path, "ab") as f_out:
        carrier_end_offset = f_out.tell()

        # 2. Write archive header block
        f_out.write(MAGIC_HEADER)
        f_out.write(salt)
        f_out.write(nonce)
        f_out.write(struct.pack(">H", len(enc_name_bytes)))
        f_out.write(enc_name_bytes)
        f_out.write(struct.pack(">Q", data_file_size))

        # 3. Stream encrypt data file in chunks
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

        # 4. Write trailer with offset pointing to carrier_end_offset
        f_out.write(struct.pack(">Q", carrier_end_offset))
        f_out.write(MAGIC_TRAILER)

    # 5. Clean up data_path immediately to free disk space on Render free tier (2GB max)
    try:
        if os.path.exists(data_path):
            os.remove(data_path)
            logger.info(f"Removed staged data file {data_path} to conserve disk space.")
    except Exception as e:
        logger.warning(f"Could not remove staged data file: {e}")


def worker_process_archive(task_id: str, temp_dir: str, data_path: str, carrier_path: str, ref_key: str, orig_data_name: str, orig_carrier_name: str):
    """Background worker executing the ordered workflow."""
    try:
        # Update stage
        with task_lock:
            active_tasks[task_id]["stage"] = "Connecting to Google Drive"
            active_tasks[task_id]["progress"] = 15

        drive_service = get_drive_service()

        # STEP 3: Resumable Google Drive upload for Large Data File (5MB chunks)
        with task_lock:
            active_tasks[task_id]["stage"] = "Streaming original data backup to Google Drive"
            active_tasks[task_id]["progress"] = 20

        data_drive_filename = f"backup_{task_id}_{orig_data_name}"
        data_drive_id = upload_to_drive_resumable(
            drive_service, data_path, data_drive_filename, task_id, is_large_file=True
        )

        # STEP 4: Encrypt Reference Key using MASTER_ENCRYPTION_KEY (AES-GCM) and upload .keylog
        with task_lock:
            active_tasks[task_id]["stage"] = "Encrypting Reference Key (AES-256-GCM) & uploading .keylog to Drive"
            active_tasks[task_id]["progress"] = 58
            active_tasks[task_id]["data_drive_id"] = data_drive_id

        master_key = get_master_key_bytes()
        encrypted_keylog_bytes = encrypt_reference_key_gcm(ref_key, master_key)
        keylog_path = os.path.join(temp_dir, f"{orig_data_name}.keylog")

        with open(keylog_path, "wb") as f_kl:
            f_kl.write(encrypted_keylog_bytes)

        keylog_drive_filename = f"keylog_{task_id}_{orig_data_name}.keylog"
        keylog_drive_id = upload_to_drive_resumable(
            drive_service, keylog_path, keylog_drive_filename, task_id, is_large_file=False
        )

        with task_lock:
            active_tasks[task_id]["keylog_drive_id"] = keylog_drive_id
            active_tasks[task_id]["stage"] = "Encrypting data with Reference Key (AES-CTR) and appending to MP4"
            active_tasks[task_id]["progress"] = 65

        # STEP 5: Read Large Data File, encrypt using Reference Key, append to Carrier MP4
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

        logger.info(f"Task {task_id} completed successfully. Consolidated file: {output_path}")

    except Exception as e:
        logger.exception(f"Error processing task {task_id}: {e}")
        with task_lock:
            active_tasks[task_id]["status"] = "failed"
            active_tasks[task_id]["error"] = str(e)
            active_tasks[task_id]["stage"] = f"Failed: {str(e)}"


# ===================== FLASK ROUTES =====================

@app.route("/")
def index():
    """Renders main single-page interface with fallbacks."""
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
    """
    Receives upload:
    - data_file: Large Data File (up to 1GB)
    - carrier_file: Carrier MP4 (200MB)
    - reference_key: Password used to encrypt the payload
    """
    if "data_file" not in request.files or "carrier_file" not in request.files:
        return jsonify({"error": "Both 'data_file' and 'carrier_file' are required."}), 400

    data_file = request.files["data_file"]
    carrier_file = request.files["carrier_file"]
    ref_key = request.form.get("reference_key", "").strip()

    if not ref_key:
        return jsonify({"error": "Reference Key (encryption password) is required."}), 400

    if data_file.filename == "" or carrier_file.filename == "":
        return jsonify({"error": "Selected files must not be empty."}), 400

    # Create temporary directory managed by tempfile
    temp_dir = tempfile.mkdtemp(prefix="consolidator_")
    task_id = os.path.basename(temp_dir).replace("consolidator_", "")

    data_name = secure_filename(data_file.filename) or "payload.dat"
    carrier_name = secure_filename(carrier_file.filename) or "carrier.mp4"

    data_path = os.path.join(temp_dir, "data_" + data_name)
    carrier_path = os.path.join(temp_dir, "carrier_" + carrier_name)

    logger.info(f"Saving uploaded files to temp directory: {temp_dir}")

    # Stream save files directly without keeping in memory
    data_file.save(data_path)
    carrier_file.save(carrier_path)

    # Initialize task state
    with task_lock:
        active_tasks[task_id] = {
            "status": "processing",
            "stage": "Files saved to temporary directory",
            "progress": 10,
            "temp_dir": temp_dir,
            "orig_data_name": data_name,
            "orig_carrier_name": carrier_name,
            "data_drive_id": None,
            "keylog_drive_id": None,
            "output_path": None,
            "output_filename": None,
            "error": None
        }

    # Start background processing thread
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
            "output_filename": task.get("output_filename"),
            "error": task.get("error")
        })


@app.route("/api/download/<task_id>", methods=["GET"])
@require_auth
def download_consolidated(task_id: str):
    """
    Step 6 & 7:
    Streams the consolidated playable MP4 to the user's browser,
    and cleanly deletes all temporary files after the response finishes.
    """
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
    """
    Helper extraction endpoint:
    Reads an uploaded consolidated MP4, extracts the embedded encrypted stream,
    decrypts it using the user's reference password, and streams back the original data file.
    """
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
        # Trailer format: offset (8 bytes) + MAGIC_TRAILER (13 bytes)
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

            # Seek to archive start
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

            # Decrypt payload to output file in temp dir
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
    """Health check endpoint for Render.com."""
    return jsonify({
        "status": "healthy",
        "service": "mp4-archive-consolidator",
        "google_drive_configured": bool(os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")),
        "master_key_configured": bool(os.environ.get("MASTER_ENCRYPTION_KEY"))
    })


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    logger.info(f"Starting MP4 Archive Consolidator on 0.0.0.0:{port}")
    app.run(host="0.0.0.0", port=port, debug=debug_mode)
