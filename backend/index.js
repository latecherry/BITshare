const http = require("node:http");
const path = require("node:path");

const { BrowserDownloadManager } = require("./lib/browserDownloadManager");
const { DownloadManager } = require("./lib/downloadManager");
const {
  getCourseInfo,
  getCourseList,
  getSemesters,
  loginAndGetToken,
  verifyToken,
} = require("./lib/yanhe");

const PORT = Number.parseInt(process.env.PORT || "8787", 10);
const downloadManager = new DownloadManager({
  downloadRoot: path.join(__dirname, "downloads"),
});
const browserDownloadManager = new BrowserDownloadManager();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
      }
    });
    request.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    request.on("error", reject);
  });
}

function readArrayParam(url, key) {
  const values = url.searchParams.getAll(key);
  if (values.length > 0) {
    return values
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
  }

  const single = url.searchParams.get(key);
  if (!single) {
    return [];
  }
  return single
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeCourseItem(item) {
  return {
    id: String(item.id),
    title: item.name_zh,
    professors: Array.isArray(item.professors)
      ? item.professors.map((professor) =>
          typeof professor === "string" ? professor : professor?.name || "",
        )
      : [],
    schoolYear: item.school_year || "",
    semester: item.semester || "",
    collegeName: item.college_name || "",
    participantCount: item.participant_count || 0,
    classrooms: Array.isArray(item.classrooms) ? item.classrooms : [],
  };
}

function normalizeTask(task) {
  return {
    id: task.id,
    courseId: task.courseId,
    courseTitle: task.courseTitle,
    professor: task.professor,
    sessionTitle: task.session.title,
    sessionId: task.session.sessionId,
    streamType: task.streamType,
    includeAudio: task.includeAudio,
    status: task.status,
    progress: task.progress,
    currentSegments: task.currentSegments,
    totalSegments: task.totalSegments,
    outputFile: task.outputFile,
    audioFile: task.audioFile,
    outputDir: task.outputDir,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    sendJson(response, 204, {});
    return;
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, {
        ok: true,
        downloadRoot: downloadManager.downloadRoot,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJsonBody(request);
      if (!body.username || !body.password) {
        sendJson(response, 400, { error: "Username and password are required." });
        return;
      }

      const result = await loginAndGetToken(body.username, body.password);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/verify") {
      const body = await readJsonBody(request);
      if (!body.token) {
        sendJson(response, 400, { error: "Token is required." });
        return;
      }

      const result = await verifyToken(body.token);
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/semesters") {
      const semesters = await getSemesters();
      sendJson(response, 200, { semesters });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/courses") {
      const token = url.searchParams.get("token");
      if (!token) {
        sendJson(response, 400, { error: "Token is required." });
        return;
      }

      const page = Number.parseInt(url.searchParams.get("page") || "1", 10);
      const pageSize = Number.parseInt(url.searchParams.get("pageSize") || "12", 10);
      const semesters = readArrayParam(url, "semesters").map((value) => Number.parseInt(value, 10));
      const courseList = await getCourseList(token, {
        keyword: url.searchParams.get("keyword") || "",
        scope: url.searchParams.get("scope") || "all",
        page,
        pageSize,
        semesters: semesters.filter((value) => Number.isFinite(value)),
      });

      sendJson(response, 200, {
        currentPage: courseList.current_page,
        totalPages: courseList.last_page,
        total: courseList.total,
        items: (courseList.data || []).map(normalizeCourseItem),
      });
      return;
    }

    if (
      request.method === "GET" &&
      /^\/api\/courses\/[^/]+\/sessions$/.test(url.pathname)
    ) {
      const token = url.searchParams.get("token");
      if (!token) {
        sendJson(response, 400, { error: "Token is required." });
        return;
      }

      const courseId = decodeURIComponent(url.pathname.split("/")[3]);
      const course = await getCourseInfo(token, courseId);
      sendJson(response, 200, course);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/tasks") {
      sendJson(response, 200, {
        items: downloadManager.listTasks().map(normalizeTask),
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/downloads/prepare") {
      const body = await readJsonBody(request);
      const { token, courseId, sessionId, streamType } = body;

      if (!token || !courseId || !sessionId) {
        sendJson(response, 400, {
          error: "token, courseId and sessionId are required.",
        });
        return;
      }

      const payload = await browserDownloadManager.prepareDownload({
        token,
        courseId,
        sessionId,
        streamType: streamType === "vga" ? "vga" : "main",
      });

      sendJson(response, 200, payload);
      return;
    }

    if (request.method === "GET" && /^\/api\/downloads\/[^/]+\/segments\/\d+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const downloadId = decodeURIComponent(parts[3]);
      const segmentIndex = Number.parseInt(parts[5], 10);
      await browserDownloadManager.pipeSegment(response, downloadId, segmentIndex);
      return;
    }

    if (request.method === "GET" && /^\/api\/downloads\/[^/]+\/playlist\.m3u8$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const downloadId = decodeURIComponent(parts[3]);
      browserDownloadManager.pipeManifest(response, downloadId);
      return;
    }

    if (request.method === "GET" && /^\/api\/downloads\/[^/]+\/keys\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split("/");
      const downloadId = decodeURIComponent(parts[3]);
      const keyId = decodeURIComponent(parts[5]);
      await browserDownloadManager.pipeKey(response, downloadId, keyId);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/tasks") {
      const body = await readJsonBody(request);
      const { token, courseId, sessionIds, streamType, includeAudio } = body;

      if (!token || !courseId || !Array.isArray(sessionIds) || sessionIds.length === 0) {
        sendJson(response, 400, {
          error: "token, courseId and at least one selected session are required.",
        });
        return;
      }

      const course = await getCourseInfo(token, courseId);
      const sessionIdSet = new Set(sessionIds.map((value) => String(value)));
      const selectedSessions = course.sessions.filter(
        (session) =>
          sessionIdSet.has(String(session.sessionId)) || sessionIdSet.has(String(session.videoId)),
      );

      if (selectedSessions.length === 0) {
        sendJson(response, 400, { error: "No matching sessions were found." });
        return;
      }

      const tasks = await downloadManager.enqueueMany(
        selectedSessions.map((session) => ({
          token,
          courseId,
          courseTitle: course.title,
          professor: course.professor,
          session,
          streamType: streamType === "vga" ? "vga" : "main",
          includeAudio: Boolean(includeAudio),
        })),
      );

      sendJson(response, 201, {
        items: tasks.map(normalizeTask),
      });
      return;
    }

    if (request.method === "DELETE" && /^\/api\/tasks\/[^/]+$/.test(url.pathname)) {
      const taskId = decodeURIComponent(url.pathname.split("/")[3]);
      const canceled = await downloadManager.cancel(taskId);
      if (!canceled) {
        sendJson(response, 404, { error: "Task not found." });
        return;
      }
      sendJson(response, 200, { success: true });
      return;
    }

    sendJson(response, 404, { error: "Route not found." });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : "Unexpected server error.",
    });
  }
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(PORT, () => {
  console.log(`Yanhe backend listening on http://127.0.0.1:${PORT}`);
  console.log(`Downloads directory: ${downloadManager.downloadRoot}`);
});
