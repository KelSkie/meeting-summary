const els = {
  micButton: document.querySelector("#micButton"),
  tabButton: document.querySelector("#tabButton"),
  startButton: document.querySelector("#startButton"),
  pauseButton: document.querySelector("#pauseButton"),
  resumeButton: document.querySelector("#resumeButton"),
  stopButton: document.querySelector("#stopButton"),
  summarizeButton: document.querySelector("#summarizeButton"),
  translateButton: document.querySelector("#translateButton"),
  saveCloudButton: document.querySelector("#saveCloudButton"),
  clearTranscriptButton: document.querySelector("#clearTranscriptButton"),
  refreshLibraryButton: document.querySelector("#refreshLibraryButton"),
  topLoginLink: document.querySelector("#topLoginLink"),
  topRegisterLink: document.querySelector("#topRegisterLink"),
  topUserName: document.querySelector("#topUserName"),
  topLogoutButton: document.querySelector("#topLogoutButton"),
  downloadLink: document.querySelector("#downloadLink"),
  sourceLabel: document.querySelector("#sourceLabel"),
  statusText: document.querySelector("#statusText"),
  statusDot: document.querySelector("#statusDot"),
  timer: document.querySelector("#timer"),
  durationStat: document.querySelector("#durationStat"),
  sizeStat: document.querySelector("#sizeStat"),
  storageStat: document.querySelector("#storageStat"),
  cloudStat: document.querySelector("#cloudStat"),
  meterBar: document.querySelector("#meterBar"),
  speechLanguage: document.querySelector("#speechLanguage"),
  targetLanguage: document.querySelector("#targetLanguage"),
  transcript: document.querySelector("#transcript"),
  summaryOutput: document.querySelector("#summaryOutput"),
  translationOutput: document.querySelector("#translationOutput"),
  detectedLanguage: document.querySelector("#detectedLanguage"),
  translationStatus: document.querySelector("#translationStatus"),
  libraryStatus: document.querySelector("#libraryStatus"),
  sessionList: document.querySelector("#sessionList"),
};

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
const DB_NAME = "meeting-recorder-db";
const DB_VERSION = 1;
const STORE_NAME = "sessions";
const SUPABASE_PLACEHOLDER = "Điền Supabase URL và anon key trong env.js.";
const APP_SESSION_KEY = "meetingRecorderAppSession";
const GUEST_RECORD_LIMIT = 2;

let db = null;
let supabaseClient = null;
let appSession = null;
let stream = null;
let recordingStream = null;
let recorder = null;
let chunks = [];
let startedAt = 0;
let elapsedBeforePause = 0;
let timerId = null;
let audioContext = null;
let analyser = null;
let recordingDestination = null;
let meterId = null;
let recognition = null;
let finalTranscript = "";
let interimTranscript = "";
let currentSource = "";
let currentBlob = null;
let currentSessionId = null;
let currentObjectUrl = null;
let isStarting = false;
let recordingState = "idle";
let stopRequested = false;
let paused = false;
let activeChunkPromise = null;
const CHUNK_MS = 10_000;

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(
    2,
    "0",
  );
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function setStatus(text, mode = "idle") {
  els.statusText.textContent = text;
  els.statusDot.classList.toggle("recording", mode === "recording");
}

function setOutput(el, text) {
  el.textContent = text;
  el.classList.toggle("empty", !text.trim());
}

function setupSupabase() {
  let domConfig = {};
  const configEl = document.querySelector("#supabase-config");
  if (configEl?.textContent?.trim()) {
    try {
      domConfig = JSON.parse(configEl.textContent);
    } catch (error) {
      console.warn("Supabase config JSON không hợp lệ.", error);
    }
  }

  const config = { ...domConfig, ...(window.SUPABASE_CONFIG || {}) };
  const url = (config.url || "").trim();
  const anonKey = (config.anonKey || "").trim();

  if (!url || !anonKey) {
    els.cloudStat.textContent = "Chưa cấu hình";
    return;
  }

  if (!window.supabase) {
    els.cloudStat.textContent = "Thiếu SDK";
    return;
  }

  supabaseClient = window.supabase.createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  els.cloudStat.textContent = "Sẵn sàng";
}

function loadAppSession() {
  try {
    appSession = JSON.parse(localStorage.getItem(APP_SESSION_KEY) || "null");
  } catch {
    appSession = null;
  }
  renderAuthState();
}

function saveAppSession(session) {
  appSession = session;
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify(session));
  renderAuthState();
}

