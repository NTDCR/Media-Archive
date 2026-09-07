import express from "express";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import { google } from "googleapis";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;
const app = express();

// Set body parsers for JSON and URL-encoded forms
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// File Upload Handler (Staged directly to OS temp disk to conserve RAM)
const uploadDir = path.join(os.tmpdir(), "arc_uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
    cb(null, `${Date.now()}_${Math.random().toString(36).substring(2, 8)}_${safeName}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB limit
});

// Environment Configuration & Defaults
let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
let MASTER_ENCRYPTION_KEY = process.env.MASTER_ENCRYPTION_KEY || "default-insecure-master-key-32b!";
let DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "";
let CUSTOM_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || "";

const MAGIC_HEADER = Buffer.from("ARC_MP4_V1\0", "binary");
const MAGIC_TRAILER = Buffer.from("_ARC_MP4_END_", "utf-8");

interface TaskRecord {
  id: string;
  status: "processing" | "completed" | "failed";
  stage: string;
  progress: number;
  tempDir: string;
  origDataName: string;
  origCarrierName: string;
  dataDriveId?: string | null;
  keylogDriveId?: string | null;
  driveFileLink?: string | null;
  keylogFileLink?: string | null;
  driveWarning?: string | null;
  outputPath?: string | null;
  outputFilename?: string | null;
  error?: string | null;
  createdAt: number;
}

const activeTasks = new Map<string, TaskRecord>();

// Clean up stale tasks older than 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [taskId, task] of activeTasks.entries()) {
    if (now - task.createdAt > 2 * 60 * 60 * 1000) {
      if (task.tempDir && fs.existsSync(task.tempDir)) {
        try { fs.rmSync(task.tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      activeTasks.delete(taskId);
    }
  }
}, 15 * 60 * 1000);

function getMasterKeyBytes(): Buffer {
  const raw = MASTER_ENCRYPTION_KEY.trim();
  if (raw.length === 64) {
    try {
      return Buffer.from(raw, "hex");
    } catch {
      // fallback
    }
  }
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

function extractCleanFolderId(rawId: string): string {
  if (!rawId) return "";
  const raw = rawId.trim().replace(/^["']|["']$/g, "");
  if (raw.includes("drive.google.com") || raw.includes("/folders/")) {
    const match = raw.match(/\/folders\/([a-zA-Z0-9_-]{15,})/);
    if (match) return match[1];
    const matchId = raw.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
    if (matchId) return matchId[1];
  }
  const clean = raw.split("?")[0].replace(/\/+$/, "");
  const matchPlain = clean.match(/([a-zA-Z0-9_-]{15,})/);
  return matchPlain ? matchPlain[1] : clean;
}

function getServiceAccountCredentials() {
  const candidates = [
    CUSTOM_SERVICE_ACCOUNT_JSON,
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    process.env.GOOGLE_APPLICATION_CREDENTIALS,
    process.env.GDRIVE_CREDENTIALS,
    process.env.SERVICE_ACCOUNT_JSON
  ];

  let rawVal: string | null = null;
  for (const c of candidates) {
    if (c && c.trim()) {
      const candidateStr = c.trim();
      if (fs.existsSync(candidateStr)) {
        try {
          rawVal = fs.readFileSync(candidateStr, "utf-8").trim();
          break;
        } catch {
          // ignore
        }
      } else {
        rawVal = candidateStr;
        break;
      }
    }
  }

  // Check standard secret file paths
  if (!rawVal) {
    const secretPaths = [
      "/etc/secrets/service_account.json",
      "/etc/secrets/credentials.json",
      path.join(process.cwd(), "service_account.json"),
      path.join(process.cwd(), "credentials.json")
    ];
    for (const sp of secretPaths) {
      if (fs.existsSync(sp)) {
        try {
          rawVal = fs.readFileSync(sp, "utf-8").trim();
          break;
        } catch {
          // ignore
        }
      }
    }
  }

  if (!rawVal) {
    return { credentials: null, error: "No Google Service Account credentials configured." };
  }

  // Strip surrounding quotes
  if ((rawVal.startsWith("'") && rawVal.endsWith("'")) || (rawVal.startsWith('"') && rawVal.endsWith('"'))) {
    rawVal = rawVal.slice(1, -1).trim();
  }

  // Try base64 decode
  if (!rawVal.startsWith("{")) {
    try {
      const decoded = Buffer.from(rawVal, "base64").toString("utf-8");
      if (decoded.trim().startsWith("{")) {
        rawVal = decoded.trim();
      }
    } catch {
      // ignore
    }
  }

  if (!rawVal.startsWith("{")) {
    return {
      credentials: null,
      error: `GOOGLE_APPLICATION_CREDENTIALS_JSON contains a key ID or hash ('${rawVal.substring(0, 16)}...'), NOT the full Service Account JSON. Please download the full Service Account JSON file from Google Cloud Console (IAM & Admin > Service Accounts > Keys > Add Key > JSON) and paste the entire JSON content { "type": "service_account", ... }.`
    };
  }

  try {
    const parsed = JSON.parse(rawVal);
    // Crucial fix: Render/Environment newline escaping
    if (parsed.private_key && typeof parsed.private_key === "string" && parsed.private_key.includes("\\n")) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return { credentials: parsed, error: null };
  } catch (err: any) {
    return { credentials: null, error: `Invalid JSON credentials format: ${err.message}` };
  }
}

function getGoogleDriveClient() {
  const { credentials, error } = getServiceAccountCredentials();
  if (!credentials) return { drive: null, error, clientEmail: null };

  try {
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.file"
      ]
    });
    const drive = google.drive({ version: "v3", auth });
    return { drive, error: null, clientEmail: credentials.client_email, projectId: credentials.project_id };
  } catch (err: any) {
    return { drive: null, error: `Auth error: ${err.message}`, clientEmail: credentials.client_email };
  }
}

// Uploads a file to Google Drive with folder fallback
async function uploadToDrive(drive: any, filePath: string, filename: string, folderId: string, onProgress?: (pct: number) => void) {
  const cleanFolder = extractCleanFolderId(folderId);
  const media = {
    body: fs.createReadStream(filePath)
  };

  const requestBody: any = {
    name: filename
  };
  if (cleanFolder) {
    requestBody.parents = [cleanFolder];
  }

  let response: any;
  let fallbackUsed = false;
  let warningMessage: string | null = null;

  try {
    response = await drive.files.create({
      requestBody,
      media,
      fields: "id, name, webViewLink, parents",
      supportsAllDrives: true
    });
  } catch (err: any) {
    // If folder was not shared with service account (404 or 403)
    const errStr = String(err.message || err);
    if (cleanFolder && (errStr.includes("File not found") || errStr.includes("notFound") || err.code === 404 || err.code === 403)) {
      fallbackUsed = true;
      const { clientEmail } = getGoogleDriveClient();
      warningMessage = `Folder '${cleanFolder}' is not shared with '${clientEmail || "Service Account"}'. File saved to Service Account Drive root. Share folder with Editor access to organize files there.`;
      
      delete requestBody.parents;
      response = await drive.files.create({
        requestBody,
        media: { body: fs.createReadStream(filePath) },
        fields: "id, name, webViewLink, parents",
        supportsAllDrives: true
      });
    } else {
      throw err;
    }
  }

  const fileId = response.data.id;
  const webLink = response.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`;

  // Attempt to set read permission
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
      supportsAllDrives: true
    });
  } catch {
    // Non-critical
  }

  return { fileId, webLink, warningMessage, fallbackUsed };
}

