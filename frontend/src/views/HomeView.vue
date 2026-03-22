<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8787'
const pageSize = 12

const authForm = reactive({ username: '', password: '' })
const token = ref(localStorage.getItem('yanhe_token') || '')
const manualToken = ref(localStorage.getItem('yanhe_token') || '')
const user = ref(null)
const loginError = ref('')
const isLoggingIn = ref(false)
const isCheckingToken = ref(false)
const isSubmittingManualToken = ref(false)

const filterState = reactive({
  keyword: '',
  scope: 'all',
  semesters: [],
  page: 1,
})

const semesters = ref([])
const courses = ref([])
const totalPages = ref(1)
const totalCourses = ref(0)
const isLoadingCourses = ref(false)
const courseError = ref('')

const selectedCourse = ref(null)
const selectedSessionIds = ref([])
const isLoadingSessions = ref(false)
const sessionError = ref('')
const streamType = ref('main')

const backendInfo = ref({ downloadRoot: '', ok: false })
const browserJobs = ref([])
const isProcessingQueue = ref(false)

const playerState = reactive({
  status: 'Idle',
  error: '',
  courseTitle: '',
  sessionTitle: '',
  manifestUrl: '',
})

const videoElement = ref(null)
const extractionVideoElement = ref(null)

let hlsInstance = null
let extractionHlsInstance = null
let HlsClass = null
let jsPdfPromise = null
let slideComparisonWorker = null
let slideComparisonRequestId = 0

const slideExtractionConfig = {
  captureIntervalSeconds: 2,
  ssimThreshold: 0.999,
  downsampleWidth: 480,
  downsampleHeight: 270,
}

const isAuthenticated = computed(() => Boolean(token.value && user.value))
const isBootstrapping = computed(() => Boolean(token.value) && isCheckingToken.value && !user.value)
const canSearch = computed(() => isAuthenticated.value)
const selectedCount = computed(() => selectedSessionIds.value.length)
const selectedSession = computed(() => {
  const sessions = getSelectedSessions()
  return sessions.length === 1 ? sessions[0] : null
})

const playerStatusText = computed(() => {
  const map = { Idle: '未播放', Preparing: '准备中', Ready: '已就绪', Playing: '播放中', Failed: '播放失败' }
  return map[playerState.status] || playerState.status
})

function createUuid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function replaceExtension(fileName, newExtension) {
  return fileName.replace(/\.[^.]+$/, newExtension)
}

function formatSemesterLabel(course) {
  const semesterText = course.semester === '1' ? '第一学期' : course.semester === '2' ? '第二学期' : ''
  return [course.schoolYear, semesterText].filter(Boolean).join(' ')
}

function formatCourseProfessors(course) {
  return Array.isArray(course.professors) && course.professors.length > 0 ? course.professors.join(' / ') : '教师信息未提供'
}

function formatSessionTime(session) {
  const start = session.startedAt ? new Date(session.startedAt) : null
  if (!start || Number.isNaN(start.getTime())) {
    return '时间未知'
  }
  return start.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatStreamType(type) {
  return type === 'vga' ? '屏幕流' : '主视频'
}

function formatJobStatus(status) {
  const map = {
    Queued: '排队中',
    Preparing: '准备中',
    Downloading: '下载中',
    Saving: '保存中',
    'Scanning slides': '提取中',
    'Building PDF': '生成 PDF',
    'Saving PDF': '保存 PDF',
    Completed: '已完成',
    Failed: '失败',
  }
  return map[status] || status
}

function hexToBytes(hex) {
  const normalized = hex.replace(/^0x/i, '')
  const bytes = new Uint8Array(normalized.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function concatenateUint8Arrays(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const merged = new Uint8Array(totalLength)
  let offset = 0
  for (const part of parts) {
    merged.set(part, offset)
    offset += part.byteLength
  }
  return merged
}

function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function cleanupMediaElement(videoRef, kind) {
  if (kind === 'player' && hlsInstance) {
    hlsInstance.destroy()
    hlsInstance = null
  }
  if (kind === 'extractor' && extractionHlsInstance) {
    extractionHlsInstance.destroy()
    extractionHlsInstance = null
  }
  if (videoRef.value) {
    videoRef.value.pause()
    videoRef.value.removeAttribute('src')
    videoRef.value.load()
  }
}

function cleanupPlayer() {
  cleanupMediaElement(videoElement, 'player')
}

function cleanupExtractionVideo() {
  cleanupMediaElement(extractionVideoElement, 'extractor')
}

async function attemptVideoPlayback(targetVideo = videoElement.value) {
  if (!targetVideo) {
    return false
  }
  try {
    await targetVideo.play()
    return true
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return false
    }
    throw error
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  })
  const rawText = await response.text()
  let payload = {}
  if (rawText) {
    try {
      payload = JSON.parse(rawText)
    } catch (_error) {
      payload = { error: rawText }
    }
  }
  if (!response.ok) {
    throw new Error(payload.error || '请求失败')
  }
  return payload
}

async function requestBinary(path) {
  const response = await fetch(`${apiBaseUrl}${path}`)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(text || `请求失败：${response.status}`)
  }
  return response.arrayBuffer()
}

