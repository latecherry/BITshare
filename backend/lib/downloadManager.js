const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
  buildSignedMediaUrl,
  createMediaHeaders,
  encryptMediaUrl,
  getAudioUrl,
  getVideoAccessToken,
} = require("./yanhe");

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function sanitizeName(value) {
  return String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function withSuffix(filePath, suffix) {
  const ext = path.extname(filePath);
  const name = path.basename(filePath, ext);
  const dir = path.dirname(filePath);
  return path.join(dir, `${name}${suffix}${ext}`);
}

function ensureUniqueFilePath(filePath) {
  if (!fs.existsSync(filePath)) {
    return filePath;
  }

  let index = 1;
  while (true) {
    const candidate = withSuffix(filePath, ` (${index})`);
    if (!fs.existsSync(candidate)) {
      return candidate;
    }
    index += 1;
  }
}

function joinMediaUrl(baseUrl, maybeRelativeUrl) {
  return new URL(maybeRelativeUrl, baseUrl).toString();
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }
  return response.text();
}

async function downloadBinaryFile(url, destinationPath, headers, retryCount = 4) {
  let lastError = null;
  for (let attempt = 0; attempt < retryCount; attempt += 1) {
    try {
      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(destinationPath, buffer);
      return;
    } catch (error) {
      lastError = error;
      await sleep(250 * (attempt + 1));
    }
  }

  throw lastError || new Error("Download failed.");
}

class DownloadManager {
  constructor(options = {}) {
    this.downloadRoot =
      options.downloadRoot || path.join(process.cwd(), "backend", "downloads");
    this.tasks = [];
    this.running = false;
  }

  async init() {
    await fsp.mkdir(this.downloadRoot, { recursive: true });
  }

  listTasks() {
    return this.tasks
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async enqueueMany(tasks) {
    const createdTasks = [];
    for (const taskInput of tasks) {
      createdTasks.push(await this.enqueue(taskInput));
    }
    return createdTasks;
  }

  async enqueue(taskInput) {
    await this.init();
    const courseFolder = sanitizeName(taskInput.courseTitle) || "Yanhe Course";
    const sessionTitle = sanitizeName(taskInput.session.title) || "Session";
    const professor = sanitizeName(taskInput.professor) || "Unknown Teacher";
    const streamLabel = taskInput.streamType === "vga" ? "screen" : "camera";
    const fileName = `${professor} - ${sessionTitle} - ${streamLabel}.mp4`;
    const outputDir = path.join(this.downloadRoot, courseFolder);
    await fsp.mkdir(outputDir, { recursive: true });

    const task = {
      id: crypto.randomUUID(),
      courseId: taskInput.courseId,
      courseTitle: taskInput.courseTitle,
      professor: taskInput.professor,
      session: taskInput.session,
      streamType: taskInput.streamType,
      includeAudio: Boolean(taskInput.includeAudio),
      token: taskInput.token,
      status: "queued",
      progress: 0,
      currentSegments: 0,
      totalSegments: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: "",
      outputDir,
      outputFile: ensureUniqueFilePath(path.join(outputDir, fileName)),
      audioFile: "",
      tempDir: "",
      cancelRequested: false,
      ffmpegProcess: null,
    };

    this.tasks.push(task);
    this.kick();
    return task;
  }

  async cancel(taskId) {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) {
      return false;
    }

    task.cancelRequested = true;
    task.updatedAt = new Date().toISOString();

    if (task.status === "queued") {
      task.status = "canceled";
    }

    if (task.ffmpegProcess) {
      task.ffmpegProcess.kill("SIGTERM");
    }

    return true;
  }

  kick() {
    if (!this.running) {
      this.running = true;
      void this.runLoop();
    }
  }

  async runLoop() {
    while (true) {
      const nextTask = this.tasks.find((task) => task.status === "queued");
      if (!nextTask) {
        this.running = false;
        return;
      }

      await this.processTask(nextTask);
    }
  }

  markProgress(task, partial) {
    Object.assign(task, partial, {
      updatedAt: new Date().toISOString(),
    });
  }