// Encrypt Reference Key using AES-256-GCM and MASTER_ENCRYPTION_KEY
function encryptReferenceKeyGcm(refKey: string, masterKeyBytes: Buffer): Buffer {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKeyBytes, nonce);
  const encrypted = Buffer.concat([cipher.update(refKey, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([nonce, authTag, encrypted]);
}

// Derive PBKDF2-HMAC-SHA256 (100,000 iterations)
function deriveUserAesKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 100000, 32, "sha256");
}

// Check admin auth middleware
function checkAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const authHeader = req.headers["x-admin-password"];
  const formPass = req.body?.admin_password || req.query?.admin_password;

  if (ADMIN_PASSWORD === "" || authHeader === ADMIN_PASSWORD || formPass === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: "Unauthorized: Invalid or missing administrator password" });
}

// ==================== REAL API ROUTES ====================

// 1. Health check
app.get("/api/health", (_req, res) => {
  const { drive, error, clientEmail } = getGoogleDriveClient();
  res.json({
    status: "healthy",
    service: "mp4-archive-consolidator-node",
    google_drive_configured: Boolean(drive),
    service_account_email: clientEmail || null,
    drive_error: error || null,
    folder_id_configured: Boolean(DRIVE_FOLDER_ID),
    admin_password_set: Boolean(ADMIN_PASSWORD)
  });
});

