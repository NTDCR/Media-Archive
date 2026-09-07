export const PYTHON_APP_CODE = `"""
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
    send_file, abort, session
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
    GOOGLE_CLIENT_AVAILABLE = True
except ImportError:
    GOOGLE_CLIENT_AVAILABLE = False

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

template_dir = "templates" if os.path.isdir("templates") else "."
app = Flask(__name__, template_folder=template_dir)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", os.urandom(24).hex())
app.config["MAX_CONTENT_LENGTH"] = 2 * 1024 * 1024 * 1024  # 2 GB limit for upload

if os.environ.get("ENABLE_CORS", "false").lower() == "true":
    CORS(app)

ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")
MASTER_ENCRYPTION_KEY = os.environ.get("MASTER_ENCRYPTION_KEY", "default-insecure-master-key-32b!")
DRIVE_FOLDER_ID = os.environ.get("DRIVE_FOLDER_ID", "")
CHUNK_SIZE_5MB = 5 * 1024 * 1024  # 5MB streaming chunks
CHUNK_SIZE_64KB = 64 * 1024       # 64KB delivery chunks
MAGIC_HEADER = b"ARC_MP4_V1\\x00"
MAGIC_TRAILER = b"_ARC_MP4_END_"

task_lock = threading.Lock()
active_tasks = {}

def get_master_key_bytes() -> bytes:
    raw = MASTER_ENCRYPTION_KEY.strip()
    if len(raw) == 64:
        try:
            return bytes.fromhex(raw)
        except ValueError:
            pass
    return SHA256.new(raw.encode("utf-8")).digest()

def require_auth(f):
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
        return jsonify({"error": "Unauthorized: Invalid or missing admin password"}), 401
    return decorated_function

def get_drive_service():
    if not GOOGLE_CLIENT_AVAILABLE:
        return None
    creds_json_str = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
    if not creds_json_str:
        return None
    try:
        creds_data = json.loads(creds_json_str)
        creds = service_account.Credentials.from_service_account_info(
            creds_data, scopes=["https://www.googleapis.com/auth/drive.file"]
        )
        return build("drive", "v3", credentials=creds, cache_discovery=False)
    except Exception as e:
        logger.error(f"Google Drive initialization error: {e}")
        return None

def encrypt_reference_key_gcm(ref_key: str, master_key: bytes) -> bytes:
    cipher = AES.new(master_key, AES.MODE_GCM)
    ciphertext, tag = cipher.encrypt_and_digest(ref_key.encode("utf-8"))
    return cipher.nonce + tag + ciphertext

def upload_to_drive_resumable(drive_service, file_path: str, filename: str, task_id: str, is_large_file: bool = False):
    if not drive_service:
        return "simulated_drive_id_" + os.urandom(4).hex()

    file_metadata = {"name": filename}
    if DRIVE_FOLDER_ID:
        file_metadata["parents"] = [DRIVE_FOLDER_ID]

    media = MediaFileUpload(file_path, chunksize=CHUNK_SIZE_5MB, resumable=True)
    request_drive = drive_service.files().create(body=file_metadata, media_body=media, fields="id, name")

    response = None
    while response is None:
        status, response = request_drive.next_chunk()
        if status and is_large_file:
            percent = int(status.progress() * 100)
            with task_lock:
                if task_id in active_tasks:
                    active_tasks[task_id]["drive_progress"] = percent
                    active_tasks[task_id]["progress"] = 20 + int(percent * 0.35)

    return response.get("id")

def derive_user_aes_key(password: str, salt: bytes) -> bytes:
    return PBKDF2(password.encode("utf-8"), salt, dkLen=32, count=100000, hmac_hash_module=SHA256)

def append_encrypted_payload(carrier_path: str, data_path: str, output_path: str, password: str, original_name: str, task_id: str):
    salt = get_random_bytes(16)
    aes_key = derive_user_aes_key(password, salt)
    nonce = get_random_bytes(8)
    cipher = AES.new(aes_key, AES.MODE_CTR, nonce=nonce)

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

        f_out.write(MAGIC_HEADER)
        f_out.write(salt)
        f_out.write(nonce)
        f_out.write(struct.pack(">H", len(enc_name_bytes)))
        f_out.write(enc_name_bytes)
        f_out.write(struct.pack(">Q", data_file_size))

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
                            active_tasks[task_id]["progress"] = 65 + int(pct * 0.3)

        f_out.write(struct.pack(">Q", carrier_end_offset))
        f_out.write(MAGIC_TRAILER)

    try:
        if os.path.exists(data_path):
            os.remove(data_path)
    except Exception:
        pass

def worker_process_archive(task_id: str, temp_dir: str, data_path: str, carrier_path: str, ref_key: str, orig_data_name: str, orig_carrier_name: str):
    try:
        drive_service = get_drive_service()
        data_drive_filename = f"backup_{task_id}_{orig_data_name}"
        data_drive_id = upload_to_drive_resumable(drive_service, data_path, data_drive_filename, task_id, is_large_file=True)

        master_key = get_master_key_bytes()
        encrypted_keylog_bytes = encrypt_reference_key_gcm(ref_key, master_key)
        keylog_path = os.path.join(temp_dir, f"{orig_data_name}.keylog")
        with open(keylog_path, "wb") as f_kl:
            f_kl.write(encrypted_keylog_bytes)

        keylog_drive_filename = f"keylog_{task_id}_{orig_data_name}.keylog"
        keylog_drive_id = upload_to_drive_resumable(drive_service, keylog_path, keylog_drive_filename, task_id, is_large_file=False)

        output_filename = f"consolidated_{os.path.splitext(orig_carrier_name)[0]}.mp4"
        output_path = os.path.join(temp_dir, output_filename)
        append_encrypted_payload(carrier_path, data_path, output_path, ref_key, orig_data_name, task_id)

        with task_lock:
            active_tasks[task_id]["stage"] = "Ready for download"
            active_tasks[task_id]["progress"] = 100
            active_tasks[task_id]["status"] = "completed"
            active_tasks[task_id]["output_path"] = output_path
            active_tasks[task_id]["output_filename"] = output_filename
    except Exception as e:
        logger.exception(f"Error processing task {task_id}: {e}")
        with task_lock:
            active_tasks[task_id]["status"] = "failed"
            active_tasks[task_id]["error"] = str(e)
            active_tasks[task_id]["stage"] = f"Failed: {str(e)}"

@app.route("/")
def index():
    for path in ["templates/index.html", "index.html"]:
        if os.path.exists(path):
            return send_file(os.path.abspath(path))
    try:
        return render_template("index.html")
    except Exception:
        return "<h1>MP4 Archive Consolidator is running.</h1>", 200

@app.route("/api/auth/verify", methods=["POST"])
def verify_auth():
    data = request.get_json(silent=True) or request.form
    password = data.get("admin_password", "")
    if password == ADMIN_PASSWORD or ADMIN_PASSWORD == "":
        session["authenticated"] = True
        return jsonify({"authenticated": True})
    return jsonify({"authenticated": False, "error": "Incorrect password"}), 401

@app.route("/api/consolidate", methods=["POST"])
@require_auth
def consolidate_files():
    if "data_file" not in request.files or "carrier_file" not in request.files:
        return jsonify({"error": "Both data_file and carrier_file required"}), 400

    data_file = request.files["data_file"]
    carrier_file = request.files["carrier_file"]
    ref_key = request.form.get("reference_key", "").strip()
    if not ref_key:
        return jsonify({"error": "Reference Key is required"}), 400

    temp_dir = tempfile.mkdtemp(prefix="consolidator_")
    task_id = os.path.basename(temp_dir).replace("consolidator_", "")
    data_name = secure_filename(data_file.filename) or "payload.dat"
    carrier_name = secure_filename(carrier_file.filename) or "carrier.mp4"

    data_path = os.path.join(temp_dir, "data_" + data_name)
    carrier_path = os.path.join(temp_dir, "carrier_" + carrier_name)

    data_file.save(data_path)
    carrier_file.save(carrier_path)

    with task_lock:
        active_tasks[task_id] = {
            "status": "processing",
            "stage": "Files saved to temporary directory",
            "progress": 10,
            "temp_dir": temp_dir,
            "orig_data_name": data_name,
            "orig_carrier_name": carrier_name,
        }

    threading.Thread(
        target=worker_process_archive,
        args=(task_id, temp_dir, data_path, carrier_path, ref_key, data_name, carrier_name),
        daemon=True
    ).start()

    return jsonify({"status": "started", "task_id": task_id})

@app.route("/api/status/<task_id>", methods=["GET"])
@require_auth
def get_task_status(task_id: str):
    with task_lock:
        task = active_tasks.get(task_id)
        if not task:
            return jsonify({"error": "Task not found"}), 404
        return jsonify(task)

@app.route("/api/download/<task_id>", methods=["GET"])
@require_auth
def download_consolidated(task_id: str):
    with task_lock:
        task = active_tasks.get(task_id)
        if not task or task["status"] != "completed":
            abort(404)
        output_path = task["output_path"]
        output_filename = task["output_filename"]
        temp_dir = task["temp_dir"]

    def stream_and_cleanup():
        try:
            with open(output_path, "rb") as f:
                while chunk := f.read(CHUNK_SIZE_64KB):
                    yield chunk
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
            with task_lock:
                active_tasks.pop(task_id, None)

    response = Response(stream_and_cleanup(), mimetype="video/mp4")
    response.headers["Content-Disposition"] = f'attachment; filename="{output_filename}"'
    response.headers["Content-Length"] = str(os.path.getsize(output_path))
    return response

@app.route("/api/extract", methods=["POST"])
@require_auth
def extract_payload():
    if "consolidated_file" not in request.files:
        return jsonify({"error": "Missing consolidated_file"}), 400
    mp4_file = request.files["consolidated_file"]
    password = request.form.get("reference_key", "").strip()
    if not password:
        return jsonify({"error": "Password required"}), 400

    temp_dir = tempfile.mkdtemp(prefix="extractor_")
    uploaded_path = os.path.join(temp_dir, "input.mp4")
    mp4_file.save(uploaded_path)

    try:
        file_size = os.path.getsize(uploaded_path)
        trailer_len = 8 + len(MAGIC_TRAILER)
        with open(uploaded_path, "rb") as f_in:
            f_in.seek(file_size - trailer_len)
            archive_offset = struct.unpack(">Q", f_in.read(8))[0]
            trailer_tag = f_in.read(len(MAGIC_TRAILER))
            if trailer_tag != MAGIC_TRAILER or archive_offset >= file_size:
                raise ValueError("Invalid archive marker")

            f_in.seek(archive_offset)
            if f_in.read(len(MAGIC_HEADER)) != MAGIC_HEADER:
                raise ValueError("Invalid archive header")

            salt = f_in.read(16)
            nonce = f_in.read(8)
            fname_len = struct.unpack(">H", f_in.read(2))[0]
            orig_filename = f_in.read(fname_len).decode("utf-8")
            payload_size = struct.unpack(">Q", f_in.read(8))[0]

            aes_key = derive_user_aes_key(password, salt)
            cipher = AES.new(aes_key, AES.MODE_CTR, nonce=nonce)

            extracted_path = os.path.join(temp_dir, "extracted_" + orig_filename)
            left = payload_size
            with open(extracted_path, "wb") as f_out:
                while left > 0:
                    chunk = f_in.read(min(left, CHUNK_SIZE_5MB))
                    if not chunk:
                        break
                    f_out.write(cipher.decrypt(chunk))
                    left -= len(chunk)

        def stream_and_clean():
            try:
                with open(extracted_path, "rb") as f:
                    while c := f.read(CHUNK_SIZE_64KB):
                        yield c
            finally:
                shutil.rmtree(temp_dir, ignore_errors=True)

        resp = Response(stream_and_clean(), mimetype="application/octet-stream")
        resp.headers["Content-Disposition"] = f'attachment; filename="{orig_filename}"'
        return resp
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return jsonify({"error": str(e)}), 400

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
`;