async function loadBackendInfo() {
  try {
    backendInfo.value = await request('/api/health', { method: 'GET' })
  } catch (_error) {
    backendInfo.value = { ok: false, downloadRoot: '' }
  }
}

async function verifyCurrentToken() {
  if (!token.value) {
    user.value = null
    return
  }
  isCheckingToken.value = true
  loginError.value = ''
  try {
    const payload = await request('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token: token.value }),
    })
    user.value = payload.user
    localStorage.setItem('yanhe_token', token.value)
  } catch (error) {
    token.value = ''
    user.value = null
    manualToken.value = ''
    localStorage.removeItem('yanhe_token')
    loginError.value = error instanceof Error ? error.message : '登录状态已失效'
  } finally {
    isCheckingToken.value = false
  }
}

async function login() {
  isLoggingIn.value = true
  loginError.value = ''
  try {
    const payload = await request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        username: authForm.username.trim(),
        password: authForm.password,
      }),
    })
    token.value = payload.token
    manualToken.value = payload.token
    user.value = payload.user
    localStorage.setItem('yanhe_token', payload.token)
    authForm.password = ''
    await fetchCourses(1)
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败'
  } finally {
    isLoggingIn.value = false
  }
}

async function submitManualToken() {
  if (!manualToken.value.trim()) {
    loginError.value = '请先输入有效令牌'
    return
  }
  isSubmittingManualToken.value = true
  loginError.value = ''
  try {
    const normalizedToken = manualToken.value.trim()
    const payload = await request('/api/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ token: normalizedToken }),
    })
    token.value = normalizedToken
    user.value = payload.user
    localStorage.setItem('yanhe_token', normalizedToken)
    await fetchCourses(1)
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '令牌验证失败'
  } finally {
    isSubmittingManualToken.value = false
  }
}

function logout() {
  token.value = ''
  manualToken.value = ''
  user.value = null
  courses.value = []
  selectedCourse.value = null
  selectedSessionIds.value = []
  browserJobs.value = []
  courseError.value = ''
  sessionError.value = ''
  loginError.value = ''
  localStorage.removeItem('yanhe_token')
  cleanupPlayer()
  cleanupExtractionVideo()
}

async function fetchSemesters() {
  try {
    const payload = await request('/api/semesters', { method: 'GET' })
    semesters.value = payload.semesters || []
  } catch (_error) {
    semesters.value = []
  }
}

async function fetchCourses(page = filterState.page) {
  if (!token.value) {
    return
  }
  isLoadingCourses.value = true
  courseError.value = ''
  filterState.page = page
  try {
    const params = new URLSearchParams({
      token: token.value,
      keyword: filterState.keyword.trim(),
      scope: filterState.scope,
      page: String(filterState.page),
      pageSize: String(pageSize),
    })
    filterState.semesters.forEach((semesterId) => params.append('semesters', String(semesterId)))
    const payload = await request(`/api/courses?${params.toString()}`, { method: 'GET' })
    courses.value = payload.items || []
    totalPages.value = payload.totalPages || 1
    totalCourses.value = payload.total || 0
  } catch (error) {
    courseError.value = error instanceof Error ? error.message : '课程加载失败'
    courses.value = []
  } finally {
    isLoadingCourses.value = false
  }
}

function resetFilters() {
  filterState.keyword = ''
  filterState.semesters = []
  void fetchCourses(1)
}

async function loadCourseSessions(course) {
  selectedCourse.value = null
  selectedSessionIds.value = []
  sessionError.value = ''
  isLoadingSessions.value = true
  try {
    const payload = await request(
      `/api/courses/${encodeURIComponent(course.id)}/sessions?token=${encodeURIComponent(token.value)}`,
      { method: 'GET' },
    )
    selectedCourse.value = payload
  } catch (error) {
    sessionError.value = error instanceof Error ? error.message : '课次加载失败'
  } finally {
    isLoadingSessions.value = false
  }
}

function toggleSession(sessionId) {
  const value = String(sessionId)
  if (selectedSessionIds.value.includes(value)) {
    selectedSessionIds.value = selectedSessionIds.value.filter((item) => item !== value)
    return
  }
  selectedSessionIds.value = [...selectedSessionIds.value, value]
}

function toggleSelectAllSessions() {
  if (!selectedCourse.value) {
    return
  }
  const allIds = selectedCourse.value.sessions.map((session) => String(session.sessionId))
  selectedSessionIds.value = selectedSessionIds.value.length === allIds.length ? [] : allIds
}