function clearAppSession() {
  appSession = null;
  localStorage.removeItem(APP_SESSION_KEY);
  renderAuthState();
}

function isPasswordValid(password) {
  return password.length >= 8 && /[^A-Za-z0-9]/.test(password);
}

function isUsernameValid(username) {
  return /^[a-z0-9_.-]{3,32}$/i.test(username.trim());
}

function renderPasswordWarning() {
  if (!els.passwordInput || !els.passwordWarning) return;
  const password = els.passwordInput.value;
  if (!password) {
    els.passwordWarning.textContent = "Mật khẩu cần ít nhất 8 ký tự và 1 ký tự đặc biệt.";
    els.passwordWarning.classList.remove("ok");
    return;
  }

  if (isPasswordValid(password)) {
    els.passwordWarning.textContent = "Mật khẩu hợp lệ.";
    els.passwordWarning.classList.add("ok");
  } else {
    els.passwordWarning.textContent = "Thiếu điều kiện: tối thiểu 8 ký tự và phải có ký tự đặc biệt.";
    els.passwordWarning.classList.remove("ok");
  }
}

function renderAuthState() {
  const signedIn = Boolean(appSession?.session_token);
  els.topLoginLink.classList.toggle("hidden", signedIn);
  els.topRegisterLink.classList.toggle("hidden", signedIn);
  els.topUserName.classList.toggle("hidden", !signedIn);
  els.topLogoutButton.classList.toggle("hidden", !signedIn);
  els.topUserName.textContent = signedIn ? `@${appSession.username}` : "";
  updateControls(recordingState);
}

async function authenticateAppUser(mode) {
  if (!supabaseClient) {
    setStatus(SUPABASE_PLACEHOLDER);
    return;
  }

  const username = els.usernameInput.value.trim().toLowerCase();
  const password = els.passwordInput.value;
  if (!isUsernameValid(username)) {
    setStatus("Username cần 3-32 ký tự: chữ, số, dấu chấm, gạch hoặc gạch dưới.");
    return;
  }
  if (!isPasswordValid(password)) {
    renderPasswordWarning();
    setStatus("Mật khẩu chưa đủ mạnh.");
    return;
  }

  const fn = mode === "register" ? "register_app_user" : "login_app_user";
  const { data, error } = await supabaseClient.rpc(fn, {
    p_username: username,
    p_password: password,
  });

  if (error) {
    setStatus(error.message);
    return;
  }

  const session = Array.isArray(data) ? data[0] : data;
  saveAppSession(session);
  els.passwordInput.value = "";
  renderPasswordWarning();
  setStatus(mode === "register" ? "Đăng kí thành công." : "Đăng nhập thành công.");
  await renderSessions();
  await renderCloudMeetings();
}

function friendlyMediaError(error) {
  if (
    error?.name === "NotAllowedError" ||
    /permission denied/i.test(error?.message || "")
  ) {
    return "Trình duyệt đang chặn quyền ghi âm. Hãy bấm Allow/Cho phép micro hoặc chia sẻ tab audio.";
  }
  if (error?.name === "NotFoundError") {
    return "Không tìm thấy thiết bị micro hoặc nguồn âm thanh.";
  }
  if (error?.name === "NotReadableError") {
    return "Nguồn âm thanh đang được ứng dụng khác sử dụng hoặc trình duyệt không đọc được.";
  }
  return error?.message || "Không lấy được nguồn âm thanh.";
}

function getSupportedMimeTypes() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "video/webm;codecs=opus",
    "video/webm",
    "",
  ];
  return candidates.filter(
    (type) => !type || MediaRecorder.isTypeSupported(type),
  );
}

function updateControls(state) {
  const canRecord = Boolean(
    navigator.mediaDevices?.getUserMedia && window.MediaRecorder,
  );
  els.startButton.disabled =
    !canRecord || isStarting || state === "recording" || state === "paused";
  els.pauseButton.disabled = state !== "recording";
  els.resumeButton.disabled = state !== "paused";
  els.stopButton.disabled = state !== "recording" && state !== "paused";
  els.summarizeButton.disabled = !els.transcript.value.trim();
  els.translateButton.disabled = !els.transcript.value.trim();
  els.saveCloudButton.disabled =
    !supabaseClient || !appSession?.session_token || !els.transcript.value.trim();
}

function updateTimer() {
  const elapsed =
    recordingState === "recording"
      ? elapsedBeforePause + Date.now() - startedAt
      : elapsedBeforePause;
  const formatted = formatTime(elapsed);
  els.timer.textContent = formatted;
  els.durationStat.textContent = formatted;
}