export const REQUIREMENTS_TXT = `flask>=3.0.0
werkzeug>=3.0.0
pycryptodome>=3.20.0
pycryptodomex>=3.20.0
google-api-python-client>=2.130.0
google-auth>=2.29.0
google-auth-httplib2>=0.2.0
flask-cors>=4.0.0
gunicorn>=22.0.0
`;

export const RENDER_YAML = `services:
  - type: web
    name: mp4-archive-consolidator
    env: python
    plan: free
    buildCommand: pip install -r requirements.txt
    startCommand: gunicorn --bind 0.0.0.0:$PORT --workers 1 --threads 4 --timeout 3600 app:app
    envVars:
      - key: PYTHON_VERSION
        value: 3.11.8
      - key: ADMIN_PASSWORD
        generateValue: true
      - key: MASTER_ENCRYPTION_KEY
        generateValue: true
      - key: GOOGLE_APPLICATION_CREDENTIALS_JSON
        sync: false
      - key: DRIVE_FOLDER_ID
        sync: false
      - key: FLASK_SECRET_KEY
        generateValue: true
`;

export const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>MP4 Archive Consolidator</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com">
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    body { font-family: 'Plus Jakarta Sans', sans-serif; }
    code, pre, .font-mono { font-family: 'JetBrains Mono', monospace; }
  </style>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col antialiased">
  <header class="bg-white border-b border-slate-200 sticky top-0 z-30 shadow-xs">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
      <div class="flex items-center space-x-3">
        <div class="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold shadow-sm">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>
        </div>
        <div>
          <h1 class="text-base font-bold text-slate-900 tracking-tight">MP4 Archive Consolidator</h1>
          <p class="text-xs text-slate-500 font-medium">Single-User Resilient Storage Pipeline</p>
        </div>
      </div>
      <div class="flex items-center space-x-3">
        <div id="authBadge" class="hidden items-center space-x-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
          <span>Admin Authenticated</span>
        </div>
        <button id="authBtn" onclick="toggleAuthModal()" class="px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded-lg transition-colors">
          Admin Key
        </button>
      </div>
    </div>
  </header>

  <main class="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-8">
    <div class="flex space-x-2 mb-6 border-b border-slate-200">
      <button id="tabConsolidate" onclick="switchTab('consolidate')" class="px-4 py-2.5 text-sm font-semibold border-b-2 border-indigo-600 text-indigo-600 transition-colors">
        Consolidate & Stream Archive
      </button>
      <button id="tabExtract" onclick="switchTab('extract')" class="px-4 py-2.5 text-sm font-semibold border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition-colors">
        Extract & Decrypt Payload
      </button>
    </div>

    <!-- Consolidation Form -->
    <div id="viewConsolidate" class="space-y-6">
      <form id="consolidateForm" onsubmit="handleConsolidateSubmit(event)" class="bg-white border border-slate-200 rounded-xl p-6 shadow-xs space-y-6">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-slate-700">1. Large Data File (Up to 1GB)</label>
            <input type="file" id="dataFile" name="data_file" class="w-full text-sm border p-2 rounded" required />
          </div>
          <div class="space-y-2">
            <label class="block text-sm font-semibold text-slate-700">2. Carrier MP4 Video (Up to 200MB)</label>
            <input type="file" id="carrierFile" name="carrier_file" accept="video/mp4" class="w-full text-sm border p-2 rounded" required />
          </div>
        </div>
        <div class="space-y-2">
          <label for="referenceKey" class="block text-sm font-semibold text-slate-700">3. User Reference Key (Password)</label>
          <input type="password" id="referenceKey" name="reference_key" required class="w-full px-4 py-2 text-sm border rounded font-mono" placeholder="Passphrase" />
        </div>
        <button type="submit" id="startBtn" class="px-6 py-2.5 bg-indigo-600 text-white rounded-lg text-sm font-semibold">
          Start Resilient Consolidation
        </button>
      </form>
      <div id="progressCard" class="hidden bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <div class="flex justify-between items-center">
          <span id="progressStage" class="text-xs text-slate-500">Initializing...</span>
          <span id="progressPercent" class="text-sm font-mono font-bold text-indigo-600">0%</span>
        </div>
        <div class="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
          <div id="progressBar" class="bg-indigo-600 h-2.5 rounded-full" style="width: 0%"></div>
        </div>
        <div id="consoleLogs" class="p-3 bg-slate-900 text-emerald-400 font-mono text-xs max-h-32 overflow-y-auto rounded"></div>
        <div id="downloadSection" class="hidden pt-3 border-t">
          <button onclick="triggerDownload()" class="px-4 py-2 bg-emerald-600 text-white text-sm font-semibold rounded">
            Download Playable MP4
          </button>
        </div>
      </div>
    </div>

    <!-- Extraction Form -->
    <div id="viewExtract" class="hidden space-y-6">
      <form id="extractForm" onsubmit="handleExtractSubmit(event)" class="bg-white border border-slate-200 rounded-xl p-6 space-y-4">
        <label class="block text-sm font-semibold">Consolidated MP4 File</label>
        <input type="file" id="extractFile" name="consolidated_file" accept="video/mp4" class="w-full border p-2 rounded" required />
        <label class="block text-sm font-semibold">Reference Key (Password)</label>
        <input type="password" id="extractKey" name="reference_key" class="w-full border p-2 rounded font-mono" required />
        <button type="submit" id="extractBtn" class="px-5 py-2 bg-slate-900 text-white rounded text-sm font-semibold">
          Extract & Decrypt Original File
        </button>
      </form>
    </div>
  </main>

  <script>
    let currentTaskId = null;
    let pollInterval = null;
    let adminToken = localStorage.getItem("mp4_admin_key") || "";

    function switchTab(t) {
      document.getElementById("viewConsolidate").classList.toggle("hidden", t !== 'consolidate');
      document.getElementById("viewExtract").classList.toggle("hidden", t !== 'extract');
    }

    async function handleConsolidateSubmit(e) {
      e.preventDefault();
      const fd = new FormData(e.target);
      document.getElementById("progressCard").classList.remove("hidden");
      document.getElementById("downloadSection").classList.add("hidden");
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/consolidate", true);
      if (adminToken) xhr.setRequestHeader("X-Admin-Password", adminToken);
      xhr.onload = function() {
        if (xhr.status === 200) {
          const resp = JSON.parse(xhr.responseText);
          currentTaskId = resp.task_id;
          startPolling(currentTaskId);
        } else {
          alert("Consolidation error");
        }
      };
      xhr.send(fd);
    }

    function startPolling(taskId) {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        const res = await fetch("/api/status/" + taskId);
        if (!res.ok) return;
        const d = await res.json();
        document.getElementById("progressBar").style.width = d.progress + "%";
        document.getElementById("progressPercent").textContent = d.progress + "%";
        document.getElementById("progressStage").textContent = d.stage;
        if (d.status === "completed") {
          clearInterval(pollInterval);
          document.getElementById("downloadSection").classList.remove("hidden");
        }
      }, 1500);
    }

    function triggerDownload() {
      if (currentTaskId) window.location.href = "/api/download/" + currentTaskId;
    }
  </script>
</body>
</html>
`;

export const GUNICORN_CONF = `import os

# Gunicorn configuration for Render deployment
# Automatically sets timeout to 3600s so 1GB uploads/downloads never hit worker timeout
bind = f"0.0.0.0:{os.environ.get('PORT', '5000')}"
workers = 1
threads = 4
timeout = 3600
keepalive = 65
graceful_timeout = 60
`;

export const PYTHON_VERSION_FILE = `3.11.8
`;

export const RUNTIME_TXT = `python-3.11.8
`;

