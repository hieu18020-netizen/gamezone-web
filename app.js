const API_URL = window.APP_CONFIG ? window.APP_CONFIG.API_URL : "http://localhost:5000/api";

let dbLeaderboard = [];

// ===== Hệ thống Rank theo điểm =====
// Mỗi 200 điểm = 1 bậc. 5 đại bậc đầu (Sắt, Bạc, Vàng, Bạch Kim, Kim Cương)
// có 4 tiểu bậc IV → I. Sau đó là Cao Thủ rồi Thách Đấu (không chia tiểu bậc).
const RANK_STEP = 200;
const RANK_TIERS = [
  { name: "Sắt",       icon: "🔩", color: "#8c8c8c" },
  { name: "Bạc",       icon: "🥈", color: "#c7d0da" },
  { name: "Vàng",      icon: "🥇", color: "#e8c97a" },
  { name: "Bạch Kim",  icon: "💠", color: "#5fd0c7" },
  { name: "Kim Cương", icon: "💎", color: "#60a5fa" },
];
const RANK_SUBS = ["IV", "III", "II", "I"];
const MASTER_THRESHOLD = RANK_TIERS.length * RANK_SUBS.length * RANK_STEP; // 4000
const CHALLENGER_THRESHOLD = MASTER_THRESHOLD + 2000;                     // 6000

function getRankTier(score) {
  score = Math.max(0, Number(score) || 0);

  if (score >= CHALLENGER_THRESHOLD) {
    return { name: "Thách Đấu", icon: "👑", color: "#ff6b5f" };
  }
  if (score >= MASTER_THRESHOLD) {
    return { name: "Cao Thủ", icon: "🔥", color: "#a78bfa" };
  }

  const idx = Math.floor(score / RANK_STEP);           // bậc thứ mấy (0-based)
  const tierIdx = Math.floor(idx / RANK_SUBS.length);   // đại bậc
  const subIdx = idx % RANK_SUBS.length;                // tiểu bậc
  const tier = RANK_TIERS[tierIdx];
  return { name: `${tier.name} ${RANK_SUBS[subIdx]}`, icon: tier.icon, color: tier.color };
}

const rarityColor = {
  "Huyền thoại":"#e8c97a",
  "Siêu hiếm"  :"#a78bfa",
  "Hiếm"       :"#60a5fa",
  "Thường"     :"rgba(248,247,244,.4)",
};

const strengthColor = ["#e53e3e","#e8914a","#e8c97a","#38a169"];
const strengthLabel = ["Rất yếu","Yếu","Trung bình","Mạnh"];
const suggestions = ["ShadowFox","IronViper","NeonBlade","CrimsonAce","VoidWolf","StormKing"];

// ===== Huy hiệu =====
// Danh mục huy hiệu (phần hiển thị). Việc ai đã đạt huy hiệu nào do BACKEND tính từ dữ liệu thật
// (hàm compute_badges trong backend.py) và trả về dưới dạng danh sách mã `badges`.
const BADGE_CATALOG = [
  {code:"rookie",       icon:"🎮", label:"Tân binh",      desc:"Chơi ván đầu tiên",           rarity:"Thường"},
  {code:"tetris_500",   icon:"🧱", label:"Thợ xếp hình",  desc:"Đạt 500 điểm Tetris",         rarity:"Thường"},
  {code:"snake_300",    icon:"🐍", label:"Thợ săn rắn",   desc:"Đạt 300 điểm Rắn săn mồi",    rarity:"Thường"},
  {code:"chess_win",    icon:"♟️", label:"Nước cờ đầu",   desc:"Thắng 1 ván cờ vua",          rarity:"Thường"},
  {code:"friends_3",    icon:"🤝", label:"Hòa đồng",      desc:"Có 3 người bạn",              rarity:"Hiếm"},
  {code:"chibi_3",      icon:"🐣", label:"Nhà sưu tầm",   desc:"Sở hữu 3 chibi",              rarity:"Hiếm"},
  {code:"diamond",      icon:"💎", label:"Kim cương",     desc:"Đạt rank Kim Cương",          rarity:"Siêu hiếm"},
  {code:"top3",         icon:"👑", label:"Tinh hoa",      desc:"Lọt top 3 bảng xếp hạng",     rarity:"Siêu hiếm"},
  {code:"quest_master", icon:"🏆", label:"Nhà thám hiểm", desc:"Hoàn thành tất cả nhiệm vụ",  rarity:"Huyền thoại"},
];

// Gắn cờ earned cho từng huy hiệu theo danh sách mã server trả về.
function badgesFor(codes){
  const got = new Set(codes || []);
  return BADGE_CATALOG.map(b => ({ ...b, earned: got.has(b.code) }));
}

function badgeProgress(list){
  const total = list.length;
  const earned = list.filter(a => a.earned).length;
  return { total, earned, pct: total ? Math.round(earned * 100 / total) : 0 };
}

function badgeCardHtml(a){
  return `
    <div class="achievement${a.earned ? "" : " locked"}">
      ${a.earned ? "" : `<span class="achv-lock" aria-hidden="true">🔒</span>`}
      <div class="icon">${a.icon}</div>
      <strong>${a.label}${a.earned ? " ✓" : ""}</strong>
      <p>${a.desc}</p>
      <span class="rarity" style="color:${rarityColor[a.rarity]}">${a.rarity}</span>
    </div>`;
}

let s = {
  view        : "login",
  username    : "",
  loginPass   : "",
  nick        : "",
  avatar      : "",
  token       : "",
  gameSessionToken: "",
  userRank    : "#-",
  userMatches : 0,
  userHighScore: 0,     // TỔNG điểm xếp hạng (Tetris + cờ vua + rắn)
  userSnakeScore: 0,    // kỷ lục riêng của rắn săn mồi
  userPublicId: "--------",
  badges: [],           // mã huy hiệu đã đạt (server tính)
  showLogin   : false,
  regPass     : "",
  showReg     : false,
  confirm     : "",
  showConfirm : false,
  remember    : false,
  agree       : false,
  regOk       : false,
  filter      : "all",
  isLoading   : false,
  searchQuery : "",
  selectedGame: "tetris",

  // vàng + nhiệm vụ
  gold        : 0,
  quests      : [],
  questsLoaded: false,
  claimingQuest: false,

  // lịch sử chơi
  gameHistory : [],
  gameHistorySummary: null,
  gameHistoryLoaded : false,
  historyFilter: "all",

  // chibi + cửa hàng
  activeChibiCodes    : new Set(),   // chibi đang chạy trên màn hình
  unlockedChibiCodes  : new Set(),   // chibi tài khoản đã mở khoá
  chibis              : [],          // danh sách chibi từ server
  chibiPrices         : {},
  chibisLoaded        : false,
  chibisError         : null,
  chibiFilter         : "all",
  shopBusy            : false,

  // thông báo
  notifications  : [],
  notifUnread    : 0,
  notifOpen      : false,
  notifLoaded    : false,
  notifLastId    : null,
  notifNewIds    : new Set(),   // id thông báo mới lúc mở chuông (vẫn tô sáng dù số đỏ đã về 0)

  // bạn bè + tin nhắn
  friends            : [],
  friendsIncoming    : [],
  friendsOutgoing    : [],
  friendsLoaded      : false,
  conversations      : [],
  conversationsLoaded: false,
  chatPeer           : null,   // { public_id, display_name, avatar } người đang nhắn tin cùng
  chatMessages       : [],
  chatHasMore        : false,
  chatLoading        : false,
  chatSending        : false,
};

// ===== Ghi nhớ đăng nhập (để F5 / mở lại tab không bị đá về trang login) =====
// - "Ghi nhớ đăng nhập" được tick -> lưu vào localStorage (tồn tại kể cả sau khi đóng trình duyệt)
// - Không tick -> lưu vào sessionStorage (chỉ tồn tại trong tab hiện tại, mất khi đóng tab)
const SESSION_KEY = "gz_session";
const RESTORABLE_VIEWS = ["home", "games", "game", "quests", "history", "chibi", "shop", "friends", "messages"];

function saveSession(){
  if (!s.username) return;
  const view = RESTORABLE_VIEWS.includes(s.view) ? s.view : "home";
  const payload = JSON.stringify({ username: s.username, nick: s.nick, avatar: s.avatar, token: s.token, view, selectedGame: s.selectedGame });
  try {
    if (s.remember) {
      localStorage.setItem(SESSION_KEY, payload);
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, payload);
      localStorage.removeItem(SESSION_KEY);
    }
  } catch (err) {
    console.error("Lỗi lưu phiên đăng nhập:", err);
  }
}

