const axios = require("axios");
const crypto = require("node:crypto");

const MAGIC = "1138b69dfef641d9d7ba49137d2d4875";
const DEFAULT_SERVICE_URL = "https://cbiz.yanhekt.cn/v1/cas/callback";
const LOGIN_URL = "https://sso.bit.edu.cn/cas/login";

const BASE_HEADERS = {
  Origin: "https://www.yanhekt.cn",
  Referer: "https://www.yanhekt.cn/",
  "xdomain-client": "web_user",
  "Xdomain-Client": "web_user",
  "Xclient-Version": "v1",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

function md5(value) {
  return crypto.createHash("md5").update(value).digest("hex");
}

function createApiHeaders(token = "") {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const headers = {
    ...BASE_HEADERS,
    "Xclient-Signature": md5(`${MAGIC}_v1_undefined`),
    "Xclient-Timestamp": timestamp,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function createMediaHeaders(extraHeaders = {}) {
  return {
    Origin: "https://www.yanhekt.cn",
    Referer: "https://www.yanhekt.cn/",
    "User-Agent": BASE_HEADERS["User-Agent"],
    ...extraHeaders,
  };
}

function createMediaSignature() {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    timestamp,
    signature: md5(`${MAGIC}_v1_${timestamp}`),
  };
}

function encryptMediaUrl(url) {
  const parts = url.split("/");
  parts.splice(parts.length - 1, 0, md5(`${MAGIC}_100`));
  return parts.join("/");
}

function buildSignedMediaUrl(url, videoToken) {
  const { timestamp, signature } = createMediaSignature();
  const signedUrl = new URL(url);
  signedUrl.searchParams.set("Xvideo_Token", videoToken);
  signedUrl.searchParams.set("Xclient_Timestamp", timestamp);
  signedUrl.searchParams.set("Xclient_Signature", signature);
  signedUrl.searchParams.set("Xclient_Version", "v1");
  signedUrl.searchParams.set("Platform", "yhkt_user");
  return signedUrl.toString();
}

function pickAesAlgorithm(keyBuffer) {
  if (keyBuffer.length === 16) {
    return "aes-128-ecb";
  }
  if (keyBuffer.length === 24) {
    return "aes-192-ecb";
  }
  if (keyBuffer.length === 32) {
    return "aes-256-ecb";
  }
  throw new Error("Unsupported encryption key length from CAS page.");
}

function encryptPassword(cryptoKey, password) {
  const keyBuffer = Buffer.from(cryptoKey, "base64");
  const algorithm = pickAesAlgorithm(keyBuffer);
  const cipher = crypto.createCipheriv(algorithm, keyBuffer, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(password, "utf8"), cipher.final()]).toString(
    "base64",
  );
}

function splitSetCookieHeader(rawCookieHeader) {
  if (!rawCookieHeader) {
    return [];
  }
  if (Array.isArray(rawCookieHeader)) {
    return rawCookieHeader;
  }
  return rawCookieHeader.split(/,(?=[^;]+=[^;]+)/g);
}

function mergeCookies(cookieJar, cookieHeaders) {
  for (const cookieHeader of cookieHeaders) {
    const cookie = cookieHeader.split(";")[0];
    const [name, ...rest] = cookie.split("=");
    if (name && rest.length > 0) {
      cookieJar.set(name.trim(), `${name.trim()}=${rest.join("=").trim()}`);
    }
  }
}

function cookieHeaderFromJar(cookieJar) {
  return Array.from(cookieJar.values()).join("; ");
}

function readSetCookieHeaders(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  return splitSetCookieHeader(response.headers.get("set-cookie"));
}

function extractHtmlField(html, fieldId) {
  const valuePattern = new RegExp(`id=["']${fieldId}["'][^>]*value=["']([^"']+)["']`, "i");
  const contentPattern = new RegExp(`id=["']${fieldId}["'][^>]*>\\s*([^<\\s][^<]*)<`, "i");
  const valueMatch = html.match(valuePattern);
  if (valueMatch) {
    return valueMatch[1].trim();
  }
  const contentMatch = html.match(contentPattern);
  if (contentMatch) {
    return contentMatch[1].trim();
  }
  return "";
}

function parseApiError(payload, fallbackMessage) {
  if (!payload || typeof payload !== "object") {
    return fallbackMessage;
  }
  if (payload.message) {
    return String(payload.message);
  }
  return fallbackMessage;
}

async function requestJson(url, { token = "", method = "GET", body } = {}) {
  const headers = createApiHeaders(token);
  const requestConfig = {
    url,
    method,
    headers,
    timeout: 10000,
    validateStatus: () => true,
  };

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    requestConfig.data = body;
  }

  const response = await axios(requestConfig);
  const payload = response.data;

  if (response.status >= 400) {
    if (typeof payload === "string") {
      throw new Error(payload.trim() || `Request failed with status ${response.status}`);
    }
    throw new Error(parseApiError(payload, `Request failed with status ${response.status}`));
  }

  if (!payload || typeof payload !== "object") {
    throw new Error("Upstream service returned a non-JSON response.");
  }

  if (payload.code !== 0 && payload.code !== "0") {
    throw new Error(parseApiError(payload, "Yanhe API request failed."));
  }

  return payload.data;
}