function getSelectedSessions() {
  if (!selectedCourse.value) {
    return []
  }
  const sessionIdSet = new Set(selectedSessionIds.value)
  return selectedCourse.value.sessions.filter((session) => sessionIdSet.has(String(session.sessionId)))
}

async function prepareSessionTransport(sessionId, requestedStreamType = streamType.value) {
  return request('/api/downloads/prepare', {
    method: 'POST',
    body: JSON.stringify({
      token: token.value,
      courseId: selectedCourse.value.courseId,
      sessionId,
      streamType: requestedStreamType,
    }),
  })
}

async function ensureHlsClassLoaded() {
  if (!HlsClass) {
    const hlsModule = await import('hls.js')
    HlsClass = hlsModule.default
  }
  return HlsClass
}

async function waitForVideoEvent(targetVideo, eventName) {
  if ((eventName === 'loadedmetadata' && targetVideo.readyState >= 1) || (eventName === 'canplay' && targetVideo.readyState >= 3)) {
    return
  }
  await new Promise((resolve, reject) => {
    const handleEvent = () => {
      cleanupHandlers()
      resolve()
    }
    const handleError = () => {
      cleanupHandlers()
      reject(new Error(`视频在等待 ${eventName} 时失败`))
    }
    const cleanupHandlers = () => {
      targetVideo.removeEventListener(eventName, handleEvent)
      targetVideo.removeEventListener('error', handleError)
    }
    targetVideo.addEventListener(eventName, handleEvent, { once: true })
    targetVideo.addEventListener('error', handleError, { once: true })
  })
}

async function attachPlayback(manifestUrl) {
  cleanupPlayer()
  if (!videoElement.value) {
    throw new Error('播放器未就绪')
  }
  await ensureHlsClassLoaded()
  if (HlsClass?.isSupported()) {
    hlsInstance = new HlsClass({ enableWorker: true })
    await new Promise((resolve, reject) => {
      const handleMediaAttached = () => hlsInstance.loadSource(manifestUrl)
      const handleManifestParsed = async () => {
        cleanupHandlers()
        try {
          resolve(await attemptVideoPlayback())
        } catch (error) {
          reject(error)
        }
      }
      const handleError = (_event, data) => {
        if (!data?.fatal) return
        cleanupHandlers()
        reject(new Error(data.details || data.reason || '浏览器播放失败'))
      }
      const cleanupHandlers = () => {
        hlsInstance.off(HlsClass.Events.MEDIA_ATTACHED, handleMediaAttached)
        hlsInstance.off(HlsClass.Events.MANIFEST_PARSED, handleManifestParsed)
        hlsInstance.off(HlsClass.Events.ERROR, handleError)
      }
      hlsInstance.on(HlsClass.Events.MEDIA_ATTACHED, handleMediaAttached)
      hlsInstance.on(HlsClass.Events.MANIFEST_PARSED, handleManifestParsed)
      hlsInstance.on(HlsClass.Events.ERROR, handleError)
      hlsInstance.attachMedia(videoElement.value)
    })
    return
  }
  if (videoElement.value.canPlayType('application/vnd.apple.mpegurl')) {
    videoElement.value.src = manifestUrl
    return attemptVideoPlayback()
  }
  throw new Error('当前浏览器不支持在线播放')
}

async function loadExtractionVideo(manifestUrl) {
  cleanupExtractionVideo()
  if (!extractionVideoElement.value) {
    throw new Error('提取视频未就绪')
  }
  const targetVideo = extractionVideoElement.value
  targetVideo.muted = true
  targetVideo.playsInline = true
  targetVideo.crossOrigin = 'anonymous'
  await ensureHlsClassLoaded()
  if (HlsClass?.isSupported()) {
    extractionHlsInstance = new HlsClass({ enableWorker: true })
    await new Promise((resolve, reject) => {
      const handleMediaAttached = () => extractionHlsInstance.loadSource(manifestUrl)
      const handleManifestParsed = async () => {
        cleanupHandlers()
        try {
          await waitForVideoEvent(targetVideo, 'loadedmetadata')
          resolve()
        } catch (error) {
          reject(error)
        }
      }
      const handleError = (_event, data) => {
        if (!data?.fatal) return
        cleanupHandlers()
        reject(new Error(data.details || data.reason || '课件流准备失败'))
      }
      const cleanupHandlers = () => {
        extractionHlsInstance.off(HlsClass.Events.MEDIA_ATTACHED, handleMediaAttached)
        extractionHlsInstance.off(HlsClass.Events.MANIFEST_PARSED, handleManifestParsed)
        extractionHlsInstance.off(HlsClass.Events.ERROR, handleError)
      }
      extractionHlsInstance.on(HlsClass.Events.MEDIA_ATTACHED, handleMediaAttached)
      extractionHlsInstance.on(HlsClass.Events.MANIFEST_PARSED, handleManifestParsed)
      extractionHlsInstance.on(HlsClass.Events.ERROR, handleError)
      extractionHlsInstance.attachMedia(targetVideo)
    })
    return targetVideo
  }
  if (targetVideo.canPlayType('application/vnd.apple.mpegurl')) {
    targetVideo.src = manifestUrl
    await waitForVideoEvent(targetVideo, 'loadedmetadata')
    return targetVideo
  }
  throw new Error('当前浏览器不支持课件提取')
}

