const APP_SESSION_KEY = "meetingRecorderAppSession";

const els = {
  title: document.querySelector("#authTitle"),
  form: document.querySelector("#authForm"),
  username: document.querySelector("#usernameInput"),
  password: document.querySelector("#passwordInput"),
  warning: document.querySelector("#passwordWarning"),
  message: document.querySelector("#authMessage"),
  submit: document.querySelector("#submitAuthButton"),
  loginTab: document.querySelector("#loginTab"),
  registerTab: document.querySelector("#registerTab"),
};

let mode = new URLSearchParams(location.search).get("mode") === "register" ? "register" : "login";
let supabaseClient = null;

function getSupabaseConfig() {
  let domConfig = {};
  const configEl = document.querySelector("#supabase-config");
  if (configEl?.textContent?.trim()) {
    try {
      domConfig = JSON.parse(configEl.textContent);
    } catch {
      domConfig = {};
    }
  }
  return { ...domConfig, ...(window.SUPABASE_CONFIG || {}) };
}

function setupSupabase() {
  const config = getSupabaseConfig();
  const url = (config.url || "").trim();
  const anonKey = (config.anonKey || "").trim();
  if (!window.supabase || !url || !anonKey) {
    els.message.textContent = "Chưa cấu hình Supabase URL/anon key trong env.js.";
    return;
  }
  supabaseClient = window.supabase.createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function isPasswordValid(password) {
  return password.length >= 8 && /[^A-Za-z0-9]/.test(password);
}

function isUsernameValid(username) {
  return /^[a-z0-9_.-]{3,32}$/i.test(username.trim());
}

function renderPasswordWarning() {
  const password = els.password.value;
  if (!password) {
    els.warning.textContent = "Mật khẩu cần ít nhất 8 ký tự và 1 ký tự đặc biệt.";
    els.warning.classList.remove("ok");
    return;
  }
  if (isPasswordValid(password)) {
    els.warning.textContent = "Mật khẩu hợp lệ.";
    els.warning.classList.add("ok");
  } else {
    els.warning.textContent = "Thiếu điều kiện: tối thiểu 8 ký tự và phải có ký tự đặc biệt.";
    els.warning.classList.remove("ok");
  }
}

function setMode(nextMode) {
  mode = nextMode;
  const isRegister = mode === "register";
  els.title.textContent = isRegister ? "Đăng kí" : "Đăng nhập";
  els.submit.textContent = isRegister ? "Đăng kí" : "Đăng nhập";
  els.loginTab.classList.toggle("active", !isRegister);
  els.registerTab.classList.toggle("active", isRegister);
  history.replaceState(null, "", `auth.html?mode=${mode}`);
}

async function submitAuth(event) {
  event.preventDefault();
  if (!supabaseClient) {
    els.message.textContent = "Chưa kết nối Supabase.";
    return;
  }

  const username = els.username.value.trim().toLowerCase();
  const password = els.password.value;
  if (!isUsernameValid(username)) {
    els.message.textContent = "Username cần 3-32 ký tự: chữ, số, dấu chấm, gạch hoặc gạch dưới.";
    return;
  }
  if (!isPasswordValid(password)) {
    renderPasswordWarning();
    els.message.textContent = "Mật khẩu chưa đủ mạnh.";
    return;
  }

  els.submit.disabled = true;
  els.message.textContent = mode === "register" ? "Đang đăng kí..." : "Đang đăng nhập...";
  const fn = mode === "register" ? "register_app_user" : "login_app_user";
  const { data, error } = await supabaseClient.rpc(fn, {
    p_username: username,
    p_password: password,
  });
  els.submit.disabled = false;

  if (error) {
    els.message.textContent = error.message;
    return;
  }

  const session = Array.isArray(data) ? data[0] : data;
  localStorage.setItem(APP_SESSION_KEY, JSON.stringify(session));
  els.message.textContent = "Thành công. Đang quay về trang chính...";
  window.setTimeout(() => {
    location.href = "index.html";
  }, 500);
}

els.loginTab.addEventListener("click", () => setMode("login"));
els.registerTab.addEventListener("click", () => setMode("register"));
els.password.addEventListener("input", renderPasswordWarning);
els.form.addEventListener("submit", submitAuth);

setupSupabase();
setMode(mode);
renderPasswordWarning();