function loadSession(){
  try {
    const raw = localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

function clearSession(){
  try {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  } catch (err) { /* noop */ }
}

function logout(){
  clearSession();
  stopNotifPolling();
  disconnectMessagesSocket();
  if (window.ChibiRunner) window.ChibiRunner.stop();   // dọn TẤT CẢ chibi đang chạy
  s.username = "";
  s.nick = "";
  s.avatar = "";
  s.loginPass = "";
  s.token = "";
  s.userRank = "#-";
  s.userMatches = 0;
  s.userHighScore = 0;
  s.userSnakeScore = 0;
  s.userPublicId = "--------";
  s.badges = [];
  s.gold = 0;
  s.quests = []; s.questsLoaded = false;
  s.gameHistory = []; s.gameHistorySummary = null; s.gameHistoryLoaded = false;
  s.activeChibiCodes = new Set(); s.unlockedChibiCodes = new Set();
  s.chibis = []; s.chibisLoaded = false; s.chibisError = null;
  s.notifications = []; s.notifUnread = 0; s.notifLoaded = false; s.notifLastId = null; s.notifOpen = false;
  s.notifNewIds = new Set();
  s.friends = []; s.friendsIncoming = []; s.friendsOutgoing = []; s.friendsLoaded = false;
  s.conversations = []; s.conversationsLoaded = false;
  s.chatPeer = null; s.chatMessages = [];
  dbLeaderboard = [];
  go("login");
}

// Áp dữ liệu từ /user-stats vào state (dùng chung cho restoreSession / fetchUserStats / submitScore).
function applyUserStats(data){
  s.userRank = data.rank;
  s.userMatches = data.total_matches;
  s.userHighScore = data.high_score || 0;
  s.userSnakeScore = data.snake_score || 0;
  s.badges = data.badges || [];
  s.userPublicId = data.public_id || "--------";
  if (data.avatar) s.avatar = data.avatar;
  if (data.active_chibi_codes !== undefined) {
    s.activeChibiCodes = new Set(data.active_chibi_codes || []);
    applyChibiRunnerState();
  }
}

// Sau khi đăng nhập / khôi phục phiên: tải mọi dữ liệu cần cho thanh menu và bật các kênh realtime.
function afterLogin(){
  fetchLeaderboard();
  fetchUserStats();
  fetchChibis();
  fetchQuests();
  fetchFriends();
  fetchConversations();
  startNotifPolling();
  connectMessagesSocket();
}

// Khôi phục phiên đăng nhập khi mở lại trang (F5, mở tab mới...).
// Xác thực lại bằng cách gọi /api/user-stats — nếu tài khoản không còn tồn tại thì tự đăng xuất.
async function restoreSession(){
  const saved = loadSession();
  if (!saved || !saved.username) return false;

  s.username = saved.username;
  s.nick = saved.nick || saved.username;
  s.avatar = saved.avatar || "";
  s.token = saved.token || "";
  s.view = RESTORABLE_VIEWS.includes(saved.view) ? saved.view : "home";
  s.selectedGame = saved.selectedGame || "tetris";
  render();

  try {
    const res = await fetch(`${API_URL}/user-stats/${encodeURIComponent(s.username)}`);
    if (!res.ok) { logout(); return false; }
    applyUserStats(await res.json());
    saveSession();
    afterLogin();
    render();
    return true;
  } catch (err) {
    console.error("Lỗi khôi phục phiên đăng nhập:", err);
    return true; // giữ nguyên giao diện, chỉ là chưa lấy được dữ liệu mới nhất (có thể do mất mạng)
  }
}

// Gọi các API cần đăng nhập, tự gắn token vào header.
// Nếu server trả 401 (token hết hạn / không hợp lệ) thì tự đăng xuất về màn login.
async function authFetch(url, options = {}) {
  const headers = Object.assign({}, options.headers, {
    "Authorization": `Bearer ${s.token}`
  });
  const res = await fetch(url, Object.assign({}, options, { headers }));
  if (res.status === 401 && s.token) {
    alert("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
    logout();
  }
  return res;
}

async function fetchLeaderboard() {
  try {
    const headers = s.token ? { "Authorization": `Bearer ${s.token}` } : {};
    const res = await fetch(`${API_URL}/leaderboard`, { headers });
    if (res.ok) {
      dbLeaderboard = await res.json();
      if (s.view === "home") render();
    }
  } catch (err) {
    console.error("Lỗi lấy dữ liệu xếp hạng:", err);
  }
}

async function fetchUserStats() {
  if (!s.username) return;
  try {
    const res = await fetch(`${API_URL}/user-stats/${encodeURIComponent(s.username)}`);
    if (res.ok) {
      applyUserStats(await res.json());
      if (["home", "games", "game"].includes(s.view) && s.view !== "game") render();
    }
  } catch (err) {
    console.error("Lỗi lấy thông tin profile:", err);
  }
}


// ================== GIAO DIỆN ĐĂNG NHẬP / ĐĂNG KÝ / BÍ DANH ==================
function logo(center){
  const clickable = center ? '' : ' onclick="go(\'home\')" style="cursor:pointer"';
  return `<div class="logo${center?' center-logo':''}"${clickable}>
    <div class="logo-mark">◆</div>
    <span class="logo-name">GameZone</span>
  </div>`;
}

function socialBtns(){
  return `<div class="social">
    <button type="button">🔵 Google</button>
    <button type="button">▦ Microsoft</button>
  </div>`;
}

function divider(txt){
  return `<div class="divider"><hr><span>${txt}</span><hr></div>`;
}

function pwField(id, placeholder, val, showKey, onInput){
  const type = s[showKey] ? "text" : "password";
  return `<div style="position:relative">
    <input class="input input-pw" id="${id}" type="${type}" placeholder="${placeholder}" value="${esc(val)}"
      oninput="${onInput}">
    <button class="eye" type="button" onclick="toggle('${showKey}')">
      ${s[showKey]?"🙈":"👁"}
    </button>
  </div>`;
}

function esc(str){
  return String(str)
    .replace(/&/g,"&amp;")
    .replace(/"/g,"&quot;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/'/g,"&#39;");
}

// Hiện thông báo lỗi dạng khung chữ đỏ bên dưới form (ví dụ: sai độ dài tài khoản/mật khẩu).
function showFieldError(boxId, message){
  const box = document.getElementById(boxId);
  if (box) box.innerHTML = message ? `<div class="mismatch">${esc(message)}</div>` : "";
}

// Trả về nội dung bên trong 1 khối .avatar / .avatar-big / .player-avatar:
// nếu có ảnh đại diện thì hiện ảnh, không thì hiện chữ cái viết tắt.
function avatarHtml(avatarData, initials){
  // Chỉ chấp nhận avatar dạng data URL ảnh hợp lệ (data:image/...;base64,...).
  // Mọi giá trị khác (kể cả chuỗi bị chèn mã độc) đều bị bỏ qua, dùng chữ cái đầu thay thế.
  const isSafeImage = typeof avatarData === "string" && /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarData);
  if (isSafeImage) return `<img src="${esc(avatarData)}" alt="avatar">`;
  return esc(initials);
}

function strengthBar(pw){
  if(!pw) return "";
  const score = (pw.length>=8?1:0)+(/[A-Z]/.test(pw)?1:0)+(/[0-9]/.test(pw)?1:0)+(/[^A-Za-z0-9]/.test(pw)?1:0);
  const bars = [0,1,2,3].map(i=>
    `<i style="background:${i<score?strengthColor[score-1]:"rgba(12,15,26,.1)"}"></i>`
  ).join("");
  return `<div class="strength">${bars}</div>
    <div class="strength-text" style="color:${strengthColor[score-1]}">${strengthLabel[score-1]}</div>`;
}

function checkbox(key, label){
  return `<div class="checkrow" onclick="toggle('${key}')">
    <div class="check${s[key]?' on':''}">${s[key]?"✓":""}</div>
    <span style="font-size:13px;color:rgba(12,15,26,.65);line-height:1.5">${label}</span>
  </div>`;
}

function isRegisterFormValid() {
  const usernameOk = s.username && !/\s/.test(s.username);
  const passwordOk = s.regPass && !/\s/.test(s.regPass) && /[A-Za-z]/.test(s.regPass) && /\d/.test(s.regPass);
  const confirmOk = s.confirm && s.confirm === s.regPass;
  return usernameOk && passwordOk && confirmOk && s.agree;
}

function refreshRegisterButton() {
  const btnRegister = document.getElementById("btnRegister");
  if (btnRegister) btnRegister.disabled = !isRegisterFormValid() || s.isLoading;
}

function checkUsernameFormat(val) {
  s.username = val;
  const container = document.getElementById("usernameErrorContainer");
  const error = val && /\s/.test(val) ? "Tên tài khoản không được chứa khoảng trắng" : "";
  if (container) container.innerHTML = error ? `<div class="mismatch">${esc(error)}</div>` : "";
  refreshRegisterButton();
}

function updatePasswordStrength(val) {
  s.regPass = val;
  const container = document.getElementById("strengthContainer");
  if (container) container.innerHTML = strengthBar(val);

  const errorContainer = document.getElementById("passwordErrorContainer");
  let error = "";
  if (val && /\s/.test(val)) error = "Mật khẩu không được chứa khoảng trắng";
  else if (val && !(/[A-Za-z]/.test(val) && /\d/.test(val))) error = "Mật khẩu phải có cả chữ và số";
  if (errorContainer) errorContainer.innerHTML = error ? `<div class="mismatch">${esc(error)}</div>` : "";

  checkPasswordMatch(s.confirm);
}

function checkPasswordMatch(val) {
  s.confirm = val;
  const mismatchContainer = document.getElementById("mismatchContainer");
  const isMismatch = s.confirm && s.confirm !== s.regPass;

  if (mismatchContainer) {
    mismatchContainer.innerHTML = isMismatch ? '<div class="mismatch">Mật khẩu không khớp</div>' : '';
  }
  refreshRegisterButton();
}

function leftPanel(){
  return `<aside class="left">
    <div class="gridbg gridbg-abs"></div>
    <div class="glow-gold glow-abs"></div>
    ${logo()}
    <div class="left-main">
      <div class="eyebrow">🎮 Game Online — Chơi ngay, thắng ngay</div>
      <h1>Sẵn sàng<br><span>chiến chưa?</span></h1>
      <p>Tham gia hàng ngàn game thủ mỗi ngày — đấu rank, leo bảng, nhận thưởng.</p>
      <div class="stats">
        <div class="stat"><b>84K+</b><small>Game thủ online</small></div>
        <div class="stat"><b>Top 2</b><small>Server Việt Nam</small></div>
        <div class="stat"><b>24/7</b><small>Máy chủ ổn định</small></div>
      </div>
    </div>
    <div class="user-mini">
      <div class="avatar-sm">KG</div>
      <div>
        <div style="font-size:12px">Kiên Giỏi Lý</div>
        <div style="font-size:11px;color:rgba(248,247,244,.4)">Sinh viên lười vượt dễ</div>
      </div>
    </div>
  </aside>`;
}

function cornerCat(pos){
  return `<div class="corner-pet ${pos}">
    <div class="cat-orange">
      <div class="c-eyes">
        <div class="c-eye"><div class="pupil"></div></div>
        <div class="c-eye"><div class="pupil"></div></div>
      </div>
    </div>
  </div>`;
}

function cornerPets(){
  return `${cornerCat("tl")}${cornerCat("tr")}${cornerCat("bl")}${cornerCat("br")}`;
}

function loginView(){
  return `<div class="auth">
    ${leftPanel()}
    <main class="auth-right">
      ${cornerPets()}
      <div class="form fade">
        <div class="pets-row">
          <div class="pet-box">
            <div class="pet-rig" data-pet="cat">
              <div class="cat-orange">
                <div class="c-eyes">
                  <div class="c-eye"><div class="pupil"></div></div>
                  <div class="c-eye"><div class="pupil"></div></div>
                </div>
              </div>
              <div class="pet-neck neck-cat"></div>
            </div>
            <div class="pet-base"></div>
          </div>
          <div class="pet-box">
            <div class="pet-rig" data-pet="dog">
              <div class="dog-brown">
                <div class="dog-ear-l"></div>
                <div class="dog-ear-r"></div>
                <div class="dog-hand"></div>
                <div class="c-eyes" style="padding-top:12px">
                  <div class="c-eye"><div class="pupil"></div></div>
                  <div class="c-eye"><div class="pupil"></div></div>
                </div>
                <div class="dog-tongue"></div>
              </div>
              <div class="pet-neck neck-dog"></div>
            </div>
            <div class="pet-base"></div>
          </div>
          <div class="pet-box">
            <div class="pet-rig" data-pet="owl">
              <div class="owl-body">
                <div class="owl-eyes">
                  <div class="owl-eye"><div class="pupil" style="top:2px;left:2px"></div></div>
                  <div class="owl-eye"><div class="pupil" style="top:2px;left:2px"></div></div>
                </div>
              </div>
              <div class="pet-neck neck-owl"></div>
            </div>
            <div class="owl-branch"></div>
          </div>
          <div class="pet-box">
            <div class="pet-rig" data-pet="rabbit">
              <div class="rabbit-body">
                <div class="r-ear-l"></div>
                <div class="r-ear-r"></div>
                <div class="r-eyes">
                  <div class="r-eye"><div class="pupil r-pupil"></div></div>
                  <div class="r-eye"><div class="pupil r-pupil"></div></div>
                </div>
              </div>
              <div class="pet-neck neck-rabbit"></div>
            </div>
            <div class="pet-base"></div>
          </div>
        </div>

        <h2>Đăng nhập</h2>
        <p class="sub">Chưa có tài khoản? <button class="link" onclick="go('register')">Đăng ký miễn phí</button></p>
        <form onsubmit="doLogin(event)">
          <div class="field">
            <label>Tên đăng nhập</label>
            <input class="input" required placeholder="Nhập tên đăng nhập..."
              id="loginUser" value="${esc(s.username)}" oninput="s.username=this.value">
          </div>
          <div class="field">
            <div class="field-row">
              <label style="margin:0">Mật khẩu</label>
              <button class="link" type="button" style="font-size:11px">Quên mật khẩu?</button>
            </div>
            <div style="margin-top:.5rem">
              ${pwField("loginPass","••••••••",s.loginPass,"showLogin","s.loginPass=this.value")}
            </div>
          </div>
          ${checkbox("remember","Ghi nhớ đăng nhập")}
          <div id="loginErrorBox"></div>
          <button class="primary" ${s.isLoading ? "disabled" : ""}>${s.isLoading ? "Đang xử lý..." : "Đăng nhập"}</button>
        </form>
        ${divider("hoặc tiếp tục với")}
        ${socialBtns()}
      </div>
    </main>
  </div>`;
}

function registerView(){
  if(s.regOk){
    return `<div class="auth">
      ${leftPanel()}
      <main class="auth-right">
        ${cornerPets()}
        <div class="form fade" style="text-align:center">
          <div style="width:64px;height:64px;background:#0c0f1a;border-radius:50%;display:grid;place-items:center;margin:0 auto 1.5rem;color:#e8c97a;font-size:28px">✓</div>
          <h2>Đăng ký thành công!</h2>
          <p class="sub">Chào mừng bạn đến với <b>GameZone</b>. Hãy đăng nhập để bắt đầu.</p>
          <button class="primary" onclick="go('login')">Đăng nhập ngay</button>
        </div>
      </main>
    </div>`;
  }

  const usernameError = s.username && /\s/.test(s.username) ? "Tên tài khoản không được chứa khoảng trắng" : "";
  const passwordError = s.regPass && (
    /\s/.test(s.regPass) ? "Mật khẩu không được chứa khoảng trắng" :
    !(/[A-Za-z]/.test(s.regPass) && /\d/.test(s.regPass)) ? "Mật khẩu phải có cả chữ và số" : ""
  );
  const mismatch = s.confirm && s.confirm !== s.regPass;
  const disabled = !s.agree || mismatch || usernameError || passwordError || s.isLoading ? "disabled" : "";

  return `<div class="auth">
    ${leftPanel()}
    <main class="auth-right">
      ${cornerPets()}
      <div class="form fade">
        <h2>Đăng ký</h2>
        <p class="sub">Đã có tài khoản? <button class="link" onclick="go('login')">Đăng nhập</button></p>
        <form onsubmit="doRegister(event)">
          <div class="field">
            <label>Tên đăng nhập</label>
            <input class="input" required placeholder="Tối thiểu 8 ký tự, không khoảng trắng..."
              oninput="checkUsernameFormat(this.value)" value="${esc(s.username)}">
            <div id="usernameErrorContainer">${usernameError ? `<div class="mismatch">${esc(usernameError)}</div>` : ""}</div>
          </div>
          <div class="field">
            <label>Mật khẩu</label>
            ${pwField("regPass","Tối thiểu 8 ký tự, có cả chữ và số...",s.regPass,"showReg","updatePasswordStrength(this.value)")}
            <div id="strengthContainer">${strengthBar(s.regPass)}</div>
            <div id="passwordErrorContainer">${passwordError ? `<div class="mismatch">${esc(passwordError)}</div>` : ""}</div>
          </div>
          <div class="field">
            <label>Xác nhận mật khẩu</label>
            ${pwField("confirmPass","Nhập lại mật khẩu...",s.confirm,"showConfirm","checkPasswordMatch(this.value)")}
            <div id="mismatchContainer">${mismatch ? '<div class="mismatch">Mật khẩu không khớp</div>' : ''}</div>
          </div>
          <div class="checkrow" onclick="toggle('agree')">
            <div class="check${s.agree ? ' on' : ''}">${s.agree ? "✓" : ""}</div>
            <span style="font-size:12px;color:rgba(12,15,26,.6);line-height:1.5">
              Tôi đồng ý với <u>Điều khoản dịch vụ</u> và <u>Chính sách bảo mật</u>
            </span>
          </div>
          <div id="registerErrorBox"></div>
          <button id="btnRegister" class="primary" ${disabled}>${s.isLoading ? "Đang tạo..." : "Tạo tài khoản"}</button>
        </form>
        ${divider("hoặc đăng ký với")}
        ${socialBtns()}
      </div>
    </main>
  </div>`;
}

function nicknameView(){
  const n = s.nick;
  const len = n.trim().length;
  const btnStyle = len
    ? "background:#e8c97a;color:#0c0f1a;cursor:pointer"
    : "background:rgba(232,201,122,.2);color:rgba(232,201,122,.4);cursor:not-allowed";
  return `<div class="nickname">
    <div class="gridbg fixed-grid"></div>
    <div class="nick-card fade">
      ${logo(true)}
      <div class="card">
        <h2>Chọn bí danh<br>của bạn</h2>
        <p>Bí danh sẽ xuất hiện trên bảng xếp hạng và trong trận đấu. Chọn thật ngầu nhé.</p>
        <form onsubmit="doNick(event)">
          <div class="nick-input-wrap">
            <input class="nick-input" id="nickInput" autofocus maxlength="20"
              placeholder="Nhập bí danh..." value="${esc(n)}"
              oninput="s.nick=this.value;document.getElementById('cnt').textContent=this.value.trim().length+'/20'">
            <span class="counter" id="cnt">${len}/20</span>
          </div>
          <button class="btn-enter" style="${btnStyle}" ${len?"":"disabled"}>Vào game ngay →</button>
        </form>
      </div>
    </div>
  </div>`;
}



// ================== TRANG CHỦ (HỒ SƠ) ==================
function homeView(){
  const displayName = s.nick || s.username || "GameThủ";
  const ini = displayName.slice(0, 2).toUpperCase();
  const myTier = getRankTier(s.userHighScore);
  const allBadges = badgesFor(s.badges);
  const prog = badgeProgress(allBadges);
  const list = s.filter === "earned" ? allBadges.filter(a => a.earned) : allBadges;

  let lbRows = "";
  if (dbLeaderboard.length === 0) {
    lbRows = `<div style="padding:1.25rem;text-align:center;font-size:12px;color:rgba(248,247,244,.4)">Đang kết nối Bảng xếp hạng...</div>`;
  } else {
    lbRows = dbLeaderboard.map((item) => {
      const isTop = item.rank <= 3;
      const rankBadge = item.rank === 1 ? "👑" : item.rank === 2 ? "🥈" : item.rank === 3 ? "🥉" : item.rank;
      const isMe = !!item.is_me;
      const tier = getRankTier(item.score);
      return `<div class="lb-row${isTop ? " top" : ""}">
        <div class="rank">${rankBadge}</div>
        <button type="button" class="player lb-player-btn" onclick="openProfile('${esc(item.public_id)}')">
          <div class="player-avatar">${avatarHtml(item.avatar, item.username.slice(0,2).toUpperCase())}</div>
          <div>
            <div class="lb-player-name" style="font-size:13px;transition:.2s">${esc(item.username)}${isMe ? " (bạn)" : ""}</div>
            <div style="font-size:10px;color:rgba(248,247,244,.35)">ID: ${esc(item.public_id || "--------")}</div>
          </div>
        </button>
        <div class="score">
          ${Number(item.score).toLocaleString()}
          <div style="font-size:10px;color:${tier.color}">${tier.icon} ${tier.name}</div>
        </div>
      </div>`;
    }).join("");
  }

  const achCards = list.map(badgeCardHtml).join("");

  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <main class="content">
      <section class="profile">
        <div class="avatar-wrap">
          <div class="avatar-big">${avatarHtml(s.avatar, ini)}</div>
          <button class="avatar-edit-btn" type="button" onclick="triggerAvatarPicker()" title="Đổi ảnh đại diện">✏️</button>
          <input type="file" id="avatarFileInput" accept="image/*" style="display:none" onchange="onAvatarSelected(this)">
        </div>
        <div class="profile-info">
          <div class="eyebrow">Bí danh</div>
          <h2>${esc(displayName)} <button class="edit-nick-btn" onclick="go('nickname')" title="Sửa bí danh">✏️</button></h2>
          <div style="font-size:11px;color:rgba(248,247,244,.35)">ID: ${esc(s.userPublicId || "--------")}</div>
          <div class="profile-badges">
            <span class="badge badge-rank" style="color:${myTier.color};border-color:${myTier.color}66;background:${myTier.color}1a">${myTier.icon} ${myTier.name}</span>
            <span class="badge badge-score">
              🏆 Thành tích: <b>${Number(s.userHighScore || 0).toLocaleString()} điểm</b>
            </span>
          </div>
          <span style="font-size:11px;color:rgba(248,247,244,.4); display: block; margin-top: 6px;"> · Thành viên từ 2026</span>
        </div>
        <div class="profile-stats">
          <div><b>${s.userMatches}</b><small>Số trận đã chơi</small></div>
          <div><b>${s.userRank}</b><small>Xếp hạng hiện tại</small></div>
        </div>
      </section>

      <div class="columns">
        <section class="section">
          <div class="section-head">
            <div>
              <div class="section-title">Thành tích</div>
              <h3>Huy hiệu của bạn</h3>
            </div>
            <div class="filters">
              <button class="${s.filter === "all" ? "active" : ""}" onclick="setFilter('all')">Tất cả</button>
              <button class="${s.filter === "earned" ? "active" : ""}" onclick="setFilter('earned')">Đã đạt</button>
            </div>
          </div>
          <div class="achievements">${achCards || `<div class="quest-hint">Bạn chưa đạt huy hiệu nào — chơi thêm vài ván nhé!</div>`}</div>
          <div class="progress">
            <div class="progress-head"><span>Tiến độ hoàn thành</span><b style="color:#8b5cf6">${prog.earned}/${prog.total} huy hiệu · ${prog.pct}%</b></div>
            <div class="bar"><i style="width:${prog.pct}%"></i></div>
          </div>
        </section>

        <section class="section">
          <div class="section-title">Bảng xếp hạng</div>
          <h3>Top máy chủ</h3>
          <div class="leaderboard">
            <div class="lb-row lb-head">
              <div>#</div><div>Người chơi</div><div>Điểm</div>
            </div>
            ${lbRows}
            <div class="myrank">
              <span>Hạng của bạn hôm nay</span>
              <b>${s.userRank} · Trực tuyến</b>
            </div>
          </div>
        </section>
      </div>
    </main>
  </div>`;
}

// ===== Màn danh sách trò chơi =====
const GAMES = [
  { id:"tetris",      name:"Tetris",        desc:"Xếp hình kinh điển — leo rank, phá kỷ lục điểm cao.", icon:"🟦", tag:"ARCADE",      color:"#00d4ff", playable:true  },
  { id:"chess",       name:"Cờ Vua",        desc:"Cờ vua online 1vs1 qua mạng — tạo phòng và mời bạn bè vào đấu.", icon:"♟️", tag:"CHIẾN THUẬT", color:"#e8c97a", playable:true  },
  { id:"snake",       name:"Rắn săn mồi",   desc:"Điều khiển con rắn, ăn mồi và tránh va chạm.",         icon:"🐍", tag:"ARCADE",      color:"#22c55e", playable:true  },
  { id:"2048",        name:"2048",          desc:"Trượt các ô số, kết hợp để đạt ô 2048.",               icon:"🔢", tag:"PUZZLE",      color:"#f97316", playable:false },
  { id:"flappy",      name:"Flappy Bird",   desc:"Vượt qua ống nước — kiểm tra phản xạ của bạn.",        icon:"🐦", tag:"PHẢN XẠ",     color:"#eab308", playable:false },
  { id:"minesweeper", name:"Dò mìn",        desc:"Lật ô, đánh dấu mìn và sống sót đến cuối.",            icon:"💣", tag:"CHIẾN THUẬT", color:"#ef4444", playable:false },
  { id:"memory",      name:"Lật thẻ",       desc:"Ghi nhớ và ghép cặp thẻ giống nhau nhanh nhất.",       icon:"🎴", tag:"TRÍ NHỚ",     color:"#a855f7", playable:false },
];

function gameCard(g){
  const btn = g.playable
    ? `<button class="game-play-btn" style="background:${g.color};color:#0c0f1a" onclick="go('game','${g.id}')">CHƠI NGAY →</button>`
    : `<button class="game-play-btn locked" disabled>CHƠI NGAY</button>
       <div class="game-soon"><i></i>Sắp ra mắt</div>`;
  return `<div class="game-card${g.playable ? " playable" : ""}">
    <div class="game-card-top">
      <div class="game-icon" style="background:${g.color}22;color:${g.color}">${g.icon}</div>
      <span class="game-tag" style="color:${g.color};background:${g.color}1a;border-color:${g.color}55">${g.tag}</span>
    </div>
    <h3>${g.name}</h3>
    <p>${g.desc}</p>
    ${btn}
  </div>`;
}

function gamesView(){
  const displayName = s.nick || s.username || "GameThủ";
  const ini = displayName.slice(0, 2).toUpperCase();
  const tier = getRankTier(s.userHighScore);
  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <div class="games-body">
      <main class="content games-main-content">
        <div class="section-title">Danh sách trò chơi</div>
        <div class="games-grid">
          ${GAMES.map(gameCard).join("")}
        </div>
      </main>
      <aside class="game-sidebar" onclick="go('home')" style="cursor:pointer" title="Xem hồ sơ">
        <div class="avatar-big">${avatarHtml(s.avatar, ini)}</div>
        <div class="sidebar-nick">${esc(displayName)}</div>
        <span class="sidebar-rank" style="color:${tier.color};border:1px solid ${tier.color}66;background:${tier.color}1a">🏆 Top ${String(s.userRank).replace('#','')}</span>
      </aside>
    </div>
  </div>`;
}

function gameView(){
  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}

    <main class="content content-game">
      <div id="gameMount"></div>
    </main>
  </div>`;
}

// Xin server 1 "phiên chơi" mới (kèm mốc thời gian bắt đầu) trước khi vào ván đấu,
// để server có căn cứ kiểm tra điểm nộp lên sau này có hợp lý hay không.
async function startGameSession(){
  try {
    const game = s.selectedGame === "snake" ? "snake" : "tetris";   // phiên chơi gắn với loại game
    const res = await authFetch(`${API_URL}/start-game?game=${game}`, { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      s.gameSessionToken = data.session_token || "";
    }
  } catch (err) {
    console.error("Lỗi khởi tạo phiên chơi:", err);
  }
}

// Lưu điểm lên server rồi lấy hạng/kỷ lục mới nhất về.
// Trả về {rank, highScore, totalMatches} nếu thành công, hoặc null nếu có lỗi.
// KHÔNG tự chuyển trang ở đây — để game quyết định hiển thị gì sau khi có kết quả.
async function submitScore(finalScore){
  const gameType = s.selectedGame === "snake" ? "snake" : "tetris";
  if (!s.gameSessionToken) {
    alert("Không xác định được phiên chơi, điểm chưa được lưu. Vui lòng chơi lại ván mới.");
    return null;
  }
  try {
    const res = await authFetch(`${API_URL}/update-score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ score: finalScore, session_token: s.gameSessionToken, game_type: gameType })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert("Lỗi khi lưu điểm: " + (data.detail || "không rõ nguyên nhân"));
      return null;
    }
  } catch (err) {
    console.error("Lỗi kết nối khi lưu điểm:", err);
    alert("Không kết nối được tới Backend, điểm chưa được lưu!");
    return null;
  }

  try {
    const res = await authFetch(`${API_URL}/user-stats/${encodeURIComponent(s.username)}`);
    if (res.ok) {
      const data = await res.json();
      applyUserStats(data);
      s.gameSessionToken = "";
      // Rắn săn mồi hiển thị KỶ LỤC riêng của rắn; Tetris hiển thị tổng điểm xếp hạng.
      const best = gameType === "snake" ? (data.snake_score || 0) : (data.high_score || 0);
      return { rank: data.rank, highScore: best, totalMatches: data.total_matches };
    }
  } catch (err) {
    console.error("Lỗi lấy thông tin xếp hạng:", err);
  }
  return null;
}