async function playSelectedSession() {
  if (!selectedSession.value) {
    sessionError.value = '请选择一个课次后再播放'
    return
  }
  sessionError.value = ''
  playerState.status = 'Preparing'
  playerState.error = ''
  try {
    const payload = await prepareSessionTransport(selectedSession.value.sessionId)
    playerState.courseTitle = payload.courseTitle
    playerState.sessionTitle = payload.sessionTitle
    playerState.manifestUrl = `${apiBaseUrl}${payload.manifestUrl}`
    const isPlaying = await attachPlayback(playerState.manifestUrl)
    playerState.status = isPlaying ? 'Playing' : 'Ready'
  } catch (error) {
    cleanupPlayer()
    playerState.status = 'Failed'
    playerState.error = error instanceof Error ? error.message : '播放失败'
  }
}

async function ensureJsPdfLoaded() {
  if (!jsPdfPromise) {
    jsPdfPromise = import('jspdf').then((module) => module.jsPDF)
  }
  return jsPdfPromise
}

function ensureSlideComparisonWorker() {
  if (!slideComparisonWorker) {
    slideComparisonWorker = new Worker(new URL('../workers/slideComparison.worker.js', import.meta.url), { type: 'module' })
  }
  return slideComparisonWorker
}

async function compareSlideFrames(previousFrame, currentFrame) {
  const worker = ensureSlideComparisonWorker()
  return new Promise((resolve, reject) => {
    const requestId = `slide-${slideComparisonRequestId += 1}`
    const handleMessage = ({ data }) => {
      if (data.id !== requestId) return
      cleanupHandlers()
      if (!data.success) {
        reject(new Error(data.error || '画面比对失败'))
        return
      }
      resolve(data.result)
    }
    const handleError = () => {
      cleanupHandlers()
      reject(new Error('画面比对线程异常'))
    }
    const cleanupHandlers = () => {
      worker.removeEventListener('message', handleMessage)
      worker.removeEventListener('error', handleError)
    }
    worker.addEventListener('message', handleMessage)
    worker.addEventListener('error', handleError)
    worker.postMessage({
      id: requestId,
      imageOne: previousFrame,
      imageTwo: currentFrame,
      config: slideExtractionConfig,
    })
  })
}