// 2. Auth verify
app.post("/api/auth/verify", (req, res) => {
  const { admin_password } = req.body || {};
  if (ADMIN_PASSWORD === "" || admin_password === ADMIN_PASSWORD) {
    return res.json({ authenticated: true, message: "Administrator authenticated successfully." });
  }
  return res.status(401).json({ authenticated: false, error: "Incorrect administrator password" });
});

// 3. Google Drive Diagnostics & Configuration
app.get("/api/drive/diagnose", async (req, res) => {
  const { drive, error, clientEmail, projectId } = getGoogleDriveClient();
  const folderRaw = DRIVE_FOLDER_ID;
  const cleanFolder = extractCleanFolderId(folderRaw);

  if (!drive) {
    return res.json({
      configured: false,
      client_email: clientEmail,
      project_id: projectId,
      error: error || "Google Service Account credentials not provided.",
      instruction: "Add GOOGLE_APPLICATION_CREDENTIALS_JSON in Render or Settings, or paste JSON into the configuration card."
    });
  }

  const result: any = {
    configured: true,
    client_email: clientEmail,
    project_id: projectId,
    folder_id_set: Boolean(cleanFolder),
    raw_folder_input: folderRaw,
    clean_folder_id: cleanFolder
  };

  if (cleanFolder) {
    try {
      const folderRes = await drive.files.get({
        fileId: cleanFolder,
        fields: "id, name, capabilities",
        supportsAllDrives: true
      });
      result.folder_accessible = true;
      result.folder_name = folderRes.data.name;
      result.message = `Verified! Google Drive folder '${folderRes.data.name}' is directly accessible by ${clientEmail}.`;
    } catch (err: any) {
      result.folder_accessible = false;
      result.error = `Folder access error: ${err.message}`;
      result.instruction = `Open Google Drive, right-click the folder, choose 'Share', and add '${clientEmail}' as 'Editor'.`;
    }
  } else {
    result.folder_accessible = false;
    result.instruction = `DRIVE_FOLDER_ID is not set. Uploads will be stored in the Service Account Drive root. To organize in your personal Drive, create a folder, share it with '${clientEmail}' as Editor, and set DRIVE_FOLDER_ID.`;
  }

  res.json(result);
});

// 4. Update Drive Config dynamically from web console
app.post("/api/drive/configure", checkAuth, (req, res) => {
  const { service_account_json, folder_id, admin_password, master_encryption_key } = req.body || {};

  if (service_account_json !== undefined) {
    CUSTOM_SERVICE_ACCOUNT_JSON = service_account_json;
  }
  if (folder_id !== undefined) {
    DRIVE_FOLDER_ID = folder_id.trim();
  }
  if (admin_password) {
    ADMIN_PASSWORD = admin_password.trim();
  }
  if (master_encryption_key) {
    MASTER_ENCRYPTION_KEY = master_encryption_key.trim();
  }

  const { drive, error, clientEmail } = getGoogleDriveClient();
  res.json({
    success: true,
    configured: Boolean(drive),
    client_email: clientEmail,
    clean_folder_id: extractCleanFolderId(DRIVE_FOLDER_ID),
    error
  });
});