let lastView = null; // theo dõi view trước đó để biết đây có phải chuyển màn thật sự không

function unmountGames(){
  if (typeof TetrisGame !== "undefined") TetrisGame.unmount();
  if (typeof SnakeGame !== "undefined") SnakeGame.unmount();
  if (typeof ChessGame !== "undefined") ChessGame.unmount();
}

function render(){
  const app = document.getElementById("app");
  unmountGames();

  // Chỉ phát animation "fade" khi THỰC SỰ chuyển sang view khác.
  // Nếu vẫn đang ở cùng 1 view (ví dụ chỉ bấm checkbox, đổi filter...),
  // tắt animation để tránh cả khối giao diện bị "giật/nhảy" mỗi lần bấm.
  const isNewView = (s.view !== lastView);
  lastView = s.view;
  app.classList.toggle("no-fade", !isNewView);

  if(s.view==="login")         app.innerHTML = loginView();
  else if(s.view==="register") app.innerHTML = registerView();
  else if(s.view==="nickname") app.innerHTML = nicknameView();
  else if(s.view==="games")    app.innerHTML = gamesView();
  else if(s.view==="quests")   app.innerHTML = questsView();
  else if(s.view==="history")  app.innerHTML = historyView();
  else if(s.view==="chibi")    app.innerHTML = chibiView();
  else if(s.view==="shop")     app.innerHTML = shopView();
  else if(s.view==="friends")  app.innerHTML = friendsView();
  else if(s.view==="messages"){
    app.innerHTML = messagesView();
    scrollChatToBottom();
  }
  else if(s.view==="game"){
    app.innerHTML = gameView();
    s.gameSessionToken = ""; // reset, token cũ (nếu có) đã dùng xong hoặc không còn hợp lệ
    const mountPoint = document.getElementById("gameMount");
    const gameOpts = {
      onFinish: submitScore,        // lưu điểm + lấy hạng, không tự chuyển trang
      onGoHome: () => go("home")    // chỉ chuyển trang khi người chơi bấm "Về trang chủ" / "Thoát"
    };
    if (mountPoint && s.selectedGame === "chess" && typeof ChessGame !== "undefined") {
      ChessGame.mount(mountPoint, Object.assign({}, gameOpts, {
        apiUrl: API_URL,
        playerName: s.nick || s.username || "Ẩn danh",
        playerAvatar: s.avatar || "",
        playerScore: s.userHighScore || 0,
        authToken: s.token || ""
      }));
    } else if (mountPoint && s.selectedGame === "snake" && typeof SnakeGame !== "undefined") {
      startGameSession();
      SnakeGame.mount(mountPoint, Object.assign({}, gameOpts, {
        onStart: startGameSession,      // chơi lại -> xin phiên chơi mới (token chỉ dùng được 1 lần)
        highScore: s.userSnakeScore || 0
      }));
    } else if (mountPoint && typeof TetrisGame !== "undefined") {
      startGameSession();
      TetrisGame.mount(mountPoint, gameOpts);
    }
  }
  else                         app.innerHTML = homeView();
}