function createCanvas(width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function captureVideoFrame(targetVideo) {
  const sourceWidth = targetVideo.videoWidth
  const sourceHeight = targetVideo.videoHeight
  if (!sourceWidth || !sourceHeight) {
    throw new Error('无法获取视频尺寸')
  }
  const exportCanvas = createCanvas(sourceWidth, sourceHeight)
  const exportContext = exportCanvas.getContext('2d', { willReadFrequently: true })
  const compareCanvas = createCanvas(slideExtractionConfig.downsampleWidth, slideExtractionConfig.downsampleHeight)
  const compareContext = compareCanvas.getContext('2d', { willReadFrequently: true })
  if (!exportContext || !compareContext) {
    throw new Error('画布创建失败')
  }
  exportContext.drawImage(targetVideo, 0, 0, sourceWidth, sourceHeight)
  compareContext.drawImage(targetVideo, 0, 0, compareCanvas.width, compareCanvas.height)
  return {
    width: sourceWidth,
    height: sourceHeight,
    exportCanvas,
    compareFrame: compareContext.getImageData(0, 0, compareCanvas.width, compareCanvas.height),
  }
}

function formatDuration(seconds) {
  const totalSeconds = Math.max(0, Math.round(seconds))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const remainingSeconds = totalSeconds % 60
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
}

async function seekVideo(targetVideo, nextTime) {
  const clampedTime = Math.min(Math.max(nextTime, 0), Math.max(targetVideo.duration - 0.1, 0))
  if (Math.abs(targetVideo.currentTime - clampedTime) < 0.05) {
    return
  }
  await new Promise((resolve, reject) => {
    const handleSeeked = () => {
      cleanupHandlers()
      resolve()
    }
    const handleError = () => {
      cleanupHandlers()
      reject(new Error('课件流跳转失败'))
    }
    const cleanupHandlers = () => {
      targetVideo.removeEventListener('seeked', handleSeeked)
      targetVideo.removeEventListener('error', handleError)
    }
    targetVideo.addEventListener('seeked', handleSeeked, { once: true })
    targetVideo.addEventListener('error', handleError, { once: true })
    targetVideo.currentTime = clampedTime
  })
}

async function exportSlidesToPdf(job, slides, fileName) {
  const JsPdfClass = await ensureJsPdfLoaded()
  const firstSlide = slides[0]
  const pdf = new JsPdfClass({
    orientation: firstSlide.width >= firstSlide.height ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [firstSlide.width, firstSlide.height],
    compress: true,
  })
  slides.forEach((slide, index) => {
    if (index > 0) {
      pdf.addPage([slide.width, slide.height], slide.width >= slide.height ? 'landscape' : 'portrait')
    }
    pdf.addImage(slide.dataUrl, 'PNG', 0, 0, slide.width, slide.height, undefined, 'FAST')
    markJob(job, {
      progress: Math.max(91, Math.min(99, 90 + Math.round(((index + 1) / slides.length) * 9))),
      detail: `正在生成第 ${index + 1} / ${slides.length} 页 PDF`,
    })
  })
  markJob(job, {
    status: 'Saving PDF',
    progress: 100,
    detail: `正在保存 ${slides.length} 页 PDF`,
  })
  saveBlob(pdf.output('blob'), replaceExtension(fileName, '.pdf'))
}

async function runSlideExtraction(job) {
  markJob(job, { status: 'Preparing', progress: 0, extractedSlides: 0, error: '', detail: '正在准备屏幕流' })
  const preparePayload = await prepareSessionTransport(job.sessionId, 'vga')
  const targetVideo = await loadExtractionVideo(`${apiBaseUrl}${preparePayload.manifestUrl}`)
  if (!Number.isFinite(targetVideo.duration) || targetVideo.duration <= 0) {
    throw new Error('无法读取屏幕流时长')
  }
  const slides = []
  let previousFrame = null
  const totalDuration = targetVideo.duration
  for (let captureTime = 0; captureTime < totalDuration; captureTime += slideExtractionConfig.captureIntervalSeconds) {
    await seekVideo(targetVideo, captureTime)
    const frame = captureVideoFrame(targetVideo)
    const comparison = previousFrame ? await compareSlideFrames(previousFrame, frame.compareFrame) : { changed: true }
    if (comparison.changed) {
      slides.push({
        timestamp: captureTime,
        dataUrl: frame.exportCanvas.toDataURL('image/png'),
        width: frame.width,
        height: frame.height,
      })
      previousFrame = frame.compareFrame
    }
    markJob(job, {
      status: 'Scanning slides',
      progress: Math.min(90, Math.round(((captureTime + slideExtractionConfig.captureIntervalSeconds) / totalDuration) * 90)),
      extractedSlides: slides.length,
      detail: `已扫描 ${formatDuration(captureTime)} / ${formatDuration(totalDuration)}，保留 ${slides.length} 页`,
    })
  }
  if (slides.length === 0) {
    throw new Error('没有检测到可导出的课件页')
  }
  markJob(job, { status: 'Building PDF', detail: `准备生成 ${slides.length} 页 PDF` })
  await exportSlidesToPdf(job, slides, replaceExtension(preparePayload.fileName, '.pdf'))
  markJob(job, {
    status: 'Completed',
    progress: 100,
    extractedSlides: slides.length,
    fileName: replaceExtension(preparePayload.fileName, '.pdf'),
    detail: `课件已导出，共 ${slides.length} 页`,
  })
  cleanupExtractionVideo()
}

function createJob(session, kind = 'download') {
  return {
    id: createUuid(),
    kind,
    courseId: selectedCourse.value.courseId,
    courseTitle: selectedCourse.value.title,
    sessionTitle: session.title,
    sessionId: String(session.sessionId),
    streamType: kind === 'slides' ? 'vga' : streamType.value,
    status: 'Queued',
    progress: 0,
    downloadedSegments: 0,
    extractedSlides: 0,
    totalSegments: 0,
    fileName: '',
    error: '',
    detail: '',
  }
}

function markJob(job, patch) {
  Object.assign(job, patch)
}

function jobStatusLabel(job) {
  return `${job.kind === 'slides' ? 'PDF' : 'TS'} · ${formatJobStatus(job.status)}`
}

function jobSummary(job) {
  if (job.kind === 'slides') {
    return `${formatStreamType(job.streamType)} · ${job.progress}% · 已提取 ${job.extractedSlides} 页`
  }
  return `${formatStreamType(job.streamType)} · ${job.progress}% · ${job.downloadedSegments}/${job.totalSegments || '?'} 分片`
}

async function decryptSegment(encryptedBuffer, keyBuffer, ivHex) {
  const cryptoKey = await window.crypto.subtle.importKey('raw', keyBuffer, { name: 'AES-CBC' }, false, ['decrypt'])
  return window.crypto.subtle.decrypt({ name: 'AES-CBC', iv: hexToBytes(ivHex) }, cryptoKey, encryptedBuffer)
}

async function buildTransportStreamBytes(preparePayload, job) {
  const keyCache = new Map()
  const transportStreamParts = []
  for (const segment of preparePayload.segments) {
    let segmentBuffer = await requestBinary(`/api/downloads/${encodeURIComponent(preparePayload.downloadId)}/segments/${segment.index}`)
    if (segment.keyId) {
      let keyBuffer = keyCache.get(segment.keyId)
      if (!keyBuffer) {
        keyBuffer = await requestBinary(`/api/downloads/${encodeURIComponent(preparePayload.downloadId)}/keys/${encodeURIComponent(segment.keyId)}`)
        keyCache.set(segment.keyId, keyBuffer)
      }
      segmentBuffer = await decryptSegment(segmentBuffer, keyBuffer, segment.ivHex)
    }
    transportStreamParts.push(new Uint8Array(segmentBuffer))
    markJob(job, {
      downloadedSegments: segment.index + 1,
      progress: Math.round(((segment.index + 1) / preparePayload.totalSegments) * 70),
      detail: `正在下载第 ${segment.index + 1} / ${preparePayload.totalSegments} 个分片`,
    })
  }
  return concatenateUint8Arrays(transportStreamParts)
}

async function runBrowserDownload(job) {
  markJob(job, { status: 'Preparing', progress: 0, downloadedSegments: 0, error: '', detail: '正在获取播放列表' })
  const preparePayload = await request('/api/downloads/prepare', {
    method: 'POST',
    body: JSON.stringify({
      token: token.value,
      courseId: job.courseId,
      sessionId: job.sessionId,
      streamType: job.streamType,
    }),
  })
  markJob(job, {
    status: 'Downloading',
    fileName: replaceExtension(preparePayload.fileName, '.ts'),
    totalSegments: preparePayload.totalSegments,
    detail: `准备下载 ${preparePayload.totalSegments} 个分片`,
  })
  const mergedTransportStream = await buildTransportStreamBytes(preparePayload, job)
  markJob(job, { status: 'Saving', detail: '正在保存 TS 文件' })
  saveBlob(new Blob([mergedTransportStream], { type: 'video/mp2t' }), replaceExtension(preparePayload.fileName, '.ts'))
  markJob(job, { status: 'Completed', progress: 100, detail: '下载完成' })
}

async function processQueue() {
  if (isProcessingQueue.value) return
  isProcessingQueue.value = true
  try {
    while (true) {
      const nextJob = browserJobs.value.find((job) => job.status === 'Queued')
      if (!nextJob) return
      try {
        if (nextJob.kind === 'slides') {
          await runSlideExtraction(nextJob)
        } else {
          await runBrowserDownload(nextJob)
        }
      } catch (error) {
        if (nextJob.kind === 'slides') cleanupExtractionVideo()
        markJob(nextJob, {
          status: 'Failed',
          error: error instanceof Error ? error.message : nextJob.kind === 'slides' ? '课件提取失败' : '下载失败',
          detail: '',
        })
      }
    }
  } finally {
    isProcessingQueue.value = false
  }
}

function enqueueDownloads() {
  if (!selectedCourse.value || selectedSessionIds.value.length === 0) return
  getSelectedSessions().forEach((session) => {
    browserJobs.value.unshift(createJob(session, 'download'))
  })
  void processQueue()
}

function enqueueSlideExtraction() {
  if (!selectedCourse.value) return
  if (streamType.value !== 'vga') {
    sessionError.value = '课件提取仅支持屏幕流'
    return
  }
  if (!selectedSession.value) {
    sessionError.value = '请先选择一个课次再提取课件'
    return
  }
  sessionError.value = ''
  browserJobs.value.unshift(createJob(selectedSession.value, 'slides'))
  void processQueue()
}

function removeJob(jobId) {
  browserJobs.value = browserJobs.value.filter((job) => job.id !== jobId)
}

onMounted(async () => {
  await Promise.all([loadBackendInfo(), fetchSemesters(), verifyCurrentToken()])
  if (token.value) {
    await fetchCourses(1)
  }
})

onBeforeUnmount(() => {
  cleanupPlayer()
  cleanupExtractionVideo()
  if (slideComparisonWorker) {
    slideComparisonWorker.terminate()
    slideComparisonWorker = null
  }
})
</script>

<template>
  <main class="release-shell">
    <section v-if="!isAuthenticated" class="auth-shell">
      <div class="auth-brand">
        <span class="auth-mark">Yanhe Workspace</span>
        <h1>课程下载与课件提取</h1>
        <p class="auth-copy">登录后即可搜索课程、在线播放、下载 TS 文件，以及从屏幕流导出课件 PDF。</p>

        <div class="auth-points">
          <div class="auth-point">
            <strong>浏览器在线播放</strong>
            <span>选择单个课次后直接播放，无需额外跳转。</span>
          </div>
          <div class="auth-point">
            <strong>本地下载</strong>
            <span>支持主视频与屏幕流的浏览器端保存。</span>
          </div>
          <div class="auth-point">
            <strong>课件导出</strong>
            <span>从屏幕流中提取页面变化并生成 PDF。</span>
          </div>
        </div>
      </div>

      <section class="auth-card">
        <div class="auth-card-head">
          <div>
            <p class="eyebrow">登录</p>
            <h2>进入工作台</h2>
          </div>
          <span class="backend-indicator" :class="{ online: backendInfo.ok }">
            {{ backendInfo.ok ? '服务在线' : '服务离线' }}
          </span>
        </div>

        <div v-if="isBootstrapping" class="auth-status">正在恢复登录状态...</div>

        <form class="login-form" @submit.prevent="login">
          <label>
            <span>统一身份账号</span>
            <input v-model="authForm.username" type="text" placeholder="请输入学号或工号" />
          </label>
          <label>
            <span>统一身份密码</span>
            <input v-model="authForm.password" type="password" placeholder="请输入密码" />
          </label>
          <button class="primary-button auth-submit" :disabled="isLoggingIn || isCheckingToken">
            {{ isLoggingIn ? '登录中...' : isCheckingToken ? '验证中...' : '登录' }}
          </button>
        </form>

        <details class="token-panel">
          <summary>使用延河令牌登录</summary>
          <div class="manual-token-block">
            <label>
              <span>延河 Token</span>
              <input v-model="manualToken" type="text" placeholder="粘贴可用令牌" />
            </label>
            <button class="ghost-button" :disabled="isSubmittingManualToken || isCheckingToken" @click="submitManualToken">
              {{ isSubmittingManualToken ? '验证中...' : '使用令牌登录' }}
            </button>
          </div>
        </details>

        <p v-if="loginError" class="error-text auth-error">{{ loginError }}</p>
      </section>
    </section>

    <template v-else>
      <header class="topbar">
        <div>
          <p class="eyebrow">Release Mode</p>
          <h1>课程工作台</h1>
          <p class="topbar-copy">搜索课程、选择课次，然后播放、下载或导出课件。</p>
        </div>

        <div class="topbar-meta">
          <div class="topbar-chip">
            <span>当前用户</span>
            <strong>{{ user?.nickname || '已登录用户' }}</strong>
          </div>
          <div class="topbar-chip" :class="{ online: backendInfo.ok }">
            <span>服务状态</span>
            <strong>{{ backendInfo.ok ? '在线' : '离线' }}</strong>
          </div>
          <button class="ghost-button" @click="logout">退出登录</button>
        </div>
      </header>

      <section class="workspace-grid">
        <div class="workspace-stack">
          <section class="panel">
            <div class="section-head">
              <div>
                <p class="section-kicker">课程检索</p>
                <h2>课程列表</h2>
              </div>
              <span class="section-note">{{ totalCourses }} 门课程</span>
            </div>

            <div class="toolbar course-toolbar">
              <input
                v-model="filterState.keyword"
                type="text"
                class="search-input"
                placeholder="搜索课程名称"
                :disabled="!canSearch"
                @keyup.enter="fetchCourses(1)"
              />
              <select v-model="filterState.scope" :disabled="!canSearch">
                <option value="all">全部课程</option>
                <option value="mine">我的课程</option>
              </select>
            </div>

            <div class="semester-list">
              <label v-for="semester in semesters" :key="semester.id" class="chip">
                <input v-model="filterState.semesters" type="checkbox" :value="semester.id" :disabled="!canSearch" />
                <span>{{ semester.label }}</span>
              </label>
            </div>

            <div class="toolbar action-row">
              <button class="primary-button" :disabled="!canSearch || isLoadingCourses" @click="fetchCourses(1)">
                {{ isLoadingCourses ? '加载中...' : '查询课程' }}
              </button>
              <button class="ghost-button" :disabled="!canSearch || isLoadingCourses" @click="resetFilters">
                重置筛选
              </button>
            </div>

            <p v-if="courseError" class="error-text">{{ courseError }}</p>

            <div class="course-grid">
              <button
                v-for="course in courses"
                :key="course.id"
                class="course-card"
                :class="{ active: selectedCourse?.courseId === course.id }"
                @click="loadCourseSessions(course)"
              >
                <p class="course-name">{{ course.title }}</p>
                <p>{{ formatCourseProfessors(course) }}</p>
                <p>{{ formatSemesterLabel(course) || '学期信息未提供' }}</p>
                <p>{{ course.collegeName || '院系信息未提供' }}</p>
              </button>
            </div>

            <div class="pagination">
              <button class="ghost-button" :disabled="filterState.page <= 1 || isLoadingCourses" @click="fetchCourses(filterState.page - 1)">
                上一页
              </button>
              <span>第 {{ filterState.page }} / {{ totalPages }} 页</span>
              <button class="ghost-button" :disabled="filterState.page >= totalPages || isLoadingCourses" @click="fetchCourses(filterState.page + 1)">
                下一页
              </button>
            </div>
          </section>
        </div>

        <div class="workspace-stack">
          <section class="panel">
            <div class="section-head">
              <div>
                <p class="section-kicker">课次操作</p>
                <h2>课次与动作</h2>
              </div>
              <span class="section-note">{{ selectedCount }} 已选择</span>
            </div>

            <template v-if="selectedCourse">
              <div class="course-summary">
                <strong>{{ selectedCourse.title }}</strong>
                <p>{{ selectedCourse.professor }}</p>
              </div>

              <div class="stream-picker">
                <label>
                  <span>视频流类型</span>
                  <select v-model="streamType">
                    <option value="main">主视频</option>
                    <option value="vga">屏幕流</option>
                  </select>
                </label>
                <p class="panel-tip">课件提取仅对屏幕流有效。</p>
              </div>

              <div class="mode-actions">
                <button class="ghost-button" @click="toggleSelectAllSessions">
                  {{ selectedCount === selectedCourse.sessions.length ? '取消全选' : '全选' }}
                </button>
                <button class="ghost-button" :disabled="!selectedSession" @click="playSelectedSession">
                  在线播放
                </button>
                <button class="primary-button" :disabled="selectedCount === 0 || isProcessingQueue" @click="enqueueDownloads()">
                  下载 TS
                </button>
                <button class="ghost-button" :disabled="!selectedSession || streamType !== 'vga' || isProcessingQueue" @click="enqueueSlideExtraction">
                  导出课件 PDF
                </button>
              </div>

              <div class="session-list">
                <label v-for="session in selectedCourse.sessions" :key="session.sessionId" class="session-card">
                  <input
                    type="checkbox"
                    :checked="selectedSessionIds.includes(String(session.sessionId))"
                    @change="toggleSession(session.sessionId)"
                  />
                  <div>
                    <strong>{{ session.title }}</strong>
                    <p>{{ formatSessionTime(session) }}</p>
                    <p>主视频: {{ session.mainUrl ? '有' : '无' }} / 屏幕流: {{ session.vgaUrl ? '有' : '无' }}</p>
                  </div>
                </label>
              </div>
            </template>

            <template v-else>
              <div class="empty-state">
                <p v-if="isLoadingSessions">正在加载课次...</p>
                <p v-else>请先从左侧选择一门课程。</p>
              </div>
            </template>

            <p v-if="sessionError" class="error-text">{{ sessionError }}</p>
          </section>

          <section class="panel">
            <div class="section-head">
              <div>
                <p class="section-kicker">播放器</p>
                <h2>在线播放</h2>
              </div>
              <span class="section-note">{{ playerStatusText }}</span>
            </div>

            <div class="player-card">
              <video ref="videoElement" class="player-video" controls playsinline />
              <div v-if="playerState.sessionTitle" class="player-meta">
                <strong>{{ playerState.sessionTitle }}</strong>
                <span>{{ playerState.courseTitle }}</span>
              </div>
              <p v-if="playerState.error" class="error-text">{{ playerState.error }}</p>
              <p v-else class="panel-tip">选择一个课次后即可在浏览器中直接播放。</p>
            </div>
          </section>

          <section class="panel">
            <div class="section-head">
              <div>
                <p class="section-kicker">任务队列</p>
                <h2>浏览器任务</h2>
              </div>
              <span class="section-note">{{ isProcessingQueue ? '执行中' : '空闲' }}</span>
            </div>

            <video ref="extractionVideoElement" class="hidden-video" muted playsinline preload="auto" />

            <div v-if="browserJobs.length === 0" class="empty-state">
              <p>还没有任务，选择课次后开始播放、下载或导出。</p>
            </div>

            <div v-else class="task-list">
              <article v-for="job in browserJobs" :key="job.id" class="task-card">
                <div class="task-topline">
                  <div>
                    <h3>{{ job.sessionTitle }}</h3>
                    <p>{{ job.courseTitle }}</p>
                  </div>
                  <span class="status-pill" :data-status="job.status.toLowerCase()">
                    {{ jobStatusLabel(job) }}
                  </span>
                </div>

                <div class="progress-track">
                  <div class="progress-fill" :style="{ width: `${job.progress}%` }"></div>
                </div>

                <p class="task-meta">{{ jobSummary(job) }}</p>
                <p v-if="job.detail" class="task-meta">{{ job.detail }}</p>
                <p v-if="job.fileName" class="task-meta"><code>{{ job.fileName }}</code></p>
                <p v-if="job.error" class="error-text">{{ job.error }}</p>

                <button v-if="job.status === 'Completed' || job.status === 'Failed'" class="ghost-button" @click="removeJob(job.id)">
                  移除
                </button>
              </article>
            </div>
          </section>
        </div>
      </section>
    </template>
  </main>
</template>