  async processTask(task) {
    const selectedUrl = task.streamType === "vga" ? task.session.vgaUrl : task.session.mainUrl;

    if (!selectedUrl) {
      this.markProgress(task, {
        status: "failed",
        error: "Selected stream is not available for this session.",
      });
      return;
    }

    task.tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "yanhe-download-"));
    this.markProgress(task, {
      status: "downloading",
      progress: 0,
      error: "",
    });

    try {
      const videoToken = await getVideoAccessToken(task.token);
      await this.downloadPlaylistToMp4(task, selectedUrl, videoToken);

      if (task.cancelRequested) {
        this.markProgress(task, {
          status: "canceled",
          error: "",
        });
        return;
      }

      if (task.includeAudio && task.session.videoId) {
        const audioUrl = await getAudioUrl(task.token, task.session.videoId);
        if (audioUrl) {
          task.audioFile = ensureUniqueFilePath(task.outputFile.replace(/\.mp4$/i, ".aac"));
          await this.downloadMediaBinary(task, audioUrl, task.audioFile, videoToken, {
            Host: "cvideo.yanhekt.cn",
          });
        }
      }

      this.markProgress(task, {
        status: "completed",
        progress: 100,
      });
    } catch (error) {
      this.markProgress(task, {
        status: task.cancelRequested ? "canceled" : "failed",
        error: error instanceof Error ? error.message : "Download failed.",
      });
    } finally {
      task.ffmpegProcess = null;
      if (task.tempDir) {
        await fsp.rm(task.tempDir, { recursive: true, force: true });
      }
    }
  }

  async downloadPlaylistToMp4(task, mediaUrl, videoToken) {
    const encryptedUrl = encryptMediaUrl(mediaUrl);
    const segmentsDir = path.join(task.tempDir, "segments");
    await fsp.mkdir(segmentsDir, { recursive: true });

    const playlist = await this.resolvePlaylist(encryptedUrl, videoToken);
    task.totalSegments = playlist.segments.length;
    task.currentSegments = 0;
    task.progress = 0;

    const localPlaylistLines = [];
    let keyIndex = 0;

    for (const item of playlist.items) {
      if (item.type === "raw") {
        localPlaylistLines.push(item.value);
        continue;
      }

      if (item.type === "key") {
        keyIndex += 1;
        const keyFileName = `key-${keyIndex}.bin`;
        const keyPath = path.join(segmentsDir, keyFileName);
        await this.downloadMediaBinary(task, item.url, keyPath, videoToken);
        localPlaylistLines.push(item.rewrittenLine.replace("__KEY_FILE__", `segments/${keyFileName}`));
        continue;
      }

      if (item.type === "segment") {
        localPlaylistLines.push(`segments/${item.fileName}`);
      }
    }

    await this.downloadSegments(task, playlist.segments, segmentsDir, videoToken);

    const playlistPath = path.join(task.tempDir, "playlist.m3u8");
    await fsp.writeFile(playlistPath, `${localPlaylistLines.join("\n")}\n`, "utf8");
    await this.mergePlaylist(task, playlistPath, task.outputFile);
  }

  async resolvePlaylist(playlistUrl, videoToken) {
    const signedUrl = buildSignedMediaUrl(playlistUrl, videoToken);
    const playlistText = await fetchText(signedUrl, createMediaHeaders());

    if (playlistText.includes("#EXT-X-STREAM-INF")) {
      const lines = playlistText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].startsWith("#EXT-X-STREAM-INF")) {
          const nestedUrl = joinMediaUrl(signedUrl, lines[index + 1]);
          return this.resolvePlaylist(nestedUrl, videoToken);
        }
      }
      throw new Error("Master playlist did not contain a playable stream.");
    }

    const lines = playlistText.split(/\r?\n/);
    const items = [];
    const segments = [];
    let segmentIndex = 0;

    for (const originalLine of lines) {
      const line = originalLine.trim();
      if (!line) {
        continue;
      }

      if (line.startsWith("#EXT-X-KEY")) {
        const match = line.match(/URI="([^"]+)"/);
        if (!match) {
          items.push({ type: "raw", value: line });
          continue;
        }

        const keyUrl = joinMediaUrl(signedUrl, match[1]);
        items.push({
          type: "key",
          url: keyUrl,
          rewrittenLine: line.replace(match[1], "__KEY_FILE__"),
        });
        continue;
      }

      if (line.startsWith("#")) {
        items.push({ type: "raw", value: line });
        continue;
      }

      const extension = path.extname(new URL(line, signedUrl).pathname) || ".ts";
      const fileName = `segment-${String(segmentIndex).padStart(5, "0")}${extension}`;
      const segment = {
        fileName,
        url: joinMediaUrl(signedUrl, line),
      };
      segments.push(segment);
      items.push({
        type: "segment",
        fileName,
      });
      segmentIndex += 1;
    }

    if (segments.length === 0) {
      throw new Error("Playlist did not contain any media segments.");
    }

    return {
      items,
      segments,
    };
  }

  async downloadSegments(task, segments, segmentsDir, videoToken) {
    const workerCount = Math.min(8, Math.max(2, os.cpus().length));
    let cursor = 0;

    const worker = async () => {
      while (true) {
        if (task.cancelRequested) {
          return;
        }

        const index = cursor;
        cursor += 1;
        if (index >= segments.length) {
          return;
        }

        const segment = segments[index];
        const segmentPath = path.join(segmentsDir, segment.fileName);
        await this.downloadMediaBinary(task, segment.url, segmentPath, videoToken);
        task.currentSegments += 1;
        task.progress = Math.round((task.currentSegments / task.totalSegments) * 100);
        task.updatedAt = new Date().toISOString();
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  async downloadMediaBinary(task, mediaUrl, destinationPath, videoToken, extraHeaders = {}) {
    if (task.cancelRequested) {
      throw new Error("Download canceled.");
    }

    const signedUrl = buildSignedMediaUrl(mediaUrl, videoToken);
    await downloadBinaryFile(signedUrl, destinationPath, createMediaHeaders(extraHeaders));
  }

  async mergePlaylist(task, playlistPath, outputFile) {
    await new Promise((resolve, reject) => {
      const ffmpegArgs = [
        "-y",
        "-allowed_extensions",
        "ALL",
        "-i",
        playlistPath,
        "-c",
        "copy",
        outputFile,
      ];
      const process = spawn("ffmpeg", ffmpegArgs, {
        cwd: task.tempDir,
        windowsHide: true,
      });

      task.ffmpegProcess = process;

      let stderr = "";
      process.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      process.on("error", (error) => {
        reject(error);
      });

      process.on("close", (code) => {
        if (task.cancelRequested) {
          reject(new Error("Download canceled."));
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
  }
}

module.exports = {
  DownloadManager,
};
