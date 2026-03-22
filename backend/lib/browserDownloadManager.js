const crypto = require("node:crypto");
const { Readable } = require("node:stream");

const {
  buildSignedMediaUrl,
  createMediaHeaders,
  encryptMediaUrl,
  getCourseInfo,
  getVideoAccessToken,
} = require("./yanhe");

function joinMediaUrl(baseUrl, maybeRelativeUrl) {
  return new URL(maybeRelativeUrl, baseUrl).toString();
}

function sequenceToIvHex(sequence) {
  const buffer = Buffer.alloc(16, 0);
  buffer.writeBigUInt64BE(BigInt(sequence), 8);
  return buffer.toString("hex");
}

function parseAttributes(line) {
  const attributes = {};
  const payload = line.slice(line.indexOf(":") + 1);
  const pattern = /([A-Z0-9-]+)=("(?:[^"\\]|\\.)*"|[^,]*)/gi;
  let match = pattern.exec(payload);
  while (match) {
    const key = match[1];
    const rawValue = match[2];
    attributes[key] =
      rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue;
    match = pattern.exec(payload);
  }
  return attributes;
}

async function fetchSignedBuffer(url, videoToken, extraHeaders = {}) {
  const signedUrl = buildSignedMediaUrl(url, videoToken);
  const response = await fetch(signedUrl, {
    headers: createMediaHeaders(extraHeaders),
  });

  if (!response.ok) {
    throw new Error(`Media request failed with status ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

async function fetchSignedText(url, videoToken) {
  const signedUrl = buildSignedMediaUrl(url, videoToken);
  const response = await fetch(signedUrl, {
    headers: createMediaHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Playlist request failed with status ${response.status}`);
  }

  return {
    finalUrl: response.url,
    text: await response.text(),
  };
}

class BrowserDownloadManager {
  constructor() {
    this.downloads = new Map();
  }

  get(downloadId) {
    return this.downloads.get(downloadId) || null;
  }

  async prepareDownload({ token, courseId, sessionId, streamType }) {
    const course = await getCourseInfo(token, courseId);
    const session = course.sessions.find(
      (item) => String(item.sessionId) === String(sessionId) || String(item.videoId) === String(sessionId),
    );

    if (!session) {
      throw new Error("Selected session was not found.");
    }

    const mediaUrl = streamType === "vga" ? session.vgaUrl : session.mainUrl;
    if (!mediaUrl) {
      throw new Error("Selected stream is not available for this session.");
    }

    const videoToken = await getVideoAccessToken(token);
    const playlist = await this.resolvePlaylist(encryptMediaUrl(mediaUrl), videoToken);
    const downloadId = crypto.randomUUID();
    const fileName = `${course.title} - ${session.title} - ${streamType === "vga" ? "screen" : "main"}.mp4`
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const payload = {
      id: downloadId,
      token,
      videoToken,
      courseId,
      streamType,
      fileName,
      courseTitle: course.title,
      sessionTitle: session.title,
      createdAt: new Date().toISOString(),
      keys: playlist.keys,
      segments: playlist.segments,
    };

    this.downloads.set(downloadId, payload);

    return {
      downloadId,
      fileName,
      manifestUrl: `/api/downloads/${downloadId}/playlist.m3u8`,
      courseTitle: course.title,
      sessionTitle: session.title,
      totalSegments: playlist.segments.length,
      keys: playlist.keys.map((key) => ({
        id: key.id,
      })),
      segments: playlist.segments.map((segment, index) => ({
        index,
        duration: segment.duration,
        keyId: segment.keyId,
        ivHex: segment.ivHex,
      })),
    };
  }