function go(view, gameId){
  if(view==="login") s.regOk = false;
  if(gameId) s.selectedGame = gameId;
  s.view = view;
  s.notifOpen = false;
  s.notifNewIds = new Set();
  if(view === "home") {
    fetchLeaderboard();
    fetchUserStats();
  } else if (view === "quests")   fetchQuests();
  else if (view === "history")    fetchGameHistory();
  else if (view === "chibi" || view === "shop") fetchChibis();
  else if (view === "friends")    fetchFriends();
  else if (view === "messages")   { fetchConversations(); }
  render();
  saveSession();
}

function toggle(key){ s[key] = !s[key]; render(); }

// ================== ĐĂNG NHẬP / ĐĂNG KÝ / BÍ DANH / ẢNH ĐẠI DIỆN ==================
async function doLogin(e){
  e.preventDefault();
  const username = s.username.trim();
  const password = s.loginPass;

  if(!username || !password) return;

  if (username.length < 8 || password.length < 8) {
    showFieldError("loginErrorBox", "Tài khoản và mật khẩu phải có ít nhất 8 ký tự");
    return;
  }
  showFieldError("loginErrorBox", "");

  s.isLoading = true;
  render();

  try {
    const res = await fetch(`${API_URL}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok) {
      s.username = data.username || username;
      s.avatar = data.avatar || "";
      s.token = data.token || "";
      s.activeChibiCodes = new Set(data.active_chibi_codes || []);
      afterLogin();
      if (data.nickname && data.nickname.trim() !== "") {
        s.nick = data.nickname;
        s.view = "games";
        saveSession();
      } else {
        s.nick = username;
        s.view = "nickname";
        saveSession();
      }
    } else {
      alert("Đăng nhập thất bại: " + (data.detail || "Sai tên đăng nhập hoặc mật khẩu"));
    }
  } catch (err) {
    alert("Không kết nối được tới máy chủ Backend!");
  } finally {
    s.isLoading = false;
    render();
  }
}

async function doRegister(e){
  e.preventDefault();
  const username = s.username.trim();
  const password = s.regPass;

  if(!username || !password) return;

  if (/\s/.test(username) || username.length < 8) {
    showFieldError("registerErrorBox", "Tài khoản không được chứa khoảng trắng và phải có ít nhất 8 ký tự");
    return;
  }
  if (/\s/.test(password) || password.length < 8) {
    showFieldError("registerErrorBox", "Mật khẩu không được chứa khoảng trắng và phải có ít nhất 8 ký tự");
    return;
  }
  if (!(/[A-Za-z]/.test(password) && /\d/.test(password))) {
    showFieldError("registerErrorBox", "Mật khẩu phải có cả chữ và số");
    return;
  }
  showFieldError("registerErrorBox", "");

  s.isLoading = true;
  render();

  try {
    const res = await fetch(`${API_URL}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok) {
      s.regOk = true;
    } else {
      alert("Đăng ký thất bại: " + (data.detail || "Tên tài khoản đã tồn tại"));
    }
  } catch (err) {
    alert("Không kết nối được tới máy chủ Backend!");
  } finally {
    s.isLoading = false;
    render();
  }
}

async function doNick(e){
  e.preventDefault();
  const chosenNick = s.nick.trim() || s.username || "GameThủ";

  try {
    await authFetch(`${API_URL}/update-nickname`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: chosenNick })
    });
  } catch (err) {
    console.error("Lỗi cập nhật bí danh:", err);
  }

  s.nick = chosenNick;
  s.view = "games";
  saveSession();
  fetchLeaderboard();
  fetchUserStats();
  render();
}

// Nén & resize ảnh về tối đa 300x300 (giữ tỉ lệ) trước khi gửi lên server,
// tránh lưu ảnh gốc quá nặng vào CSDL.
function resizeImageToDataUrl(file, maxSize = 300, quality = 0.85){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) {
          height = Math.round(height * (maxSize / width));
          width = maxSize;
        } else if (height > maxSize) {
          width = Math.round(width * (maxSize / height));
          height = maxSize;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("Ảnh không hợp lệ"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Không đọc được file"));
    reader.readAsDataURL(file);
  });
}

function triggerAvatarPicker(){
  const input = document.getElementById("avatarFileInput");
  if (input) input.click();
}

async function onAvatarSelected(inputEl){
  const file = inputEl.files && inputEl.files[0];
  inputEl.value = ""; // cho phép chọn lại cùng 1 file lần sau
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    alert("Vui lòng chọn một file ảnh");
    return;
  }

  try {
    const dataUrl = await resizeImageToDataUrl(file);
    s.avatar = dataUrl;
    saveSession();
    render();

    const res = await authFetch(`${API_URL}/update-avatar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar: dataUrl })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert("Lỗi khi lưu ảnh đại diện: " + (data.detail || "không rõ nguyên nhân"));
    }
  } catch (err) {
    console.error("Lỗi cập nhật ảnh đại diện:", err);
    alert("Không cập nhật được ảnh đại diện!");
  }
}

function pickNick(name){
  s.nick = name;
  render();
}

function setFilter(f){
  s.filter = f;
  render();
}


// ================== THANH MENU ==================
// Thanh menu dùng chung cho mọi trang sau đăng nhập, có ô tìm kiếm, vàng và chuông thông báo.
function navBadgeHtml(n){
  return n > 0 ? `<span class="nav-badge">${n > 99 ? "99+" : n}</span>` : "";
}

function navLinksHtml(){
  const gamesActive = (s.view === "game" || s.view === "games");
  const claimable = s.quests.filter(q => q.done && !q.claimed).length;
  const incoming = s.friendsIncoming.length;
  const unreadMsgs = s.conversations.reduce((sum, c) => sum + (Number(c.unread_count) || 0), 0);
  const link = (view, label, active, badge) =>
    `<span class="${active ? "active" : ""}" onclick="go('${view}')" style="cursor:pointer">${label}${navBadgeHtml(badge || 0)}</span>`;
  return link("home", "Hồ sơ", s.view === "home")
    + link("games", "Chơi ngay", gamesActive)
    + link("quests", "Nhiệm vụ", s.view === "quests", claimable)
    + link("history", "Lịch sử", s.view === "history")
    + link("chibi", "Chibi", s.view === "chibi")
    + link("shop", "Cửa hàng", s.view === "shop")
    + link("friends", "Bạn bè", s.view === "friends", incoming)
    + link("messages", "Tin nhắn", s.view === "messages", unreadMsgs);
}

function navBar(){
  const displayName = s.nick || s.username || "GameThủ";
  const ini = displayName.slice(0, 2).toUpperCase();
  return `<nav class="navbar">
      ${logo()}
      <div class="navlinks" id="navLinks">${navLinksHtml()}</div>
      ${searchBox()}
      <div class="navuser">
        <button type="button" class="nav-gold" id="navGold" onclick="go('shop')" title="Vàng của bạn — bấm để vào cửa hàng">🪙 ${Number(s.gold || 0).toLocaleString("vi-VN")}</button>
        ${notifBellHtml()}
        <div class="navuser-profile" onclick="go('home')" style="display:flex;align-items:center;gap:.5rem;cursor:pointer" title="Xem hồ sơ">
          <div class="avatar">${avatarHtml(s.avatar, ini)}</div>
          <span style="font-size:14.5px;font-weight:500">${esc(displayName)}</span>
        </div>
        <button class="logout" onclick="logout()">Đăng xuất</button>
      </div>
    </nav>`;
}

// Cập nhật số vàng + chấm đỏ trên menu mà KHÔNG gọi render() (render sẽ làm game đang chơi bị khởi động lại).
function refreshNavCounters(){
  const links = document.getElementById("navLinks");
  if (links) links.innerHTML = navLinksHtml();
  const gold = document.getElementById("navGold");
  if (gold) gold.textContent = `🪙 ${Number(s.gold || 0).toLocaleString("vi-VN")}`;
}

// ================== TÌM KIẾM NGƯỜI CHƠI (thanh menu) ==================
function searchBox(){
  return `<div class="nav-search" id="navSearch">
    <svg class="nav-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="11" cy="11" r="8"></circle>
      <path d="m21 21-4.35-4.35"></path>
    </svg>
    <input type="text" id="navSearchInput" class="nav-search-input" placeholder="Tìm theo tên hoặc ID..."
      value="${esc(s.searchQuery)}"
      oninput="onSearchInput(this.value)"
      onfocus="onSearchFocus()"
      onblur="onSearchBlur()"
      autocomplete="off">
    ${s.searchQuery ? `<button type="button" class="nav-search-clear" onmousedown="clearSearch()">✕</button>` : ""}
    <div class="nav-search-dropdown" id="navSearchDropdown" style="display:none"></div>
  </div>`;
}

let searchDebounceTimer = null;

function clearSearch(){
  s.searchQuery = "";
  const input = document.getElementById("navSearchInput");
  if (input) input.value = "";
  const box = document.getElementById("navSearch");
  const clearBtn = box && box.querySelector(".nav-search-clear");
  if (clearBtn) clearBtn.remove();
  const dropdown = document.getElementById("navSearchDropdown");
  if (dropdown) { dropdown.style.display = "none"; dropdown.innerHTML = ""; }
  if (input) input.focus();
}

// Gõ tới đâu tự tìm tới đó (có debounce), không render lại cả trang để không mất focus ô nhập.
function onSearchInput(val){
  s.searchQuery = val;

  const box = document.getElementById("navSearch");
  const dropdown = document.getElementById("navSearchDropdown");
  if (box && dropdown) {
    let clearBtn = box.querySelector(".nav-search-clear");
    if (val && !clearBtn) {
      clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "nav-search-clear";
      clearBtn.textContent = "✕";
      clearBtn.onmousedown = clearSearch;
      box.insertBefore(clearBtn, dropdown);
    } else if (!val && clearBtn) {
      clearBtn.remove();
    }
  }

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  const query = val.trim();
  if (!query) {
    if (dropdown) { dropdown.style.display = "none"; dropdown.innerHTML = ""; }
    return;
  }
  if (dropdown) {
    dropdown.style.display = "block";
    dropdown.innerHTML = `<div class="nav-search-empty"><span class="nav-search-spin">◌</span> Đang tìm...</div>`;
  }
  searchDebounceTimer = setTimeout(() => doSearch(query), 300);
}

function onSearchFocus(){
  const dropdown = document.getElementById("navSearchDropdown");
  if (dropdown && dropdown.innerHTML.trim() && s.searchQuery.trim()) {
    dropdown.style.display = "block";
  }
}

function onSearchBlur(){
  // Trễ 1 chút để onmousedown trên kết quả kịp chạy trước khi dropdown bị ẩn.
  setTimeout(() => {
    const dropdown = document.getElementById("navSearchDropdown");
    if (dropdown) dropdown.style.display = "none";
  }, 150);
}

async function doSearch(query){
  const dropdown = document.getElementById("navSearchDropdown");
  try {
    const res = await fetch(`${API_URL}/search-users?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error("Tìm kiếm thất bại");
    const results = await res.json();
    if (dropdown) dropdown.innerHTML = searchResultsHtml(results);
  } catch (err) {
    console.error("Lỗi tìm kiếm người chơi:", err);
    if (dropdown) dropdown.innerHTML = `<div class="nav-search-empty"><span class="nav-search-empty-icon">⚠️</span>Không thể tìm kiếm lúc này</div>`;
  }
}

// Bôi vàng phần tên trùng khớp với từ khóa đang gõ (giống ô tìm kiếm anh hùng).
function highlightMatch(text, query){
  const q = (query || "").trim();
  if (!q) return esc(text);
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx === -1) return esc(text);
  return esc(text.slice(0, idx)) + `<mark>${esc(text.slice(idx, idx + q.length))}</mark>` + esc(text.slice(idx + q.length));
}