// 5. Consolidate Files (REAL ARCHIVER PIPELINE)
app.post("/api/consolidate", checkAuth, upload.fields([
  { name: "data_file", maxCount: 1 },
  { name: "carrier_file", maxCount: 1 }
]), async (req: express.Request, res: express.Response) => {
  const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;
  const dataFile = files?.data_file?.[0];
  const carrierFile = files?.carrier_file?.[0];
  const refKey = (req.body?.reference_key || "").trim();

  if (!dataFile || !carrierFile) {
    return res.status(400).json({ error: "Both 'data_file' and 'carrier_file' are required." });
  }

  if (!refKey) {
    return res.status(400).json({ error: "Reference Key (encryption password) is required." });
  }

  const taskId = crypto.randomUUID().replace(/-/g, "").substring(0, 12);
  const taskTempDir = path.join(os.tmpdir(), `consolidator_${taskId}`);
  fs.mkdirSync(taskTempDir, { recursive: true });

  const stagedDataPath = path.join(taskTempDir, `data_${dataFile.originalname}`);
  const stagedCarrierPath = path.join(taskTempDir, `carrier_${carrierFile.originalname}`);

  fs.renameSync(dataFile.path, stagedDataPath);
  fs.renameSync(carrierFile.path, stagedCarrierPath);

  const task: TaskRecord = {
    id: taskId,
    status: "processing",
    stage: "Files received and staged on server",
    progress: 10,
    tempDir: taskTempDir,
    origDataName: dataFile.originalname,
    origCarrierName: carrierFile.originalname,
    createdAt: Date.now()
  };

  activeTasks.set(taskId, task);

  res.json({
    status: "started",
    task_id: taskId,
    message: "Consolidation pipeline successfully initiated on server."
  });

  // Execute Background Pipeline
  (async () => {
    try {
      // Step 3: Google Drive Backup
      task.stage = "Connecting to Google Drive...";
      task.progress = 18;

      const { drive, clientEmail } = getGoogleDriveClient();

      if (drive) {
        task.stage = `Uploading backup to Google Drive (${task.origDataName})...`;
        task.progress = 25;

        try {
          const driveFilename = `backup_${taskId}_${task.origDataName}`;
          const uploadRes = await uploadToDrive(drive, stagedDataPath, driveFilename, DRIVE_FOLDER_ID);
          task.dataDriveId = uploadRes.fileId;
          task.driveFileLink = uploadRes.webLink;
          if (uploadRes.warningMessage) {
            task.driveWarning = uploadRes.warningMessage;
          }
          task.progress = 55;
        } catch (driveErr: any) {
          console.error("Drive upload error:", driveErr);
          task.driveWarning = `Drive upload notice: ${driveErr.message || "Failed to upload to Drive"}. Continuing with local consolidation.`;
        }
      } else {
        task.driveWarning = "Google Drive credentials not set. File is being consolidated into carrier MP4.";
      }

      // Step 4: Encrypt Reference Key with AES-256-GCM & Save Keylog
      task.stage = "Encrypting Reference Key (AES-256-GCM) & generating keylog...";
      task.progress = 60;

      const masterKey = getMasterKeyBytes();
      const encryptedKeylog = encryptReferenceKeyGcm(refKey, masterKey);
      const keylogPath = path.join(taskTempDir, `${task.origDataName}.keylog`);
      fs.writeFileSync(keylogPath, encryptedKeylog);

      if (drive) {
        try {
          const keylogFilename = `keylog_${taskId}_${task.origDataName}.keylog`;
          const klRes = await uploadToDrive(drive, keylogPath, keylogFilename, DRIVE_FOLDER_ID);
          task.keylogDriveId = klRes.fileId;
          task.keylogFileLink = klRes.webLink;
        } catch (klErr: any) {
          console.warn("Keylog upload error:", klErr);
        }
      }

      // Step 5: Derive PBKDF2 AES-256 Key & Encrypt Data (AES-CTR) appending to MP4
      task.stage = "Encrypting data with Reference Key (AES-256-CTR) & packaging MP4...";
      task.progress = 70;

      const outputFilename = `consolidated_${path.parse(task.origCarrierName).name}.mp4`;
      const outputPath = path.join(taskTempDir, outputFilename);

      // Move carrier to output path
      fs.renameSync(stagedCarrierPath, outputPath);

      const carrierEndOffset = fs.statSync(outputPath).size;
      const dataFileSize = fs.statSync(stagedDataPath).size;

      const salt = crypto.randomBytes(16);
      const nonce = crypto.randomBytes(8);
      const userAesKey = deriveUserAesKey(refKey, salt);

      // 16-byte initial counter block: 8 bytes nonce + 8 bytes counter (0)
      const counterBlock = Buffer.alloc(16);
      nonce.copy(counterBlock, 0);
      const cipher = crypto.createCipheriv("aes-256-ctr", userAesKey, counterBlock);

      const outAppend = fs.createWriteStream(outputPath, { flags: "a" });

      // 1. Write Header
      outAppend.write(MAGIC_HEADER);
      outAppend.write(salt);
      outAppend.write(nonce);

      const filenameBytes = Buffer.from(task.origDataName, "utf8");
      const filenameLenBuf = Buffer.alloc(2);
      filenameLenBuf.writeUInt16BE(filenameBytes.length, 0);
      outAppend.write(filenameLenBuf);
      outAppend.write(filenameBytes);

      const payloadSizeBuf = Buffer.alloc(8);
      payloadSizeBuf.writeBigUInt64BE(BigInt(dataFileSize), 0);
      outAppend.write(payloadSizeBuf);

      // 2. Stream & Encrypt Data File
      const dataRead = fs.createReadStream(stagedDataPath);
      let processedBytes = 0;

      await new Promise<void>((resolve, reject) => {
        dataRead.on("data", (chunk: Buffer) => {
          const encChunk = cipher.update(chunk);
          outAppend.write(encChunk);
          processedBytes += chunk.length;
          if (dataFileSize > 0) {
            const pct = Math.min(96, 70 + Math.floor((processedBytes / dataFileSize) * 25));
            task.progress = pct;
          }
        });

        dataRead.on("end", () => {
          const finalChunk = cipher.final();
          if (finalChunk.length > 0) {
            outAppend.write(finalChunk);
          }

          // 3. Write Trailer: 8-byte carrier offset + MAGIC_TRAILER
          const offsetBuf = Buffer.alloc(8);
          offsetBuf.writeBigUInt64BE(BigInt(carrierEndOffset), 0);
          outAppend.write(offsetBuf);
          outAppend.write(MAGIC_TRAILER);
          outAppend.end();
        });

        outAppend.on("finish", () => resolve());
        dataRead.on("error", reject);
        outAppend.on("error", reject);
      });

      // Purge staging data file to free disk space immediately
      try {
        if (fs.existsSync(stagedDataPath)) fs.unlinkSync(stagedDataPath);
      } catch { /* ignore */ }

      task.stage = "Ready for download";
      task.progress = 100;
      task.status = "completed";
      task.outputPath = outputPath;
      task.outputFilename = outputFilename;

    } catch (err: any) {
      console.error(`Task ${taskId} error:`, err);
      task.status = "failed";
      task.error = err.message || String(err);
      task.stage = `Failed: ${task.error}`;
    }
  })();
});