  buildManifestText(downloadId) {
    const download = this.get(downloadId);
    if (!download) {
      throw new Error("Download session was not found.");
    }

    const lines = [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      "#EXT-X-TARGETDURATION:10",
      "#EXT-X-MEDIA-SEQUENCE:0",
    ];

    let previousKeyId = null;

    download.segments.forEach((segment, index) => {
      if (segment.keyId !== previousKeyId) {
        if (segment.keyId) {
          const keyPath = `/api/downloads/${encodeURIComponent(downloadId)}/keys/${encodeURIComponent(segment.keyId)}`;
          lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="${keyPath}",IV=0x${segment.ivHex}`);
        } else if (previousKeyId) {
          lines.push("#EXT-X-KEY:METHOD=NONE");
        }
        previousKeyId = segment.keyId;
      }

      lines.push(`#EXTINF:${segment.duration.toFixed(6)},`);
      lines.push(`/api/downloads/${encodeURIComponent(downloadId)}/segments/${index}`);
    });

    lines.push("#EXT-X-ENDLIST");
    return `${lines.join("\n")}\n`;
  }

  async resolvePlaylist(playlistUrl, videoToken) {
    const { finalUrl, text } = await fetchSignedText(playlistUrl, videoToken);

    if (text.includes("#EXT-X-STREAM-INF")) {
      const lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].startsWith("#EXT-X-STREAM-INF")) {
          const nextLine = lines[index + 1];
          if (nextLine) {
            return this.resolvePlaylist(joinMediaUrl(finalUrl, nextLine), videoToken);
          }
        }
      }

      throw new Error("Master playlist did not contain a playable media playlist.");
    }

    const lines = text.split(/\r?\n/);
    const keys = [];
    const segments = [];
    const keyMap = new Map();

    let mediaSequence = 0;
    let currentDuration = 0;
    let currentKey = null;
    let segmentCounter = 0;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = Number.parseInt(line.split(":")[1], 10) || 0;
        continue;
      }

      if (line.startsWith("#EXTINF:")) {
        currentDuration = Number.parseFloat(line.slice("#EXTINF:".length)) || 0;
        continue;
      }

      if (line.startsWith("#EXT-X-KEY")) {
        const attrs = parseAttributes(line);

        if (attrs.METHOD === "NONE") {
          currentKey = null;
          continue;
        }

        if (!attrs.URI) {
          throw new Error("Encrypted playlist is missing key URI.");
        }

        const keyUrl = joinMediaUrl(finalUrl, attrs.URI);
        const cacheKey = `${keyUrl}|${attrs.IV || ""}`;

        if (!keyMap.has(cacheKey)) {
          const keyId = crypto.randomUUID();
          const entry = {
            id: keyId,
            url: keyUrl,
          };
          keyMap.set(cacheKey, entry);
          keys.push(entry);
        }

        currentKey = {
          id: keyMap.get(cacheKey).id,
          ivHex: attrs.IV ? attrs.IV.replace(/^0x/i, "").toLowerCase() : null,
        };
        continue;
      }

      if (line.startsWith("#")) {
        continue;
      }

      const absoluteUrl = joinMediaUrl(finalUrl, line);
      const sequence = mediaSequence + segmentCounter;
      segments.push({
        url: absoluteUrl,
        duration: currentDuration,
        keyId: currentKey ? currentKey.id : null,
        ivHex: currentKey?.ivHex || sequenceToIvHex(sequence),
      });
      segmentCounter += 1;
      currentDuration = 0;
    }

    if (segments.length === 0) {
      throw new Error("Playlist did not contain any media segments.");
    }

    return {
      keys,
      segments,
    };
  }

  async getSegmentBuffer(downloadId, segmentIndex) {
    const download = this.get(downloadId);
    if (!download) {
      throw new Error("Download session was not found.");
    }

    const segment = download.segments[segmentIndex];
    if (!segment) {
      throw new Error("Segment was not found.");
    }

    return fetchSignedBuffer(segment.url, download.videoToken);
  }

  async getKeyBuffer(downloadId, keyId) {
    const download = this.get(downloadId);
    if (!download) {
      throw new Error("Download session was not found.");
    }

    const key = download.keys.find((item) => item.id === keyId);
    if (!key) {
      throw new Error("Key was not found.");
    }

    return fetchSignedBuffer(key.url, download.videoToken);
  }

  async pipeSegment(response, downloadId, segmentIndex) {
    const buffer = await this.getSegmentBuffer(downloadId, segmentIndex);
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "video/mp2t",
      "Content-Length": String(buffer.length),
    });
    Readable.from(buffer).pipe(response);
  }

  async pipeKey(response, downloadId, keyId) {
    const buffer = await this.getKeyBuffer(downloadId, keyId);
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/octet-stream",
      "Content-Length": String(buffer.length),
    });
    Readable.from(buffer).pipe(response);
  }

  pipeManifest(response, downloadId) {
    const manifest = this.buildManifestText(downloadId);
    response.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(manifest)),
    });
    response.end(manifest);
  }
}

module.exports = {
  BrowserDownloadManager,
};