function searchResultsHtml(results){
  if (!results || results.length === 0) {
    return `<div class="nav-search-empty">
      <span class="nav-search-empty-icon">🌌</span>
      Không tìm thấy người chơi nào
    </div>`;
  }
  const q = s.searchQuery;
  const items = results.map((r) => {
    const tier = getRankTier(r.high_score);
    const name = r.display_name || "Ẩn danh";
    return `<button type="button" class="nav-search-item" onmousedown="openProfile('${esc(r.public_id)}')">
      <div class="nav-search-avatar" style="background:linear-gradient(135deg, ${tier.color}40, ${tier.color}15);border-color:${tier.color}45;color:${tier.color}">${avatarHtml(r.avatar, name.slice(0,2).toUpperCase())}</div>
      <div class="nav-search-item-info">
        <div class="nav-search-item-name">${highlightMatch(name, q)}</div>
        <div class="nav-search-item-id">ID: ${highlightMatch(r.public_id || "--------", q)}</div>
      </div>
      <div class="nav-search-item-tier" style="background:${tier.color}18;border-color:${tier.color}38;color:${tier.color}">
        <span>${tier.icon}</span><span class="nav-search-item-tier-label">${esc(tier.name)}</span>
      </div>
    </button>`;
  }).join("");
  return items + `<div class="nav-search-count">${results.length} kết quả</div>`;
}

// ================== HỒ SƠ NGƯỜI CHƠI KHÁC (modal) ==================
// Modal được gắn thẳng vào <body> (giống portal) để hiện được ở bất kỳ trang nào,
// không phụ thuộc vào render() của #app.
function ensureProfileModalRoot(){
  let el = document.getElementById("profileModalRoot");
  if (!el) {
    el = document.createElement("div");
    el.id = "profileModalRoot";
    document.body.appendChild(el);
  }
  return el;
}

function onProfileModalKeydown(e){
  if (e.key === "Escape") closeProfileModal();
}

function closeProfileModal(){
  const el = document.getElementById("profileModalRoot");
  if (el) el.innerHTML = "";
  document.body.style.overflow = "";
  document.removeEventListener("keydown", onProfileModalKeydown);
}

async function openProfile(publicId, quiet){
  const dropdown = document.getElementById("navSearchDropdown");
  if (dropdown) dropdown.style.display = "none";
  const searchInput = document.getElementById("navSearchInput");
  if (searchInput) searchInput.blur();

  const root = ensureProfileModalRoot();
  if (!quiet) root.innerHTML = profileModalHtml({ loading: true });
  document.body.style.overflow = "hidden";
  document.removeEventListener("keydown", onProfileModalKeydown);
  document.addEventListener("keydown", onProfileModalKeydown);

  try {
    const headers = s.token ? { "Authorization": `Bearer ${s.token}` } : {};
    const res = await fetch(`${API_URL}/profile/${encodeURIComponent(publicId)}`, { headers });
    if (!res.ok) throw new Error("Không tìm thấy hồ sơ");
    const data = await res.json();
    root.innerHTML = profileModalHtml({ data });
  } catch (err) {
    console.error("Lỗi tải hồ sơ người chơi:", err);
    root.innerHTML = profileModalHtml({ error: true });
  }
}

// Nút kết bạn / nhắn tin trong hồ sơ, tuỳ theo quan hệ hiện tại.
function profileFriendActionHtml(data){
  const st = data.friend_status;
  if (!s.token || !st || st === "self") return "";
  const id = esc(data.public_id);
  if (st === "friends") {
    return `<div class="profile-friend-action">
      <span class="friend-btn friend-btn-friends">✓ Bạn bè</span>
      <button type="button" class="friend-btn friend-btn-chat" onclick="closeProfileModal();openChat('${id}')">💬 Nhắn tin</button>
      <button type="button" class="friend-btn friend-btn-remove" onclick="friendAction('remove','${id}')">Hủy kết bạn</button>
    </div>`;
  }
  if (st === "pending_sent") {
    return `<div class="profile-friend-action">
      <span class="friend-btn friend-btn-pending">Đã gửi lời mời</span>
      <button type="button" class="friend-btn friend-btn-cancel" onclick="friendAction('remove','${id}')">Hủy lời mời</button>
    </div>`;
  }
  if (st === "pending_received") {
    return `<div class="profile-friend-action">
      <button type="button" class="friend-btn friend-btn-accept" onclick="friendAction('accept','${id}')">Chấp nhận</button>
      <button type="button" class="friend-btn friend-btn-decline" onclick="friendAction('decline','${id}')">Từ chối</button>
    </div>`;
  }
  return `<div class="profile-friend-action">
    <button type="button" class="friend-btn friend-btn-add" onclick="friendAction('send','${id}')">+ Kết bạn</button>
  </div>`;
}

function profileModalHtml({ loading, error, data } = {}){
  let body;

  if (loading) {
    body = `<div class="profile-modal-status">Đang tải hồ sơ...</div>`;
  } else if (error || !data) {
    body = `<div class="profile-modal-status">Không tìm thấy người chơi này 😢</div>`;
  } else {
    const name = data.display_name || "Ẩn danh";
    const ini = name.slice(0, 2).toUpperCase();
    const tier = getRankTier(data.high_score);
    const achCards = badgesFor(data.badges).map(badgeCardHtml).join("");

    body = `
      <section class="profile profile-modal-section">
        <div class="avatar-wrap">
          <div class="avatar-big">${avatarHtml(data.avatar, ini)}</div>
        </div>
        <div class="profile-info">
          <div class="eyebrow">Hồ sơ người chơi</div>
          <h2>${esc(name)}</h2>
          <div style="font-size:11px;color:rgba(248,247,244,.35)">ID: ${esc(data.public_id || "--------")}</div>
          <div class="profile-badges">
            <span class="badge badge-rank" style="color:${tier.color};border-color:${tier.color}66;background:${tier.color}1a">${tier.icon} ${tier.name}</span>
            <span class="badge badge-score">🏆 Thành tích: <b>${Number(data.high_score || 0).toLocaleString()} điểm</b></span>
          </div>
          <span style="font-size:11px;color:rgba(248,247,244,.4);display:block;margin-top:6px"> · Thành viên từ 2026</span>
          ${profileFriendActionHtml(data)}
        </div>
        <div class="profile-stats">
          <div><b>${data.total_matches ?? 0}</b><small>Số trận đã chơi</small></div>
          <div><b>${data.rank || "#-"}</b><small>Xếp hạng hiện tại</small></div>
        </div>
      </section>
      <div class="profile-modal-achievements">
        <div class="section-title">Thành tích</div>
        <h3>Huy hiệu</h3>
        <div class="achievements">${achCards}</div>
      </div>`;
  }

  return `<div class="profile-modal-backdrop" onmousedown="if(event.target===this) closeProfileModal()">
    <div class="profile-modal fade">
      <button type="button" class="profile-modal-close" onclick="closeProfileModal()">✕</button>
      ${body}
    </div>
  </div>`;
}

// ================== NHIỆM VỤ ==================
// Nhiệm vụ do server tự ghi nhận khi đủ điều kiện; người chơi bấm "Nhận" để lấy vàng (mỗi nhiệm vụ 1 lần).
async function fetchQuests(){
  if (!s.token) return;
  try {
    const res = await authFetch(`${API_URL}/quests`);
    if (!res.ok) return;
    const data = await res.json();
    s.quests = data.quests || [];
    s.gold = Number(data.gold) || 0;
    s.questsLoaded = true;
    if (s.view === "quests") render(); else refreshNavCounters();
  } catch (err) {
    console.error("Lỗi lấy danh sách nhiệm vụ:", err);
  }
}

// Nhận vàng 1 nhiệm vụ. Trả về true nếu thành công.
async function claimOneQuest(id){
  try {
    const res = await authFetch(`${API_URL}/quests/${encodeURIComponent(id)}/claim`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.detail || "Không thể nhận vàng");
      return false;
    }
    if (data.gold !== undefined) s.gold = Number(data.gold) || 0;
    const q = s.quests.find(x => x.id === id);
    if (q) q.claimed = true;
    return true;
  } catch (err) {
    console.error("Lỗi nhận vàng nhiệm vụ:", err);
    alert("Không kết nối được tới máy chủ Backend!");
    return false;
  }
}

async function claimQuest(id){
  if (s.claimingQuest) return;   // chặn bấm đúp
  s.claimingQuest = true;
  try { await claimOneQuest(Number(id)); }
  finally { s.claimingQuest = false; }
  await fetchQuests();           // tải lại danh sách + số vàng trên thanh menu
  if (s.view === "quests") render();
}

// Backend chưa có API nhận cả loạt, nên nhận lần lượt từng nhiệm vụ đã hoàn thành.
async function claimAllQuests(){
  if (s.claimingQuest) return;
  s.claimingQuest = true;
  try {
    for (const q of s.quests.filter(x => x.done && !x.claimed)) {
      if (!(await claimOneQuest(q.id))) break;
    }
  } finally { s.claimingQuest = false; }
  await fetchQuests();
  if (s.view === "quests") render();
}

function questActionHtml(q){
  const reward = Number(q.reward_gold) || 0;
  if (!q.done) {
    return `<span class="quest-reward">🪙 ${reward}</span><span class="quest-status quest-status-pending">Chưa hoàn thành</span>`;
  }
  if (q.claimed) {
    return `<span class="quest-status quest-claimed">✓ Đã nhận 🪙 ${reward}</span>`;
  }
  return `<button type="button" class="quest-claim-btn" onclick="claimQuest(${Number(q.id)})">Nhận 🪙 ${reward}</button>`;
}

function questsView(){
  const total = s.quests.length;
  const done = s.quests.filter(q => q.done).length;
  const claimable = s.quests.filter(q => q.done && !q.claimed);
  const claimableGold = claimable.reduce((sum, q) => sum + (Number(q.reward_gold) || 0), 0);
  const pct = total ? Math.round(done * 100 / total) : 0;

  const rowsHtml = s.quests.map((q, i) => `<div class="quest-row${q.done ? " done" : ""}${q.done && !q.claimed ? " claimable" : ""}">
      <div class="quest-index">${q.done ? "✓" : i + 1}</div>
      <div class="quest-info">
        <div class="quest-title">${esc(q.title)}</div>
        <div class="quest-desc">${esc(q.description)}</div>
      </div>
      <div class="quest-actions">${questActionHtml(q)}</div>
    </div>`).join("");

  const claimAllHtml = claimable.length
    ? `<button type="button" class="quest-claim-btn" style="margin:.4rem 0 1rem" onclick="claimAllQuests()">🎁 Nhận tất cả (+🪙 ${claimableGold})</button>`
    : "";

  const emptyHtml = `<div class="nav-search-empty" style="padding:2rem 1rem">
    <span class="nav-search-empty-icon">${s.questsLoaded ? "📭" : "⏳"}</span>${s.questsLoaded ? "Chưa có nhiệm vụ nào" : "Đang tải nhiệm vụ..."}
  </div>`;

  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <main class="content">
      <section class="section">
        <div class="section-title">Nhiệm vụ</div>
        <h3>Hoàn thành nhiệm vụ (${done}/${total})</h3>
        <div class="quest-hint">Nhiệm vụ được hệ thống tự ghi nhận khi bạn hoàn thành. Mỗi nhiệm vụ nhận được <b>🪙 10 vàng</b> — bấm <b>Nhận</b> để lấy.${claimable.length ? ` Bạn có <b>${claimable.length}</b> phần thưởng chưa nhận!` : ""}</div>
        ${claimAllHtml}
        <div class="quest-progress"><div class="quest-progress-bar" style="width:${pct}%"></div></div>
        <div class="leaderboard quest-list">${rowsHtml || emptyHtml}</div>
      </section>
    </main>
  </div>`;
}

// ================== LỊCH SỬ CHƠI ==================
async function fetchGameHistory(){
  if (!s.token) return;
  try {
    const res = await authFetch(`${API_URL}/game-history?limit=100`);
    if (!res.ok) return;
    const data = await res.json();
    s.gameHistory = data.history || [];
    s.gameHistorySummary = data.summary || null;
    s.gameHistoryLoaded = true;
    if (s.view === "history") render();
  } catch (err) {
    console.error("Lỗi lấy lịch sử chơi:", err);
  }
}

function setHistoryFilter(f){
  s.historyFilter = f;
  render();
}

function formatPlayDuration(sec){
  sec = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(sec / 60), r = sec % 60;
  return m > 0 ? `${m} phút ${r} giây` : `${r} giây`;
}

// "Hôm nay, 14:05" / "Hôm qua, 09:30" / "29/10/2026, 20:15"
function formatChatTime(iso){
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const hm = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const now = new Date();
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `Hôm nay, ${hm}`;
  if (d.toDateString() === yest.toDateString()) return `Hôm qua, ${hm}`;
  return `${d.toLocaleDateString("vi-VN")}, ${hm}`;
}

function historyRowHtml(h){
  const when = formatChatTime(h.played_at);

  if (h.game_type === "chess") {
    const resText = { win: "Thắng", loss: "Thua", draw: "Hòa" }[h.result] || "—";
    const delta = Number(h.score_delta) || 0;
    const badgeCls = delta > 0 ? "win" : (delta < 0 ? "loss" : "draw");
    const badgeText = delta > 0 ? `+${delta}` : (delta < 0 ? `${delta}` : "Hòa");
    const opp = h.opponent_name ? ` · đấu với ${esc(h.opponent_name)}` : "";
    const room = h.room_code ? ` · phòng ${esc(h.room_code)}` : "";
    return `<div class="quest-row history-row">
      <div class="quest-index history-icon">♟</div>
      <div class="quest-info">
        <div class="quest-title">Cờ vua — ${resText}</div>
        <div class="quest-desc">${esc(when)}${opp}${room}</div>
      </div>
      <span class="history-badge ${badgeCls}">${badgeText}</span>
    </div>`;
  }

  const score = Number(h.score) || 0;
  const dur = (h.duration_seconds !== null && h.duration_seconds !== undefined)
    ? ` · ${formatPlayDuration(h.duration_seconds)}` : "";
  const isSnake = h.game_type === "snake";
  return `<div class="quest-row history-row">
    <div class="quest-index history-icon">${isSnake ? "🐍" : "🧱"}</div>
    <div class="quest-info">
      <div class="quest-title">${isSnake ? "Rắn săn mồi" : "Tetris"}</div>
      <div class="quest-desc">${esc(when)}${dur}</div>
    </div>
    <span class="history-badge score">${score.toLocaleString("vi-VN")} điểm</span>
  </div>`;
}

function historyView(){
  const filters = [
    { key: "all",    label: "Tất cả" },
    { key: "tetris", label: "🧱 Tetris" },
    { key: "snake",  label: "🐍 Rắn săn mồi" },
    { key: "chess",  label: "♟ Cờ vua" },
  ];
  const list = s.gameHistory.filter(h => s.historyFilter === "all" || h.game_type === s.historyFilter);
  const sm = s.gameHistorySummary;

  const fmt = (v) => (Number(v) || 0).toLocaleString("vi-VN");
  const gameCardHtml = (cls, icon, name, recordLabel, record, games, footer) => `
      <div class="history-game ${cls}">
        <div class="history-game-head"><span class="history-game-icon">${icon}</span><span class="history-game-name">${name}</span></div>
        <div class="history-game-stats">
          <div class="history-game-stat"><div class="history-game-num">${record}</div><div class="history-game-label">${recordLabel}</div></div>
          <div class="history-game-stat"><div class="history-game-num">${games}</div><div class="history-game-label">Số trận đã chơi</div></div>
        </div>${footer ? `<div class="history-game-foot">${footer}</div>` : ""}
      </div>`;

  const statsHtml = sm ? `<div class="history-summary">
      ${gameCardHtml("hg-tetris", "🧱", "Tetris", "Kỷ lục", fmt(sm.tetris_best), fmt(sm.tetris_games))}
      ${gameCardHtml("hg-snake", "🐍", "Rắn săn mồi", "Kỷ lục", fmt(sm.snake_best), fmt(sm.snake_games))}
      ${gameCardHtml("hg-chess", "♟", "Cờ vua", "Số trận thắng", fmt(sm.chess_wins), fmt(sm.chess_games),
        `Thua <b>${fmt(sm.chess_losses)}</b> · Hòa <b>${fmt(sm.chess_draws)}</b>`)}
    </div>` : "";

  const emptyHtml = `<div class="nav-search-empty" style="padding:2rem 1rem">
    <span class="nav-search-empty-icon">${s.gameHistoryLoaded ? "📭" : "⏳"}</span>${s.gameHistoryLoaded ? "Chưa có ván chơi nào" : "Đang tải lịch sử..."}
  </div>`;

  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <main class="content">
      <section class="section">
        <div class="section-title">Lịch sử</div>
        <h3>Lịch sử chơi game</h3>
        <div class="quest-hint">Hiển thị tối đa 100 ván gần nhất, ván mới nhất ở trên cùng.</div>
        ${statsHtml}
        <div class="chibi-filters">
          ${filters.map(f => `<button type="button" class="chibi-filter-btn${s.historyFilter === f.key ? " active" : ""}" onclick="setHistoryFilter('${f.key}')">${f.label}</button>`).join("")}
        </div>
        <div class="leaderboard quest-list">${list.map(historyRowHtml).join("") || emptyHtml}</div>
      </section>
    </main>
  </div>`;
}