async function verifyToken(token) {
  const response = await requestJson("https://cbiz.yanhekt.cn/v1/user", { token });
  return {
    valid: true,
    user: {
      badge: response.badge || "",
      nickname: response.nickname || "",
      phone: response.phone || "",
    },
  };
}

async function loginAndGetToken(username, password, serviceUrl = DEFAULT_SERVICE_URL) {
  const cookieJar = new Map();
  const loginPageUrl = `${LOGIN_URL}?service=${encodeURIComponent(serviceUrl)}`;
  const axiosInstance = axios.create({
    maxRedirects: 0,
    timeout: 10000,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const initResponse = await axiosInstance.get(loginPageUrl, {
    headers: {
      "User-Agent": BASE_HEADERS["User-Agent"],
    },
  });

  mergeCookies(cookieJar, splitSetCookieHeader(initResponse.headers["set-cookie"]));
  const loginPageHtml = typeof initResponse.data === "string" ? initResponse.data : "";
  const cryptoKey = extractHtmlField(loginPageHtml, "login-croypto");
  const executionKey = extractHtmlField(loginPageHtml, "login-page-flowkey");

  if (!cryptoKey || !executionKey) {
    throw new Error("Failed to parse BIT login page. Please try browser login.");
  }

  const encryptedPassword = encryptPassword(cryptoKey, password);
  const params = new URLSearchParams();
  params.append("username", username);
  params.append("password", encryptedPassword);
  params.append("type", "UsernamePassword");
  params.append("_eventId", "submit");
  params.append("execution", executionKey);
  params.append("croypto", cryptoKey);
  params.append("geolocation", "");
  params.append("captcha_code", "");

  const loginResponse = await axiosInstance.post(loginPageUrl, params.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeaderFromJar(cookieJar),
      "User-Agent": BASE_HEADERS["User-Agent"],
    },
  });

  if (loginResponse.status !== 302) {
    const html = typeof loginResponse.data === "string" ? loginResponse.data : "";
    if (
      html.includes('id="sso-second">true</p>') ||
      html.includes('id="current-login-type">smsLogin</p>') ||
      html.includes('id="second-auth-tip">')
    ) {
      throw new Error("This account requires second verification. Please use browser login.");
    }
    throw new Error("BIT SSO login failed. Please check username and password.");
  }

  mergeCookies(cookieJar, splitSetCookieHeader(loginResponse.headers["set-cookie"]));
  const firstRedirectLocation = loginResponse.headers.location;
  if (!firstRedirectLocation) {
    throw new Error("Login succeeded but redirect location was missing.");
  }

  const ticketResponse = await axiosInstance.get(new URL(firstRedirectLocation, LOGIN_URL).toString(), {
    headers: {
      Cookie: cookieHeaderFromJar(cookieJar),
      "User-Agent": BASE_HEADERS["User-Agent"],
    },
  });

  if (ticketResponse.status !== 302) {
    throw new Error("CAS ticket verification failed.");
  }

  const finalRedirectLocation = ticketResponse.headers.location;
  if (!finalRedirectLocation) {
    throw new Error("Missing Yanhe callback redirect URL.");
  }

  const token = new URL(finalRedirectLocation, serviceUrl).searchParams.get("token");
  if (!token) {
    throw new Error("Failed to extract Yanhe token from callback URL.");
  }

  const verification = await verifyToken(token);
  return {
    token,
    user: verification.user,
  };
}