// 6. Check Task Status
app.get("/api/status/:taskId", checkAuth, (req, res) => {
  const task = activeTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }

  res.json({
    task_id: task.id,
    status: task.status,
    stage: task.stage,
    progress: task.progress,
    data_drive_id: task.dataDriveId || null,
    keylog_drive_id: task.keylogDriveId || null,
    drive_file_link: task.driveFileLink || null,
    keylog_file_link: task.keylogFileLink || null,
    drive_warning: task.driveWarning || null,
    output_filename: task.outputFilename || null,
    error: task.error || null
  });
});

// 7. Download Consolidated MP4
app.get("/api/download/:taskId", checkAuth, (req, res) => {
  const task = activeTasks.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found" });
  }
  if (task.status !== "completed" || !task.outputPath || !fs.existsSync(task.outputPath)) {
    return res.status(400).json({ error: "Archive file is not ready or has been purged." });
  }

  const outputStat = fs.statSync(task.outputPath);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="${task.outputFilename}"`);
  res.setHeader("Content-Length", outputStat.size);

  const fileStream = fs.createReadStream(task.outputPath);
  fileStream.pipe(res);

  res.on("finish", () => {
    // Clean up temporary folder after completed download
    setTimeout(() => {
      try {
        if (fs.existsSync(task.tempDir)) {
          fs.rmSync(task.tempDir, { recursive: true, force: true });
        }
        activeTasks.delete(task.id);
      } catch (e) {
        console.error("Cleanup error:", e);
      }
    }, 5000);
  });
});

// 8. Real Extraction and Decryption
app.post("/api/extract", checkAuth, upload.single("consolidated_file"), async (req: express.Request, res: express.Response) => {
  const file = req.file;
  const password = (req.body?.reference_key || "").trim();

  if (!file) {
    return res.status(400).json({ error: "Missing 'consolidated_file'." });
  }
  if (!password) {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(400).json({ error: "Reference password is required to decrypt." });
  }

  const extractTempDir = path.join(os.tmpdir(), `extract_${Date.now()}`);
  fs.mkdirSync(extractTempDir, { recursive: true });

  try {
    const fileStat = fs.statSync(file.path);
    const fileSize = fileStat.size;
    const trailerLen = 8 + MAGIC_TRAILER.length;

    if (fileSize < trailerLen) {
      throw new Error("File is too small to be a consolidated carrier MP4.");
    }

    const fd = fs.openSync(file.path, "r");

    // Read trailer: 8-byte offset + 13-byte magic trailer
    const trailerBuf = Buffer.alloc(trailerLen);
    fs.readSync(fd, trailerBuf, 0, trailerLen, fileSize - trailerLen);

    const archiveOffset = Number(trailerBuf.readBigUInt64BE(0));
    const magicTag = trailerBuf.subarray(8);

    if (!magicTag.equals(MAGIC_TRAILER) || archiveOffset >= fileSize) {
      throw new Error("Invalid consolidated carrier format: Archive end marker not found.");
    }

    // Read Header at archiveOffset
    const headerLead = Buffer.alloc(MAGIC_HEADER.length + 16 + 8 + 2); // magic + salt(16) + nonce(8) + fnameLen(2)
    fs.readSync(fd, headerLead, 0, headerLead.length, archiveOffset);

    const magicHeader = headerLead.subarray(0, MAGIC_HEADER.length);
    if (!magicHeader.equals(MAGIC_HEADER)) {
      throw new Error("Corrupted archive header marker.");
    }

    let pos = MAGIC_HEADER.length;
    const salt = headerLead.subarray(pos, pos + 16);
    pos += 16;
    const nonce = headerLead.subarray(pos, pos + 8);
    pos += 8;
    const fnameLen = headerLead.readUInt16BE(pos);
    pos += 2;

    const fnameAndSizeBuf = Buffer.alloc(fnameLen + 8);
    fs.readSync(fd, fnameAndSizeBuf, 0, fnameAndSizeBuf.length, archiveOffset + pos);

    const originalFilename = fnameAndSizeBuf.subarray(0, fnameLen).toString("utf8");
    const payloadSize = Number(fnameAndSizeBuf.readBigUInt64BE(fnameLen));

    const payloadStartOffset = archiveOffset + pos + fnameLen + 8;

    // Derive PBKDF2 Key
    const userAesKey = deriveUserAesKey(password, salt);
    const counterBlock = Buffer.alloc(16);
    nonce.copy(counterBlock, 0);
    const decipher = crypto.createDecipheriv("aes-256-ctr", userAesKey, counterBlock);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${originalFilename}"`);
    res.setHeader("Content-Length", payloadSize);

    // Stream & decrypt directly from file to response
    const readStream = fs.createReadStream(file.path, {
      start: payloadStartOffset,
      end: payloadStartOffset + payloadSize - 1
    });

    readStream.on("data", (chunk: Buffer) => {
      const decChunk = decipher.update(chunk);
      res.write(decChunk);
    });

    readStream.on("end", () => {
      const finalChunk = decipher.final();
      if (finalChunk.length > 0) res.write(finalChunk);
      res.end();
      fs.closeSync(fd);
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        fs.rmSync(extractTempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

    readStream.on("error", (err) => {
      fs.closeSync(fd);
      console.error("Stream extraction error:", err);
      try {
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        fs.rmSync(extractTempDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    });

  } catch (err: any) {
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      fs.rmSync(extractTempDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    return res.status(500).json({ error: `Extraction error: ${err.message}` });
  }
});

// ==================== VITE SPA MIDDLEWARE ====================

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[MP4 Consolidator] Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