// ================== CHIBI ==================
// Chibi chạy ngang đáy màn hình (chibi-runner.js). Server lưu chibi nào đã mở khoá và chibi nào đang bật;
// phần giao diện dưới đây chỉ cần biết chibi nào có ảnh/khung hình đặc biệt.
const pad3 = (i) => String(i).padStart(3, "0");
const CHIBI_VIEW = {
  // code: { frameFileName, config, emoji }
  "1": {
    emoji: "🐱",
    config: {
      fall: { dir: "nga", start: 7, end: 23, frameFileName: (i) => `frame_${pad3(i)}.png`, holdMs: 800 },
    },
  },
  "2": {
    emoji: "🐰",
    frameFileName: (i) => `frame_${pad3(i)}.png`,
  },
};

function chibiEntry(code){
  const meta = s.chibis.find(c => c.code === code);
  const view = CHIBI_VIEW[code] || {};
  return {
    code,
    frameCount: meta ? Number(meta.frame_count) || 10 : 10,
    frameFileName: view.frameFileName,
    config: view.config,
  };
}

// Đồng bộ chibi đang chạy trên màn hình theo dữ liệu thật từ server.
function applyChibiRunnerState(){
  if (!window.ChibiRunner) return;
  if (!s.token) { window.ChibiRunner.stop(); return; }
  window.ChibiRunner.sync(Array.from(s.activeChibiCodes).map(chibiEntry));
}

async function fetchChibis(){
  if (!s.token) return;
  try {
    const res = await authFetch(`${API_URL}/chibis`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      s.chibisError = `Lỗi ${res.status}: ${err.detail || "máy chủ không phản hồi đúng"}`;
      console.error("Lỗi /chibis:", s.chibisError);
      if (s.view === "shop" || s.view === "chibi") render();
      return;
    }
    s.chibisError = null;
    const data = await res.json();
    s.chibis = data.chibis || [];
    s.unlockedChibiCodes = new Set(s.chibis.filter(c => c.unlocked).map(c => c.code));
    s.chibiPrices = {};
    s.chibis.forEach(c => { s.chibiPrices[c.code] = Number(c.price) || 0; });
    if (data.gold !== undefined) s.gold = Number(data.gold) || 0;
    s.chibisLoaded = true;
    applyChibiRunnerState();   // đã biết số khung hình thật của từng chibi
    if (s.view === "chibi" || s.view === "shop") render(); else refreshNavCounters();
  } catch (err) {
    console.error("Lỗi lấy danh sách chibi:", err);
    s.chibisError = "Không kết nối được máy chủ (kiểm tra API_URL trong config.js)";
    if (s.view === "shop" || s.view === "chibi") render();
  }
}

function setChibiFilter(f){ s.chibiFilter = f; render(); }

async function setChibiActive(code, active){
  try {
    const res = await authFetch(`${API_URL}/set-active-chibi`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chibi_code: code, active })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.detail || "Không đổi được trạng thái chibi"); return; }
    s.activeChibiCodes = new Set(data.active_chibi_codes || []);
    applyChibiRunnerState();
    if (s.view === "chibi") render();
  } catch (err) {
    console.error("Lỗi bật/tắt chibi:", err);
    alert("Không kết nối được tới máy chủ Backend!");
  }
}

function chibiPortrait(c){
  return `chibi/${encodeURIComponent(c.code)}/chinhdien.png`;
}

function chibiAvatarHtml(c, locked){
  const emoji = (CHIBI_VIEW[c.code] && CHIBI_VIEW[c.code].emoji) || "🐾";
  return `<div class="chibi-card-avatar${locked ? " locked-avatar" : ""}">
      <img src="${chibiPortrait(c)}" alt="${esc(c.name)}" class="${locked ? "locked-img" : ""}"
           onerror="this.replaceWith(document.createTextNode('${emoji}'))">
    </div>`;
}

function chibiCardHtml(c){
  const owned = !!c.unlocked;
  const running = s.activeChibiCodes.has(c.code);
  const pill = c.is_default ? "Mặc định" : (owned ? "Đã sở hữu" : `🪙 ${Number(c.price) || 0}`);
  let btn;
  if (!owned) {
    const buyable = Number(c.price) > 0;
    btn = buyable
      ? `<button type="button" class="chibi-use-btn" onclick="go('shop')">🔒 Mua ở cửa hàng</button>`
      : `<button type="button" class="chibi-use-btn" disabled>🔒 Chưa mở khoá</button>`;
  } else if (running) {
    btn = `<button type="button" class="chibi-use-btn active" onclick="setChibiActive('${esc(c.code)}', false)">Đi ngủ đi</button>`;
  } else {
    btn = `<button type="button" class="chibi-use-btn" onclick="setChibiActive('${esc(c.code)}', true)">Sử dụng</button>`;
  }
  return `<div class="chibi-card${owned ? "" : " locked"}">
    <div class="chibi-card-top">
      <span class="chibi-badge-rarity" style="color:${owned ? "#8b5cf6" : "rgba(248,247,244,.4)"}">${owned ? (running ? "ĐANG CHẠY" : "SỞ HỮU") : "KHOÁ"}</span>
    </div>
    <div class="chibi-card-avatar-wrap">
      ${chibiAvatarHtml(c, false)}
      ${owned ? "" : `<span class="chibi-lock-badge">🔒</span>`}
    </div>
    <div class="chibi-card-name">${esc(c.name)}</div>
    <div class="chibi-card-bottom"><span class="chibi-elem-pill" style="color:#e8c97a;border-color:#e8c97a55">${pill}</span></div>
    ${btn}
  </div>`;
}

function chibiView(){
  const filters = [
    { key: "all",    label: "Tất cả" },
    { key: "owned",  label: "Đã sở hữu" },
    { key: "locked", label: "Chưa mở khoá" },
  ];
  const list = s.chibis.filter(c =>
    s.chibiFilter === "all" || (s.chibiFilter === "owned" ? c.unlocked : !c.unlocked));
  let body;
  if (s.chibisError) body = `<div class="quest-hint">⚠️ Không tải được chibi. ${esc(s.chibisError)}</div>`;
  else if (!s.chibisLoaded) body = `<div class="quest-hint">Đang tải chibi...</div>`;
  else if (!list.length) body = `<div class="quest-hint">Không có chibi nào trong mục này.</div>`;
  else body = `<div class="chibi-grid">${list.map(chibiCardHtml).join("")}</div>`;

  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <main class="content">
      <section class="section">
        <div class="section-title">Bộ sưu tập</div>
        <h3>Chibi của bạn (${s.unlockedChibiCodes.size}/${s.chibis.length})</h3>
        <div class="quest-hint">Bấm <b>Sử dụng</b> để chibi chạy trên màn hình, <b>Đi ngủ đi</b> để cho nó nghỉ. Có thể bật nhiều chibi cùng lúc.</div>
        <div class="chibi-filters">
          ${filters.map(f => `<button type="button" class="chibi-filter-btn${s.chibiFilter === f.key ? " active" : ""}" onclick="setChibiFilter('${f.key}')">${f.label}</button>`).join("")}
        </div>
        ${body}
      </section>
    </main>
  </div>`;
}

// ================== CỬA HÀNG ==================
// Chibi chưa sở hữu mà có giá > 0 thì mua bằng vàng (vàng kiếm từ nhiệm vụ).
function shopItems(){
  return s.chibis.filter(c => !c.unlocked && Number(c.price) > 0);
}

async function buyChibi(code){
  if (s.shopBusy) return;
  s.shopBusy = true;
  render();
  try {
    const res = await authFetch(`${API_URL}/chibis/${encodeURIComponent(code)}/buy`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.detail || "Không mua được chibi");
    } else {
      if (data.gold !== undefined) s.gold = Number(data.gold) || 0;
      const c = s.chibis.find(x => x.code === code);
      alert(`Đã mua chibi ${c ? c.name : code}! Vào mục Chibi để sử dụng.`);
    }
  } catch (err) {
    console.error("Lỗi mua chibi:", err);
    alert("Không kết nối được tới máy chủ Backend!");
  } finally {
    s.shopBusy = false;
  }
  await fetchChibis();      // cập nhật danh sách, số vàng
  fetchUserStats();         // huy hiệu "Nhà sưu tầm" có thể vừa đạt
  fetchQuests();
}

function shopCard(c){
  const price = Number(c.price) || 0;
  const enough = s.gold >= price;
  return `<div class="chibi-card">
    <div class="chibi-card-top"><span class="chibi-badge-rarity" style="color:#e8c97a">CỬA HÀNG</span></div>
    <div class="chibi-card-avatar-wrap">${chibiAvatarHtml(c, false)}</div>
    <div class="chibi-card-name">${esc(c.name)}</div>
    <div class="shop-price${enough ? "" : " short"}">🪙 ${price.toLocaleString("vi-VN")}</div>
    <button type="button" class="chibi-use-btn shop-buy-btn${enough ? "" : " short"}" ${s.shopBusy ? "disabled" : ""}
      onclick="buyChibi('${esc(c.code)}')">${enough ? "Mua ngay" : "Chưa đủ vàng"}</button>
  </div>`;
}

function shopView(){
  const items = shopItems();
  let body;
  if (!s.token) body = `<div class="quest-hint">Vui lòng đăng nhập để mua chibi.</div>`;
  else if (s.chibisError) body = `<div class="quest-hint">⚠️ Không tải được cửa hàng. ${esc(s.chibisError)}</div>`;
  else if (!s.chibisLoaded) body = `<div class="quest-hint">Đang tải cửa hàng...</div>`;
  else if (!items.length) body = `<div class="quest-hint">Bạn đã sở hữu tất cả chibi đang bán. Hãy quay lại sau nhé!</div>`;
  else body = `<div class="chibi-grid">${items.map(shopCard).join("")}</div>`;

  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <main class="content">
      <section class="section">
        <div class="section-title">Cửa hàng</div>
        <h3>Mua chibi bằng vàng</h3>
        <div class="quest-hint">Bạn đang có <b>🪙 ${Number(s.gold || 0).toLocaleString("vi-VN")}</b> vàng. Hoàn thành nhiệm vụ để kiếm thêm vàng.</div>
        ${body}
      </section>
    </main>
  </div>`;
}