function startTimer() {
  stopTimer();
  timerId = window.setInterval(updateTimer, 500);
  updateTimer();
}

function stopTimer() {
  if (timerId) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("Trình duyệt chưa hỗ trợ IndexedDB."));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionStore(mode = "readonly") {
  const transaction = db.transaction(STORE_NAME, mode);
  return transaction.objectStore(STORE_NAME);
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveSession(session) {
  if (!db) return null;
  if (!appSession?.session_token) {
    const sessions = await getAllSessions();
    if (sessions.length >= GUEST_RECORD_LIMIT) {
      els.storageStat.textContent = "Đạt giới hạn";
      setStatus("Khách chỉ lưu tối đa 2 record cục bộ. Hãy đăng kí để lưu thêm trên Supabase.");
      await renderSessions();
      return null;
    }
  }
  await requestToPromise(transactionStore("readwrite").put(session));
  await renderSessions();
  return session.id;
}

async function updateCurrentSession() {
  if (!db || !currentSessionId) return;
  const session = await requestToPromise(
    transactionStore().get(currentSessionId),
  );
  if (!session) return;
  session.transcript = els.transcript.value.trim();
  session.summary = els.summaryOutput.classList.contains("empty")
    ? ""
    : els.summaryOutput.textContent;
  session.translation = els.translationOutput.classList.contains("empty")
    ? ""
    : els.translationOutput.textContent;
  session.detectedLanguage = detectLanguage(session.transcript);
  session.updatedAt = Date.now();
  await saveSession(session);
}

async function getAllSessions() {
  if (!db) return [];
  const sessions = await requestToPromise(transactionStore().getAll());
  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}

async function deleteSession(id) {
  if (!db) return;
  await requestToPromise(transactionStore("readwrite").delete(id));
  if (currentSessionId === id) currentSessionId = null;
  await renderSessions();
}

function createDownloadUrl(blob) {
  return URL.createObjectURL(blob);
}

function revokeCurrentUrl() {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function setDownload(blob, filename) {
  revokeCurrentUrl();
  currentObjectUrl = createDownloadUrl(blob);
  els.downloadLink.href = currentObjectUrl;
  els.downloadLink.download = filename;
  els.downloadLink.classList.remove("disabled");
  els.downloadLink.removeAttribute("aria-disabled");
}

async function renderSessions() {
  const sessions = await getAllSessions();
  els.libraryStatus.textContent = db
    ? appSession?.session_token
      ? `Đã lưu ${sessions.length} phiên trên trình duyệt này. Đăng nhập: có thể lưu thêm lên Supabase.`
      : `Khách đã lưu ${Math.min(sessions.length, GUEST_RECORD_LIMIT)}/${GUEST_RECORD_LIMIT} record cục bộ. Đăng kí để lưu nhiều record.`
    : "IndexedDB chưa khả dụng trên trình duyệt này.";

  if (!sessions.length) {
    els.sessionList.innerHTML =
      '<div class="empty-library">Chưa có phiên nào. Kết thúc một bản ghi để tự lưu vào IndexedDB.</div>';
    await renderCloudMeetings();
    return;
  }

  els.sessionList.innerHTML = "";
  for (const session of sessions) {
    const item = document.createElement("article");
    item.className = "session-item";
    item.innerHTML = `
      <div>
        <h3>${session.title}</h3>
        <div class="session-meta">
          <span>${formatDate(session.createdAt)}</span>
          <span>${formatTime(session.durationMs)}</span>
          <span>${formatBytes(session.size)}</span>
          <span>${languageName(session.detectedLanguage || "unknown")}</span>
        </div>
      </div>
      <div class="session-actions">
        <button type="button" data-action="open" data-id="${session.id}">Mở</button>
        <a href="${createDownloadUrl(session.blob)}" download="${session.filename}">Tải</a>
        <button type="button" data-action="delete" data-id="${session.id}">Xóa</button>
      </div>
    `;
    els.sessionList.appendChild(item);
  }
  await renderCloudMeetings();
}

async function renderCloudMeetings() {
  els.sessionList
    .querySelectorAll(".cloud-heading, .cloud-item")
    .forEach((item) => item.remove());

  if (!supabaseClient || !appSession?.session_token) return;

  const { data, error } = await supabaseClient.rpc("list_meetings_with_token", {
    p_session_token: appSession.session_token,
  });
  const heading = document.createElement("div");
  heading.className = "cloud-heading";
  heading.textContent = error ? "Record Supabase: chưa tải được" : `Record Supabase: ${data.length}`;
  els.sessionList.appendChild(heading);

  if (error) {
    console.warn(error);
    if (/phiên|session|hết hạn|expired|invalid/i.test(error.message || "")) {
      clearAppSession();
    }
    return;
  }

  for (const meeting of data) {
    const item = document.createElement("article");
    item.className = "session-item cloud-item";
    item.innerHTML = `
      <div>
        <h3>${meeting.title || "Cuộc họp"}</h3>
        <div class="session-meta">
          <span>${formatDate(meeting.created_at)}</span>
          <span>${formatTime(meeting.duration_ms || 0)}</span>
          <span>${formatBytes(meeting.audio_size || 0)}</span>
          <span>${languageName(meeting.detected_language || "unknown")}</span>
        </div>
      </div>
      <div class="session-actions">
        <button type="button" data-action="cloud-summary" data-summary="${encodeURIComponent(meeting.summary || "")}">Mở tóm tắt</button>
      </div>
    `;
    els.sessionList.appendChild(item);
  }
}

async function openSession(id) {
  const session = await requestToPromise(transactionStore().get(id));
  if (!session) return;
  currentSessionId = session.id;
  currentBlob = session.blob;
  elapsedBeforePause = session.durationMs || 0;
  els.transcript.value = session.transcript || "";
  setOutput(els.summaryOutput, session.summary || "");
  setOutput(els.translationOutput, session.translation || "");
  setDownload(session.blob, session.filename);
  els.sizeStat.textContent = formatBytes(session.size);
  updateTimer();
  updateLanguageAndActions();
  setStatus("Đã mở phiên từ IndexedDB");
}

function releaseStream() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  recordingStream = null;
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  recordingDestination = null;
  if (meterId) {
    cancelAnimationFrame(meterId);
    meterId = null;
  }
  els.meterBar.style.width = "0%";
}

async function chooseMicrophone() {
  releaseStream();
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  currentSource = "Micro";
  els.sourceLabel.textContent = "Micro";
  els.micButton.classList.add("active");
  els.tabButton.classList.remove("active");
  prepareStream();
}

async function chooseTabAudio() {
  releaseStream();
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  currentSource = "Tab hoặc màn hình";
  els.sourceLabel.textContent = "Tab hoặc màn hình";
  els.tabButton.classList.add("active");
  els.micButton.classList.remove("active");
  prepareStream();
}

function prepareStream() {
  const audioTracks = stream
    .getAudioTracks()
    .filter((track) => track.readyState === "live");
  if (!audioTracks.length) {
    releaseStream();
    setStatus(
      "Nguồn này không có audio. Hãy chọn lại và bật chia sẻ âm thanh.",
    );
    updateControls("idle");
    return;
  }
  recordingStream = new MediaStream(audioTracks);
  stream.getTracks().forEach((track) => {
    track.onended = () => {
      if (recorder && recorder.state !== "inactive") stopRecording();
    };
  });
  setupMeter();
  setStatus(`Đã chọn ${currentSource}`);
  updateControls(isStarting ? "starting" : "idle");
}

function setupMeter() {
  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(recordingStream);
  recordingDestination = audioContext.createMediaStreamDestination();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  source.connect(recordingDestination);
  recordingStream = recordingDestination.stream;
  const data = new Uint8Array(analyser.frequencyBinCount);

  function draw() {
    analyser.getByteFrequencyData(data);
    const average = data.reduce((sum, value) => sum + value, 0) / data.length;
    els.meterBar.style.width = `${Math.min(100, Math.round((average / 160) * 100))}%`;
    meterId = requestAnimationFrame(draw);
  }

  draw();
}

function startSpeechRecognition() {
  if (!SpeechRecognition) {
    setStatus(
      "Đang ghi âm. Trình duyệt này chưa hỗ trợ live transcript.",
      "recording",
    );
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  if (els.speechLanguage.value !== "auto") {
    recognition.lang = els.speechLanguage.value;
  }

  recognition.onresult = (event) => {
    interimTranscript = "";
    for (
      let index = event.resultIndex;
      index < event.results.length;
      index += 1
    ) {
      const result = event.results[index];
      if (result.isFinal) {
        finalTranscript += `${result[0].transcript.trim()} `;
      } else {
        interimTranscript += result[0].transcript;
      }
    }
    els.transcript.value = `${finalTranscript}${interimTranscript}`.trim();
    updateLanguageAndActions();
  };

  recognition.onend = () => {
    if (recorder?.state === "recording") {
      recognition.start();
    }
  };

  recognition.onerror = () => {
    setStatus(
      "Đang ghi âm. Live transcript bị gián đoạn, file audio vẫn được lưu.",
      "recording",
    );
  };

  recognition.start();
}

function stopSpeechRecognition() {
  if (recognition) {
    recognition.onend = null;
    recognition.stop();
    recognition = null;
  }
}

function resetRecordingState() {
  chunks = [];
  currentBlob = null;
  currentSessionId = null;
  elapsedBeforePause = 0;
  finalTranscript = "";
  interimTranscript = "";
  revokeCurrentUrl();
  els.downloadLink.removeAttribute("href");
  els.downloadLink.removeAttribute("download");
  els.downloadLink.classList.add("disabled");
  els.downloadLink.setAttribute("aria-disabled", "true");
}

async function startRecording() {
  if (
    isStarting ||
    recordingState === "recording" ||
    recordingState === "paused"
  )
    return;
  isStarting = true;
  updateControls("idle");

  if (!stream) {
    try {
      setStatus("Đang xin quyền micro...");
      await chooseMicrophone();
    } catch (error) {
      isStarting = false;
      setStatus(friendlyMediaError(error));
      updateControls("idle");
      return;
    }
  }

  try {
    resetRecordingState();
    startedAt = Date.now();
    if (
      !recordingStream
        ?.getAudioTracks()
        .some((track) => track.readyState === "live")
    ) {
      throw new Error(
        "Nguồn âm thanh đã dừng. Hãy chọn lại micro hoặc tab audio.",
      );
    }
    if (audioContext?.state === "suspended") {
      await audioContext.resume();
    }

    startContinuousRecorder();
    startTimer();
    startSpeechRecognition();
    stopRequested = false;
    paused = false;
    recordingState = "recording";
    setStatus("Đang ghi âm", "recording");
    isStarting = false;
    updateControls("recording");
  } catch (error) {
    isStarting = false;
    recorder = null;
    recordingState = "idle";
    stopTimer();
    stopSpeechRecognition();
    setStatus(`Không bắt đầu ghi âm được: ${error.message}`);
    updateControls("idle");
  }
}

function pauseRecording() {
  if (recordingState !== "recording") return;
  paused = true;
  recordingState = "paused";
  if (recorder?.state === "recording") {
    recorder.pause();
  }
  elapsedBeforePause += Date.now() - startedAt;
  stopTimer();
  stopSpeechRecognition();
  setStatus("Đã tạm dừng");
  updateControls("paused");
}

function resumeRecording() {
  if (recordingState !== "paused") return;
  paused = false;
  recordingState = "recording";
  if (recorder?.state === "paused") {
    recorder.resume();
  }
  startedAt = Date.now();
  startTimer();
  startSpeechRecognition();
  setStatus("Đang ghi âm", "recording");
  updateControls("recording");
}

async function stopRecording() {
  if (recordingState === "idle" && !recorder) return;
  isStarting = false;
  stopRequested = true;
  paused = false;
  if (recordingState === "recording") {
    elapsedBeforePause += Date.now() - startedAt;
  }
  recordingState = "idle";
  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  }
  if (activeChunkPromise) {
    await activeChunkPromise.catch(() => null);
  }
  stopTimer();
  stopSpeechRecognition();
  updateTimer();
  setStatus("Đã kết thúc ghi âm, đang lưu IndexedDB...");
  updateControls("idle");
  buildDownloadAndSave();
}

function updateSize() {
  const bytes = chunks.reduce((total, chunk) => total + chunk.size, 0);
  els.sizeStat.textContent = formatBytes(bytes);
}

function startContinuousRecorder() {
  let lastStartError = null;
  for (const mimeType of getSupportedMimeTypes()) {
    try {
      recorder = new MediaRecorder(
        recordingStream,
        mimeType ? { mimeType } : undefined,
      );
      activeChunkPromise = new Promise((resolve) => {
        recorder.onstop = () => {
          recorder = null;
          activeChunkPromise = null;
          resolve();
        };
      });
      recorder.ondataavailable = (event) => {
        if (event.data?.size) {
          chunks.push(event.data);
          updateSize();
        }
      };
      recorder.onerror = () => {
        const message = recorder?.error?.message || "MediaRecorder bị lỗi.";
        console.warn(message);
        setStatus(`Ghi âm bị lỗi: ${message}`);
      };
      recorder.start(CHUNK_MS);
      return;
    } catch (error) {
      lastStartError = error;
      recorder = null;
      activeChunkPromise = null;
    }
  }

  throw (
    lastStartError ||
    new Error("Không tạo được MediaRecorder cho nguồn âm thanh này.")
  );
}

async function buildDownloadAndSave() {
  if (!chunks.length) {
    setStatus("Đã dừng nhưng chưa có dữ liệu audio để lưu.");
    return;
  }
  currentBlob = new Blob(chunks, { type: chunks[0]?.type || "audio/webm" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `meeting-recording-${timestamp}.webm`;
  setDownload(currentBlob, filename);
  updateSize();

  const session = {
    id: crypto.randomUUID(),
    title: `Phiên họp ${formatDate(Date.now())}`,
    filename,
    blob: currentBlob,
    mimeType: currentBlob.type,
    size: currentBlob.size,
    source: currentSource || "Không rõ",
    durationMs: elapsedBeforePause,
    transcript: els.transcript.value.trim(),
    summary: els.summaryOutput.classList.contains("empty")
      ? ""
      : els.summaryOutput.textContent,
    translation: els.translationOutput.classList.contains("empty")
      ? ""
      : els.translationOutput.textContent,
    detectedLanguage: detectLanguage(els.transcript.value),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  try {
    currentSessionId = await saveSession(session);
    els.storageStat.textContent = "Đã lưu";
    setStatus("Đã lưu phiên vào IndexedDB");
  } catch (error) {
    console.warn(error);
    els.storageStat.textContent = "Lỗi lưu";
    setStatus("Không lưu được IndexedDB, vẫn có thể tải file ghi âm.");
  }
}

function detectLanguage(text) {
  const sample = text.toLowerCase().trim();
  if (!sample) return "unknown";
  const scriptChecks = [
    ["ja", /[\u3040-\u30ff]/],
    ["ko", /[\uac00-\ud7af]/],
    ["zh", /[\u4e00-\u9fff]/],
    ["ar", /[\u0600-\u06ff]/],
    ["he", /[\u0590-\u05ff]/],
    ["ru", /[\u0400-\u04ff]/],
    ["hi", /[\u0900-\u097f]/],
    ["th", /[\u0e00-\u0e7f]/],
    ["el", /[\u0370-\u03ff]/],
    ["ka", /[\u10a0-\u10ff]/],
    ["hy", /[\u0530-\u058f]/],
    ["km", /[\u1780-\u17ff]/],
    ["lo", /[\u0e80-\u0eff]/],
    ["my", /[\u1000-\u109f]/],
    ["bn", /[\u0980-\u09ff]/],
    ["ta", /[\u0b80-\u0bff]/],
    ["te", /[\u0c00-\u0c7f]/],
  ];
  for (const [code, pattern] of scriptChecks) {
    if (pattern.test(sample)) return code;
  }

  const latinSignals = [
    ["vi", /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]|\b(và|của|không|một|cuộc|họp|việc)\b/i],
    ["en", /\b(the|and|meeting|call|next|action|project|deadline|with|for|this)\b/i],
    ["fr", /\b(le|la|les|des|bonjour|merci|réunion|avec|pour|est|une)\b/i],
    ["es", /\b(el|la|los|las|hola|gracias|reunión|con|para|una|que)\b/i],
    ["de", /\b(der|die|das|und|danke|besprechung|mit|für|nicht|ist)\b/i],
    ["it", /\b(il|lo|la|gli|ciao|grazie|riunione|con|per|non|che)\b/i],
    ["pt", /\b(o|a|os|as|olá|obrigado|reunião|com|para|não|que)\b/i],
    ["id", /\b(dan|yang|tidak|rapat|dengan|untuk|terima kasih)\b/i],
    ["ms", /\b(dan|yang|tidak|mesyuarat|dengan|untuk|terima kasih)\b/i],
    ["tr", /\b(ve|bir|toplantı|ile|için|değil|teşekkür)\b/i],
    ["nl", /\b(de|het|een|en|vergadering|met|voor|niet|dank)\b/i],
    ["pl", /\b(i|oraz|spotkanie|nie|dla|dziękuję|jest)\b/i],
    ["sv", /\b(och|det|möte|inte|för|tack|med)\b/i],
  ];
  for (const [code, pattern] of latinSignals) {
    if (pattern.test(sample)) return code;
  }

  return "unknown";
}

function languageName(code) {
  if (code === "unknown") return "Chưa xác định";
  try {
    const display = new Intl.DisplayNames(["vi", "en"], { type: "language" });
    return display.of(code) || code;
  } catch {
    return code;
  }
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function summarizeText(text) {
  const sentences = splitSentences(text);
  if (!sentences.length) return "";

  const keywords = [
    "quyết định",
    "thống nhất",
    "deadline",
    "hạn",
    "việc cần làm",
    "action",
    "todo",
    "next step",
    "kết luận",
    "rủi ro",
    "vấn đề",
    "issue",
    "follow up",
  ];
  const scored = sentences.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    const keywordScore = keywords.reduce(
      (score, keyword) => score + (lower.includes(keyword) ? 3 : 0),
      0,
    );
    const lengthScore = Math.min(sentence.length / 120, 2);
    const positionScore = index < 2 ? 1.2 : 0;
    return { sentence, score: keywordScore + lengthScore + positionScore };
  });

  const chosen = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(6, Math.max(3, Math.ceil(sentences.length * 0.25))))
    .map((item) => item.sentence);

  const actions = sentences.filter((sentence) =>
    /(cần|sẽ|phải|deadline|hạn|todo|action|next|assign|owner|follow up)/i.test(
      sentence,
    ),
  );

  return [
    "Tổng quan:",
    ...chosen.map((sentence) => `- ${sentence}`),
    "",
    "Việc cần theo dõi:",
    ...(actions.length
      ? actions.slice(0, 6).map((sentence) => `- ${sentence}`)
      : ["- Chưa phát hiện đầu việc rõ ràng."]),
  ].join("\n");
}

async function detectLanguageWithBrowser(text) {
  if (!("LanguageDetector" in self)) return detectLanguage(text);

  try {
    const detector = await self.LanguageDetector.create();
    const detected = await detector.detect(text);
    return detected[0]?.detectedLanguage || detectLanguage(text);
  } catch (error) {
    console.warn(error);
    return detectLanguage(text);
  }
}

async function translateWithBrowser(text, targetLanguage, sourceLanguage) {
  if (!("Translator" in self)) return "";
  if (sourceLanguage === targetLanguage) return text;

  if (typeof self.Translator.availability === "function") {
    const availability = await self.Translator.availability({
      sourceLanguage,
      targetLanguage,
    });
    if (availability === "unavailable") return "";
  }

  const translator = await self.Translator.create({
    sourceLanguage,
    targetLanguage,
  });
  return translator.translate(text);
}

async function translateText() {
  const text = els.transcript.value.trim();
  if (!text) return;

  const targetLanguage = els.targetLanguage.value;
  const detected = await detectLanguageWithBrowser(text);
  els.translationStatus.textContent = "Đang dịch...";

  if (detected === targetLanguage) {
    setOutput(
      els.translationOutput,
      `Transcript đã là ${languageName(targetLanguage)}, nên không cần dịch.`,
    );
    els.translationStatus.textContent = "Ngôn ngữ đích trùng transcript";
    await updateCurrentSession();
    return;
  }

  try {
    const translated = await translateWithBrowser(
      text,
      targetLanguage,
      detected,
    );
    if (translated) {
      setOutput(els.translationOutput, translated);
      els.translationStatus.textContent = `Đã dịch sang ${languageName(targetLanguage)}`;
      await updateCurrentSession();
      return;
    }
  } catch (error) {
    console.warn(error);
  }

  const message = [
    `Chưa có bộ dịch khả dụng trên trình duyệt này. Đã phát hiện transcript là: ${languageName(detected)}.`,
    "",
    "Để dịch tự động không cần server riêng, trình duyệt cần hỗ trợ Chrome Built-in AI Translator. Nếu muốn dịch ổn định trên mọi máy, app cần thêm API dịch hoặc AI sau.",
  ].join("\n");
  setOutput(els.translationOutput, message);
  els.translationStatus.textContent = "Cần bộ dịch hoặc API";
  await updateCurrentSession();
}

async function saveMeetingToSupabase() {
  if (!supabaseClient) {
    els.cloudStat.textContent = "Chưa cấu hình";
    setStatus(SUPABASE_PLACEHOLDER);
    return;
  }
  if (!appSession?.session_token) {
    setStatus("Hãy đăng nhập hoặc đăng kí để lưu nhiều record lên Supabase.");
    return;
  }

  const transcript = els.transcript.value.trim();
  if (!transcript) {
    setStatus("Chưa có transcript để lưu.");
    return;
  }

  const summary = els.summaryOutput.classList.contains("empty")
    ? summarizeText(transcript)
    : els.summaryOutput.textContent;
  els.cloudStat.textContent = "Đang lưu...";
  const { data, error } = await supabaseClient.rpc("save_meeting_with_token", {
    p_session_token: appSession.session_token,
    p_title: `Cuộc họp ${new Date().toLocaleString("vi-VN")}`,
    p_summary: summary,
    p_transcript: transcript,
    p_translation: els.translationOutput.classList.contains("empty") ? "" : els.translationOutput.textContent,
    p_duration_ms: elapsedBeforePause,
    p_audio_size: chunks.reduce((total, chunk) => total + chunk.size, 0),
    p_detected_language: detectLanguage(transcript),
  });

  if (error) {
    console.warn(error);
    els.cloudStat.textContent = "Lỗi";
    setStatus(`Lưu thất bại: ${error.message}`);
    return;
  }

  els.cloudStat.textContent = "Đã lưu";
  setStatus(`Đã lưu record #${data} lên Supabase.`);
  await renderCloudMeetings();
}

function updateLanguageAndActions() {
  const text = els.transcript.value.trim();
  const detected = detectLanguage(text);
  els.detectedLanguage.textContent = `Language detect: ${languageName(detected)}`;
  updateControls(recordingState);
}

async function summarizeTranscript() {
  const text = els.transcript.value.trim();
  const summary = summarizeText(text);
  setOutput(els.summaryOutput, summary || "Chưa có đủ nội dung để tóm tắt.");
  updateLanguageAndActions();
  await updateCurrentSession();
}

els.micButton.addEventListener("click", () =>
  chooseMicrophone().catch((error) => setStatus(friendlyMediaError(error))),
);
els.tabButton.addEventListener("click", () =>
  chooseTabAudio().catch((error) => setStatus(friendlyMediaError(error))),
);
els.startButton.addEventListener("click", () =>
  startRecording().catch((error) => setStatus(error.message)),
);
els.pauseButton.addEventListener("click", pauseRecording);
els.resumeButton.addEventListener("click", resumeRecording);
els.stopButton.addEventListener("click", stopRecording);
els.summarizeButton.addEventListener("click", summarizeTranscript);
els.translateButton.addEventListener("click", translateText);
els.saveCloudButton.addEventListener("click", () =>
  saveMeetingToSupabase().catch((error) => setStatus(error.message)),
);
els.topLogoutButton.addEventListener("click", async () => {
  clearAppSession();
  els.libraryStatus.textContent = `Khách được lưu tối đa ${GUEST_RECORD_LIMIT} record cục bộ. Đăng kí để lưu nhiều record.`;
  setStatus("Đã đăng xuất.");
  await renderSessions();
});
els.refreshLibraryButton.addEventListener("click", renderSessions);
els.clearTranscriptButton.addEventListener("click", async () => {
  finalTranscript = "";
  interimTranscript = "";
  els.transcript.value = "";
  setOutput(els.summaryOutput, "");
  setOutput(els.translationOutput, "");
  updateLanguageAndActions();
  await updateCurrentSession();
});
els.transcript.addEventListener("input", updateLanguageAndActions);
els.transcript.addEventListener("change", updateCurrentSession);
els.sessionList.addEventListener("click", async (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const { action, id } = target.dataset;
  if (action === "open") await openSession(id);
  if (action === "delete") await deleteSession(id);
  if (action === "cloud-summary") {
    setOutput(els.summaryOutput, decodeURIComponent(target.dataset.summary || ""));
  }
});

async function init() {
  setupSupabase();
  loadAppSession();
  renderPasswordWarning();

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus("Trình duyệt chưa hỗ trợ MediaRecorder/getUserMedia.");
    els.micButton.disabled = true;
    els.tabButton.disabled = true;
  } else {
    updateControls("idle");
  }

  try {
    db = await openDatabase();
    els.storageStat.textContent = "Sẵn sàng";
    await renderSessions();
  } catch (error) {
    console.warn(error);
    els.storageStat.textContent = "Không hỗ trợ";
    els.libraryStatus.textContent =
      "Không mở được IndexedDB. App vẫn ghi và tải file trong phiên hiện tại.";
    els.sessionList.innerHTML =
      '<div class="empty-library">IndexedDB không khả dụng trên trình duyệt này.</div>';
  }
}

init();