async function getSemesters() {
  const response = await requestJson("https://cbiz.yanhekt.cn/v1/tag/list?with_sub=true");
  const semesterTag = (response || []).find((item) => item.param === "semesters");
  if (!semesterTag || !Array.isArray(semesterTag.children)) {
    return [];
  }

  return semesterTag.children
    .slice()
    .sort((left, right) => (right.sort || 0) - (left.sort || 0))
    .map((item) => ({
      id: item.id,
      label: item.name,
    }));
}

async function getCourseList(token, options = {}) {
  const {
    keyword = "",
    scope = "all",
    page = 1,
    pageSize = 12,
    semesters = [],
  } = options;

  const params = new URLSearchParams();
  params.set("page", String(page));
  params.set("page_size", String(pageSize));

  if (keyword.trim()) {
    params.set("keyword", keyword.trim());
  }

  for (const semesterId of semesters) {
    params.append("semesters[]", String(semesterId));
  }

  let endpoint = "https://cbiz.yanhekt.cn/v2/course/list";
  if (scope === "mine") {
    params.set("user_relationship_type", "1");
    params.set("with_introduction", "true");
    endpoint = "https://cbiz.yanhekt.cn/v2/course/private/list";
  }

  return requestJson(`${endpoint}?${params.toString()}`, { token });
}

async function getCourseInfo(token, courseId) {
  const courseData = await requestJson(
    `https://cbiz.yanhekt.cn/v1/course?id=${courseId}&with_professor_badges=true`,
    { token },
  );

  const sessions = await requestJson(
    `https://cbiz.yanhekt.cn/v2/course/session/list?course_id=${courseId}`,
    { token },
  );

  const professor =
    Array.isArray(courseData.professors) && courseData.professors[0]
      ? courseData.professors[0].name?.trim() || "Unknown Teacher"
      : "Unknown Teacher";

  return {
    courseId: String(courseId),
    title: courseData.name_zh?.trim() || `Course ${courseId}`,
    professor,
    sessions: (sessions || []).map((session) => {
      const video = Array.isArray(session.videos) && session.videos[0] ? session.videos[0] : {};
      return {
        sessionId: session.id,
        title: session.title,
        weekNumber: session.week_number,
        day: session.day,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        duration: Number.parseInt(video.duration || "0", 10) || 0,
        videoId: video.id || "",
        mainUrl: video.main || "",
        vgaUrl: video.vga || "",
      };
    }),
  };
}

async function getAudioUrl(token, videoId) {
  const videoData = await requestJson(`https://cbiz.yanhekt.cn/v1/video?id=${videoId}`, {
    token,
  });
  return videoData.audio || "";
}

async function getVideoAccessToken(token) {
  const data = await requestJson("https://cbiz.yanhekt.cn/v1/auth/video/token?id=0", {
    token,
  });
  return data.token;
}

module.exports = {
  BASE_HEADERS,
  buildSignedMediaUrl,
  createApiHeaders,
  createMediaHeaders,
  encryptMediaUrl,
  getAudioUrl,
  getCourseInfo,
  getCourseList,
  getSemesters,
  getVideoAccessToken,
  loginAndGetToken,
  verifyToken,
};