// ================== BẠN BÈ ==================
async function fetchFriends(){
  if (!s.token) return;
  try {
    const res = await authFetch(`${API_URL}/friends`);
    if (!res.ok) return;
    const data = await res.json();
    s.friends = data.friends || [];
    s.friendsIncoming = data.incoming || [];
    s.friendsOutgoing = data.outgoing || [];
    s.friendsLoaded = true;
    if (s.view === "friends") render(); else refreshNavCounters();
  } catch (err) {
    console.error("Lỗi lấy danh sách bạn bè:", err);
  }
}

// kind: send | accept | decline | remove
async function friendAction(kind, publicId){
  const enc = encodeURIComponent(publicId);
  let url, opts;
  if (kind === "send")        { url = `${API_URL}/friends/request/${enc}`; opts = { method: "POST" }; }
  else if (kind === "accept" || kind === "decline") {
    url = `${API_URL}/friends/respond/${enc}`;
    opts = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: kind }) };
  }
  else if (kind === "remove") { url = `${API_URL}/friends/${enc}`; opts = { method: "DELETE" }; }
  else return;

  try {
    const res = await authFetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.detail || "Thao tác không thành công"); return; }
  } catch (err) {
    console.error("Lỗi thao tác bạn bè:", err);
    alert("Không kết nối được tới máy chủ Backend!");
    return;
  }
  await fetchFriends();
  fetchQuests();           // có thể vừa hoàn thành nhiệm vụ kết bạn
  fetchUserStats();        // huy hiệu "Hòa đồng"
  const root = document.getElementById("profileModalRoot");
  if (root && root.innerHTML.trim()) openProfile(publicId, true);   // làm mới nút trong hồ sơ đang mở
}

function friendRowHtml(p, actionsHtml){
  const tier = getRankTier(p.high_score);
  const name = p.display_name || "Ẩn danh";
  return `<div class="friend-row">
    <button type="button" class="friend-row-main" onclick="openProfile('${esc(p.public_id)}')">
      <div class="nav-search-avatar" style="background:linear-gradient(135deg, ${tier.color}40, ${tier.color}15);border-color:${tier.color}45;color:${tier.color}">${avatarHtml(p.avatar, name.slice(0,2).toUpperCase())}</div>
      <div class="nav-search-item-info">
        <div class="nav-search-item-name">${esc(name)}</div>
        <div class="nav-search-item-id">ID: ${esc(p.public_id || "--------")}</div>
      </div>
    </button>
    <div class="friend-row-tier" style="color:${tier.color}"><span>${tier.icon}</span><span>${esc(tier.name)}</span></div>
    <div class="friend-row-actions">${actionsHtml}</div>
  </div>`;
}

function friendsView(){
  const emptyBox = (icon, text) => `<div class="nav-search-empty" style="padding:2rem 1rem"><span class="nav-search-empty-icon">${icon}</span>${text}</div>`;
  const loaded = s.friendsLoaded;

  const incomingRows = s.friendsIncoming.map(p => friendRowHtml(p, `
      <button type="button" class="friend-btn friend-btn-accept" onclick="friendAction('accept','${esc(p.public_id)}')">Chấp nhận</button>
      <button type="button" class="friend-btn friend-btn-decline" onclick="friendAction('decline','${esc(p.public_id)}')">Từ chối</button>`)).join("");
  const outgoingRows = s.friendsOutgoing.map(p => friendRowHtml(p, `
      <span class="friend-btn friend-btn-pending">Đã gửi</span>
      <button type="button" class="friend-btn friend-btn-cancel" onclick="friendAction('remove','${esc(p.public_id)}')">Hủy</button>`)).join("");
  const friendRows = s.friends.map(p => friendRowHtml(p, `
      <button type="button" class="friend-btn friend-btn-chat" onclick="openChat('${esc(p.public_id)}')">💬 Nhắn tin</button>
      <button type="button" class="friend-btn friend-btn-remove" onclick="if(confirm('Hủy kết bạn với ${esc(p.display_name || "người này")}?')) friendAction('remove','${esc(p.public_id)}')">Hủy kết bạn</button>`)).join("");

  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <main class="content">
      <div class="columns friends-columns">
        <section class="section">
          <div class="section-title">Lời mời</div>
          <h3>Lời mời kết bạn (${s.friendsIncoming.length})</h3>
          <div class="leaderboard friends-list">
            ${incomingRows || emptyBox(loaded ? "📭" : "⏳", loaded ? "Không có lời mời nào" : "Đang tải...")}
          </div>
          ${outgoingRows ? `<div class="section-title" style="margin-top:1.5rem">Đã gửi đi (${s.friendsOutgoing.length})</div>
          <div class="leaderboard friends-list">${outgoingRows}</div>` : ""}
        </section>
        <section class="section">
          <div class="section-title">Bạn bè</div>
          <h3>Danh sách bạn bè (${s.friends.length})</h3>
          <div class="leaderboard friends-list">
            ${friendRows || emptyBox(loaded ? "👥" : "⏳", loaded ? "Chưa có bạn bè — dùng ô tìm kiếm ở thanh menu để tìm người chơi" : "Đang tải...")}
          </div>
        </section>
      </div>
    </main>
  </div>`;
}

// ================== TIN NHẮN ==================
// CSDL lưu giờ UTC nhưng tin nhắn trả về không có hậu tố múi giờ -> coi là UTC để hiển thị đúng giờ địa phương.
function parseServerDate(iso){
  if (!iso) return null;
  const str = String(iso);
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : str + "Z");
  return isNaN(d.getTime()) ? null : d;
}

function chatTime(iso){
  const d = parseServerDate(iso);
  return d ? formatChatTime(d.toISOString()) : "";
}

// Danh sách bên trái = các cuộc trò chuyện đã có + bạn bè chưa nhắn lần nào.
function chatListItems(){
  const ids = new Set(s.conversations.map(c => c.public_id));
  const extra = s.friends.filter(f => !ids.has(f.public_id)).map(f => ({
    public_id: f.public_id, display_name: f.display_name, avatar: f.avatar,
    last_message: "", last_message_at: null, last_message_is_mine: null, unread_count: 0,
  }));
  return s.conversations.concat(extra);
}

async function fetchConversations(){
  if (!s.token) return;
  try {
    const res = await authFetch(`${API_URL}/messages/conversations`);
    if (!res.ok) return;
    s.conversations = await res.json();
    s.conversationsLoaded = true;
    refreshNavCounters();
    if (s.view === "messages") refreshChatList();
  } catch (err) {
    console.error("Lỗi lấy danh sách cuộc trò chuyện:", err);
  }
}

function convoItemHtml(c){
  const name = c.display_name || "Ẩn danh";
  const active = s.chatPeer && s.chatPeer.public_id === c.public_id;
  const unread = Number(c.unread_count) || 0;
  const preview = c.last_message
    ? `${c.last_message_is_mine ? "Bạn: " : ""}${esc(c.last_message)}`
    : "Chưa có tin nhắn";
  return `<button type="button" class="chat-convo-item${active ? " active" : ""}" onclick="openChat('${esc(c.public_id)}')">
    <div class="nav-search-avatar">${avatarHtml(c.avatar, name.slice(0,2).toUpperCase())}</div>
    <div class="chat-convo-info">
      <div class="chat-convo-name">${esc(name)}</div>
      <div class="chat-convo-preview">${preview}</div>
    </div>
    <div class="chat-convo-meta">
      <span class="chat-convo-time">${c.last_message_at ? esc(chatTime(c.last_message_at)) : ""}</span>
      ${unread ? `<span class="nav-badge chat-convo-badge">${unread > 99 ? "99+" : unread}</span>` : ""}
    </div>
  </button>`;
}

function chatMessagesHtml(){
  if (s.chatLoading && !s.chatMessages.length) {
    return `<div class="chat-empty-state">Đang tải tin nhắn...</div>`;
  }
  const more = s.chatHasMore
    ? `<button type="button" class="chat-load-more" onclick="loadChatMessages(true)">Xem tin nhắn cũ hơn</button>` : "";
  const rows = s.chatMessages.map(m => `<div class="chat-bubble-row ${m.is_mine ? "mine" : "theirs"}">
      <div class="chat-bubble">${esc(m.content)}</div>
      <div class="chat-bubble-time">${esc(chatTime(m.created_at))}</div>
    </div>`).join("");
  return more + (rows || `<div class="chat-empty-state">Hãy gửi lời chào đầu tiên 👋</div>`);
}

function chatPanelHtml(){
  const peer = s.chatPeer;
  if (!peer) {
    return `<section class="chat-panel"><div class="chat-empty-state"><div style="font-size:42px">💬</div><div>Chọn một người bạn để bắt đầu trò chuyện</div></div></section>`;
  }
  const name = peer.display_name || "Ẩn danh";
  return `<section class="chat-panel">
    <div class="chat-header">
      <button type="button" class="chat-back-btn" onclick="closeChat()">←</button>
      <div class="nav-search-avatar">${avatarHtml(peer.avatar, name.slice(0,2).toUpperCase())}</div>
      <button type="button" class="chat-header-name" onclick="openProfile('${esc(peer.public_id)}')">${esc(name)}</button>
    </div>
    <div class="chat-messages" id="chatMessages">${chatMessagesHtml()}</div>
    <div class="chat-input-row">
      <input type="text" class="chat-input" id="chatInput" maxlength="2000" placeholder="Nhập tin nhắn..." autocomplete="off"
        onkeydown="if(event.key==='Enter'){event.preventDefault();sendChat();}">
      <button type="button" class="chat-send-btn" id="chatSendBtn" onclick="sendChat()">Gửi</button>
    </div>
  </section>`;
}

function messagesView(){
  const items = chatListItems();
  const empty = `<div class="nav-search-empty" style="padding:2rem 1rem"><span class="nav-search-empty-icon">${s.conversationsLoaded ? "👥" : "⏳"}</span>${s.conversationsLoaded ? "Hãy kết bạn để bắt đầu nhắn tin" : "Đang tải..."}</div>`;
  return `<div class="home fade">
    <div class="gridbg fixed-grid"></div>
    ${navBar()}
    <main class="content">
      <div class="chat-app${s.chatPeer ? " has-active-chat" : ""}">
        <aside class="chat-sidebar">
          <h3 style="padding:0 1.1rem">Tin nhắn</h3>
          <div class="chat-convo-list" id="chatConvoList">${items.map(convoItemHtml).join("") || empty}</div>
        </aside>
        ${chatPanelHtml()}
      </div>
    </main>
  </div>`;
}

// Cập nhật từng phần của màn tin nhắn mà KHÔNG dựng lại cả trang (để không mất chữ đang gõ).
function refreshChatList(){
  const el = document.getElementById("chatConvoList");
  if (el) el.innerHTML = chatListItems().map(convoItemHtml).join("");
}

function refreshChatMessages(stickToBottom = true){
  const el = document.getElementById("chatMessages");
  if (!el) return;
  el.innerHTML = chatMessagesHtml();
  if (stickToBottom) el.scrollTop = el.scrollHeight;
}

function scrollChatToBottom(){
  const el = document.getElementById("chatMessages");
  if (el) el.scrollTop = el.scrollHeight;
}

async function openChat(publicId){
  let info = chatListItems().find(c => c.public_id === publicId) || s.friends.find(f => f.public_id === publicId);
  if (!info) {
    try {
      const res = await fetch(`${API_URL}/profile/${encodeURIComponent(publicId)}`);
      if (res.ok) info = await res.json();
    } catch (err) { /* dùng tên mặc định */ }
  }
  s.chatPeer = {
    public_id: publicId,
    display_name: info ? info.display_name : "Người chơi",
    avatar: info ? (info.avatar || "") : "",
  };
  s.chatMessages = [];
  s.chatHasMore = false;
  s.chatLoading = true;
  s.view = "messages";
  s.notifOpen = false;
  render();
  saveSession();
  if (!s.conversationsLoaded) fetchConversations();
  const input = document.getElementById("chatInput");
  if (input) input.focus();
  await loadChatMessages(false);
}

function closeChat(){
  s.chatPeer = null;
  s.chatMessages = [];
  render();
}

async function loadChatMessages(older){
  const peer = s.chatPeer;
  if (!peer) return;
  const first = s.chatMessages[0];
  const before = (older && first) ? `&before_id=${encodeURIComponent(first.id)}` : "";
  try {
    const res = await authFetch(`${API_URL}/messages/${encodeURIComponent(peer.public_id)}?limit=50${before}`);
    if (!s.chatPeer || s.chatPeer.public_id !== peer.public_id) return;   // đã chuyển sang người khác
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      s.chatLoading = false;
      alert(err.detail || "Không tải được tin nhắn");
      return;
    }
    const data = await res.json();
    const list = data.messages || [];
    s.chatMessages = older ? list.concat(s.chatMessages) : list;
    s.chatHasMore = !!data.has_more;
    s.chatLoading = false;
    // Server đã đánh dấu đã đọc khi mình mở cuộc trò chuyện.
    const convo = s.conversations.find(c => c.public_id === peer.public_id);
    if (convo) convo.unread_count = 0;
    refreshNavCounters();
    refreshChatList();
    refreshChatMessages(!older);
  } catch (err) {
    console.error("Lỗi tải tin nhắn:", err);
    s.chatLoading = false;
  }
}

// Ghi nhận tin vừa gửi/nhận vào danh sách cuộc trò chuyện (đẩy lên đầu).
function touchConversation(peer, content, createdAt, isMine, addUnread){
  let convo = s.conversations.find(c => c.public_id === peer.public_id);
  if (!convo) {
    convo = { public_id: peer.public_id, display_name: peer.display_name, avatar: peer.avatar || "", unread_count: 0 };
  } else {
    s.conversations = s.conversations.filter(c => c !== convo);
  }
  convo.last_message = content;
  convo.last_message_at = createdAt;
  convo.last_message_is_mine = isMine;
  if (addUnread) convo.unread_count = (Number(convo.unread_count) || 0) + 1;
  s.conversations.unshift(convo);
}

async function sendChat(){
  const peer = s.chatPeer;
  const input = document.getElementById("chatInput");
  if (!peer || !input || s.chatSending) return;
  const content = input.value.trim();
  if (!content) return;

  s.chatSending = true;
  const btn = document.getElementById("chatSendBtn");
  if (btn) btn.disabled = true;
  try {
    const res = await authFetch(`${API_URL}/messages/${encodeURIComponent(peer.public_id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { alert(data.detail || "Không gửi được tin nhắn"); return; }
    input.value = "";
    if (s.chatPeer && s.chatPeer.public_id === peer.public_id) {
      s.chatMessages.push({ id: data.message_id, is_mine: true, content, created_at: data.created_at });
      touchConversation(peer, content, data.created_at, true, false);
      refreshChatList();
      refreshChatMessages(true);
    }
    fetchQuests();   // nhiệm vụ "gửi tin nhắn" có thể vừa hoàn thành
  } catch (err) {
    console.error("Lỗi gửi tin nhắn:", err);
    alert("Không kết nối được tới máy chủ Backend!");
  } finally {
    s.chatSending = false;
    const b = document.getElementById("chatSendBtn");
    if (b) b.disabled = false;
    const i = document.getElementById("chatInput");
    if (i) i.focus();
  }
}

// ----- Kênh realtime nhận tin mới (WebSocket /api/ws/messages?token=...) -----
let msgSocket = null;
let msgSocketRetry = null;

function wsBase(){
  return API_URL.replace(/^http/i, "ws").replace(/\/+$/, "");
}

function connectMessagesSocket(){
  if (!s.token || msgSocket) return;
  let ws;
  try {
    ws = new WebSocket(`${wsBase()}/ws/messages?token=${encodeURIComponent(s.token)}`);
  } catch (err) {
    console.error("Không mở được kênh tin nhắn realtime:", err);
    return;
  }
  msgSocket = ws;
  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (err) { return; }
    if (data.type === "new_message") onIncomingMessage(data);
  };
  ws.onclose = () => {
    if (msgSocket === ws) msgSocket = null;
    clearTimeout(msgSocketRetry);
    if (s.token) msgSocketRetry = setTimeout(connectMessagesSocket, 4000);   // mất kết nối -> thử lại
  };
}

function disconnectMessagesSocket(){
  clearTimeout(msgSocketRetry);
  msgSocketRetry = null;
  if (msgSocket) {
    const ws = msgSocket;
    msgSocket = null;
    try { ws.close(); } catch (err) { /* noop */ }
  }
}

function onIncomingMessage(d){
  const open = s.view === "messages" && s.chatPeer && s.chatPeer.public_id === d.public_id;
  const peer = { public_id: d.public_id, display_name: d.display_name, avatar: d.avatar || "" };
  touchConversation(peer, d.content, d.created_at, false, !open);
  if (open) {
    s.chatMessages.push({ id: d.message_id, is_mine: false, content: d.content, created_at: d.created_at });
    // Đang xem đúng cuộc trò chuyện này: gọi API lịch sử để server đánh dấu đã đọc.
    authFetch(`${API_URL}/messages/${encodeURIComponent(d.public_id)}?limit=1`).catch(() => {});
  } else {
    showToast({ icon: "💬", text: `${d.display_name || "Bạn bè"}: ${d.content}`, onClick: () => openChat(d.public_id) });
  }
  refreshNavCounters();
  if (s.view === "messages") {
    refreshChatList();
    if (open) refreshChatMessages(true);
  }
}

// ================== THÔNG BÁO ==================
// Thông báo do DATABASE tự tạo (hoàn thành nhiệm vụ, lời mời kết bạn, thành tích...).
// Chuông ở thanh menu hiện số chưa đọc; frontend hỏi server mỗi 30 giây.
// QUAN TRỌNG: cập nhật chuông bằng cách thay đúng khối #notifWrap, KHÔNG gọi render()
// (render() dựng lại cả trang -> sẽ làm game đang chơi bị khởi động lại).
const NOTIF_POLL_MS = 30000;
let notifPollTimer = null;

const NOTIF_ICONS = { quest: "🎯", achievement: "🏆", friend_request: "👥", system: "🔔" };
function notifIcon(type){ return NOTIF_ICONS[type] || "🔔"; }

function notifTimeAgo(iso){
  const d = parseServerDate(iso);
  if (!d) return "";
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (sec < 60) return "Vừa xong";
  if (sec < 3600) return `${Math.floor(sec / 60)} phút trước`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} giờ trước`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} ngày trước`;
  return d.toLocaleDateString("vi-VN");
}

function notifBellHtml(){
  const unread = s.notifUnread || 0;
  const badge = unread ? `<span class="notif-badge">${unread > 99 ? "99+" : unread}</span>` : "";

  let panel = "";
  if (s.notifOpen) {
    const isNew = (n) => !n.is_read || s.notifNewIds.has(n.id);
    const items = s.notifications.map(n => `<div class="notif-item${isNew(n) ? " unread" : ""}" onclick="onNotifClick(${Number(n.id)})">
        <div class="notif-icon">${notifIcon(n.type)}</div>
        <div class="notif-body">
          <div class="notif-text">${esc(n.content)}</div>
          <div class="notif-time">${esc(notifTimeAgo(n.created_at))}</div>
        </div>
        ${isNew(n) ? `<span class="notif-dot"></span>` : ""}
      </div>`).join("");
    const empty = `<div class="notif-empty">${s.notifLoaded ? "📭 Chưa có thông báo nào" : "⏳ Đang tải..."}</div>`;
    panel = `<div class="notif-panel">
        <div class="notif-head">
          <span>Thông báo</span>
          <button type="button" class="notif-readall" onclick="markAllNotifRead()" ${s.notifNewIds.size ? "" : "disabled"}>Đánh dấu đã đọc tất cả</button>
        </div>
        <div class="notif-list">${items || empty}</div>
      </div>`;
  }

  return `<div class="notif-wrap" id="notifWrap">
      <div class="notif-bell${s.notifOpen ? " open" : ""}" onclick="toggleNotifPanel()" title="Thông báo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        ${badge}
      </div>
      ${panel}
    </div>`;
}

function refreshNotifUI(){
  const wrap = document.getElementById("notifWrap");
  if (wrap) wrap.outerHTML = notifBellHtml();
}

// Mở chuông = đã xem: số đỏ về 0 ngay (server cũng đánh dấu đã đọc). Các thông báo mới vẫn
// được tô sáng trong panel cho tới khi đóng panel.
function markNotifsSeen(){
  s.notifications.forEach(n => {
    if (!n.is_read) { s.notifNewIds.add(n.id); n.is_read = true; }
  });
  s.notifUnread = 0;
  authFetch(`${API_URL}/notifications/read-all`, { method: "POST" })
    .catch(err => console.error("Lỗi đánh dấu đã đọc:", err));
}

async function toggleNotifPanel(){
  s.notifOpen = !s.notifOpen;
  if (s.notifOpen) markNotifsSeen(); else s.notifNewIds = new Set();
  refreshNotifUI();
  if (s.notifOpen) await fetchNotifications();
}

async function fetchNotifications(){
  if (!s.token) return;
  try {
    const res = await authFetch(`${API_URL}/notifications?limit=30`);
    if (!res.ok) return;
    const data = await res.json();
    const list = data.notifications || [];
    const maxId = list.reduce((m, n) => Math.max(m, Number(n.id) || 0), 0);

    // Lần tải đầu tiên chỉ ghi nhớ mốc, không bật toast cho thông báo cũ.
    const prevLastId = s.notifLastId;
    s.notifLastId = Math.max(prevLastId || 0, maxId);
    const fresh = prevLastId !== null
      ? list.filter(n => n.id > prevLastId && !n.is_read).reverse().slice(-3)
      : [];

    s.notifications = list;
    s.notifUnread = data.unread || 0;
    s.notifLoaded = true;
    if (s.notifOpen) markNotifsSeen();   // đang mở chuông mà có thông báo mới -> coi như đã xem luôn
    refreshNotifUI();

    fresh.forEach(n => showToast({ icon: notifIcon(n.type), text: n.content, onClick: () => onNotifClick(n.id) }));
    // Có lời mời / phản hồi kết bạn mới -> làm mới danh sách bạn bè.
    if (fresh.some(n => n.type === "friend_request")) fetchFriends();
    // Có nhiệm vụ mới hoàn thành -> làm mới danh sách nhiệm vụ (và chấm đỏ trên menu).
    if (fresh.some(n => n.type === "quest")) fetchQuests();
  } catch (err) {
    console.error("Lỗi lấy thông báo:", err);
  }
}

function startNotifPolling(){
  stopNotifPolling();
  fetchNotifications();
  notifPollTimer = setInterval(fetchNotifications, NOTIF_POLL_MS);
}

function stopNotifPolling(){
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = null;
  s.notifOpen = false;
  s.notifLoaded = false;
  s.notifLastId = null;
  s.notifNewIds = new Set();
}

async function markNotifReadOnServer(id){
  try {
    await authFetch(`${API_URL}/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  } catch (err) {
    console.error("Lỗi đánh dấu đã đọc:", err);
  }
}

function onNotifClick(id){
  const n = s.notifications.find(x => x.id === id);
  if (n && !n.is_read) {
    n.is_read = true;
    markNotifReadOnServer(id);
  }
  s.notifOpen = false;
  s.notifNewIds = new Set();
  if (n && n.type === "quest") go("quests");
  else if (n && n.type === "friend_request") go("friends");
  else refreshNotifUI();
}

async function markAllNotifRead(){
  s.notifications.forEach(n => { n.is_read = true; });
  s.notifUnread = 0;
  s.notifNewIds = new Set();
  refreshNotifUI();
  try {
    await authFetch(`${API_URL}/notifications/read-all`, { method: "POST" });
  } catch (err) {
    console.error("Lỗi đánh dấu đã đọc tất cả:", err);
  }
}

// Bấm ra ngoài khung chuông thì đóng panel.
document.addEventListener("click", (e) => {
  if (!s.notifOpen) return;
  const wrap = document.getElementById("notifWrap");
  if (wrap && !wrap.contains(e.target)) {
    s.notifOpen = false;
    s.notifNewIds = new Set();
    refreshNotifUI();
  }
});

// Toast nhỏ góc phải màn hình (thông báo mới, tin nhắn mới). Không dùng render() nên không làm gián đoạn game.
function showToast({ icon, text, onClick }){
  let box = document.querySelector(".notif-toast-box");
  if (!box) {
    box = document.createElement("div");
    box.className = "notif-toast-box";
    document.body.appendChild(box);
  }
  const el = document.createElement("div");
  el.className = "notif-toast";
  el.innerHTML = `<span class="notif-toast-icon">${icon || "🔔"}</span><span>${esc(text)}</span>`;
  const close = () => {
    el.classList.add("hide");
    setTimeout(() => el.remove(), 300);
  };
  el.onclick = () => { close(); if (typeof onClick === "function") onClick(); };
  box.appendChild(el);
  setTimeout(close, 6000);
}
function showNotifToast(n){ showToast({ icon: notifIcon(n.type), text: n.content }); }



// ================== HIỆU ỨNG MẮT / CỔ THÚ CƯNG Ở MÀN ĐĂNG NHẬP ==================
document.addEventListener("mousemove", (event) => {
  const pupils = document.querySelectorAll(".pupil");
  pupils.forEach((pupil) => {
    const eye = pupil.parentElement;
    const rect = eye.getBoundingClientRect();
    const eyeX = rect.left + rect.width / 2;
    const eyeY = rect.top + rect.height / 2;
    const radian = Math.atan2(event.clientY - eyeY, event.clientX - eyeX);
    const maxDistance = 3;
    const x = Math.cos(radian) * maxDistance;
    const y = Math.sin(radian) * maxDistance;
    pupil.style.transform = `translate(${x}px, ${y}px)`;
  });

  // Cổ dài vươn theo hướng con trỏ chuột
  const rigs = document.querySelectorAll(".pet-rig");
  const maxTilt = 32; // độ nghiêng tối đa, tránh xoay quá lố
  rigs.forEach((rig) => {
    const box = rig.closest(".pet-box");
    const rect = box.getBoundingClientRect();
    const anchorX = rect.left + rect.width / 2;
    const anchorY = rect.bottom; // gốc cổ luôn cố định ở đáy pet-box
    const dx = event.clientX - anchorX;
    const dy = event.clientY - anchorY;
    let angle = Math.atan2(dx, -dy) * (180 / Math.PI);
    angle = Math.max(-maxTilt, Math.min(maxTilt, angle));
    rig.style.transform = `rotate(${angle}deg)`;
  });
});

// ================== KHỞI ĐỘNG ==================
fetchLeaderboard();
restoreSession().then((restored) => {
  if (!restored) render();
});
