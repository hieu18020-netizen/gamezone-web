const API_URL = window.APP_CONFIG ? window.APP_CONFIG.API_URL : "https://maintenance-roman-silly-morning.trycloudflare.com/api";

// Huy hiệu tính từ dữ liệu thật của người chơi: tổng điểm (cũng là điểm xếp rank), số ván đã chơi
// và hạng trên bảng xếp hạng. Cùng một danh sách dùng cho hồ sơ của mình và hồ sơ người khác.
function buildAchievements(score, matches, rankStr){
  score = Math.max(0, Number(score) || 0);
  matches = Math.max(0, Number(matches) || 0);
  const rankNum = parseInt(String(rankStr || "").replace(/\D/g, ""), 10) || 0; // "#3" -> 3, "#-" -> 0
  const GOLD_AT = 3 * 4 * RANK_STEP;     // 2.400 điểm: vào hạng Vàng
  const DIAMOND_AT = 6 * 4 * RANK_STEP;  // 4.800 điểm: vào hạng Kim Cương
  const fmt = n => n.toLocaleString("vi-VN");
  const goal = (icon, label, text, rarity, cur, target) => ({
    icon, label, rarity,
    earned: cur >= target,
    pct: Math.min(1, cur / target),
    desc: cur >= target ? text : `${text} (${fmt(Math.min(cur, target))}/${fmt(target)})`,
  });
  return [
    goal("🎮", "Tân thủ",    "Hoàn thành ván đầu tiên",   "Thường",      matches, 1),
    goal("🔥", "Chăm chỉ",   "Chơi tổng cộng 20 ván",     "Hiếm",        matches, 20),
    goal("🧱", "Bứt phá",    "Đạt 1.000 điểm",            "Hiếm",        score, 1000),
    goal("🥇", "Hạng Vàng",  "Đạt hạng Vàng",             "Siêu hiếm",   score, GOLD_AT),
    goal("💎", "Kim cương",  "Đạt hạng Kim Cương",        "Huyền thoại", score, DIAMOND_AT),
    // Phải có điểm > 0: tài khoản mới chưa chơi mà đứng hạng 1 (ít người) thì chưa tính là vô địch.
    { icon: "🏆", label: "Vô địch", desc: "Đứng top 1 bảng xếp hạng", rarity: "Huyền thoại",
      earned: rankNum === 1 && score > 0, pct: rankNum === 1 && score > 0 ? 1 : 0 },
  ];
}
// Danh mục huy hiệu (phần hiển thị). Việc ai đã đạt huy hiệu nào do BACKEND tính từ dữ liệu thật
// (hàm compute_badges trong backend.py) và trả về dưới dạng danh sách mã `badges`.
const BADGE_CATALOG = [
  {code:"rookie",       icon:"🎮", label:"Tân binh",           desc:"Chơi ván đầu tiên",                 rarity:"Thường"},
  {code:"tetris_500",   icon:"🧱", label:"Thợ xếp hình",       desc:"Đạt 500 điểm Tetris",               rarity:"Thường"},
  {code:"snake_300",    icon:"🐍", label:"Thợ săn rắn",        desc:"Đạt 300 điểm Rắn săn mồi",          rarity:"Thường"},
  {code:"chess_win",    icon:"♟️", label:"Nước cờ đầu",        desc:"Thắng 1 ván cờ vua",                rarity:"Thường"},
  {code:"friends_3",    icon:"🤝", label:"Hòa đồng",           desc:"Có 3 người bạn",                    rarity:"Hiếm"},
  {code:"chibi_3",      icon:"🐣", label:"Nhà sưu tầm",        desc:"Sở hữu 3 chibi",                    rarity:"Hiếm"},
  {code:"diamond",      icon:"💎", label:"Kim cương",          desc:"Đạt rank Kim Cương",                rarity:"Siêu hiếm"},
  {code:"top3",         icon:"👑", label:"Tinh hoa",           desc:"Lọt top 3 bảng xếp hạng",           rarity:"Siêu hiếm"},
  {code:"quest_master", icon:"🏆", label:"Nhà thám hiểm",      desc:"Hoàn thành tất cả nhiệm vụ",        rarity:"Huyền thoại"},
];

// Tiến độ chung = trung bình tiến độ của từng huy hiệu (huy hiệu đã đạt tính 100%), nên thanh
// chạy dần theo số ván / điểm chứ không chỉ nhảy khi vừa đạt thêm 1 huy hiệu.
function achievementProgress(list){
  const total = list.length;
  const earned = list.filter(a => a.earned).length;
  const pct = total ? Math.round(list.reduce((sum, a) => sum + (a.earned ? 1 : a.pct), 0) * 100 / total) : 0;
  return { total, earned, pct };
// Gắn cờ earned cho từng huy hiệu theo danh sách mã server trả về.
function badgesFor(codes){
  const got = new Set(codes || []);
  return BADGE_CATALOG.map(b => ({ ...b, earned: got.has(b.code) }));
}

function achievementCardHtml(a){
  const miniBar = (!a.earned && a.pct > 0)
    ? `<div class="ach-bar"><i style="width:${Math.round(a.pct * 100)}%"></i></div>` : "";
function badgeCardHtml(a){
return `
   <div class="achievement${a.earned ? "" : " locked"}">
      ${a.earned ? "" : `<span class="achv-lock" aria-hidden="true">🔒</span>`}
     <div class="icon">${a.icon}</div>
      <strong>${a.label}${a.earned ? " ✓" : ""}</strong>
      <strong>${a.label}</strong>
     <p>${a.desc}</p>
      ${miniBar}
     <span class="rarity" style="color:${rarityColor[a.rarity]}">${a.rarity}</span>
   </div>`;
}
@@ -123,6 +105,8 @@ let s = {
userRank    : "#-",
userMatches : 0,
userHighScore: 0,
  userSnakeScore: 0,
  badges: [],           // mã huy hiệu đã đạt (server tính)
showLogin   : false,
regPass     : "",
showReg     : false,
@@ -145,8 +129,8 @@ let s = {
notifUnread    : 0,
notifOpen      : false,
notifLoaded    : false,
  notifSeen      : new Set(),   // id thông báo vừa được 'xem' khi mở chuông (vẫn tô sáng trong panel, nhưng không tính vào số trên chuông)
notifLastId    : null,
  notifNewIds    : new Set(),  // id thông báo mới lúc mở chuông (để vẫn tô sáng dù số đỏ đã về 0)
conversations       : [],
conversationsLoaded : false,
conversationsError  : false,
@@ -163,6 +147,7 @@ let s = {
unlockedChibiCodes  : new Set(), // mã các chibi tài khoản đã mở khoá (lấy từ server, bảng user_chibis)
chibisLoaded        : false,
gold                : 0,          // số vàng của tài khoản (lấy từ server)
  claimingQuest       : false,      // đang gửi yêu cầu nhận vàng nhiệm vụ (chặn bấm đúp)
chibiPrices         : {},         // code chibi -> giá bán (vàng), 0 = không bán
shopBusy            : false,      // đang gửi yêu cầu mua
gameHistory         : [],
@@ -234,6 +219,8 @@ function logout(){
s.userRank = "#-";
s.userMatches = 0;
s.userHighScore = 0;
  s.userSnakeScore = 0;
  s.badges = [];
dbLeaderboard = [];
s.friends = [];
s.friendsIncoming = [];
@@ -282,6 +269,8 @@ async function restoreSession(){
s.userRank = data.rank;
s.userMatches = data.total_matches;
s.userHighScore = data.high_score || 0;
    s.userSnakeScore = data.snake_score || 0;
    s.badges = data.badges || [];
if (data.avatar) s.avatar = data.avatar;
s.activeChibiCodes = new Set(data.active_chibi_codes || []);
applyChibiRunnerState(); // đồng bộ lại theo dữ liệu thật từ server (phòng khi đổi từ máy khác)
@@ -338,6 +327,8 @@ async function fetchUserStats() {
s.userRank = data.rank;
s.userMatches = data.total_matches;
s.userHighScore = data.high_score || 0;
      s.userSnakeScore = data.snake_score || 0;
      s.badges = data.badges || [];
s.userPublicId = data.public_id || "--------";
if (data.avatar) s.avatar = data.avatar;
if (data.active_chibi_codes !== undefined) {
@@ -510,53 +501,54 @@ async function fetchQuests(){
}
}

let questClaiming = false;

async function claimQuestRequest(url){
  if (questClaiming || !s.token) return;
  questClaiming = true;
async function claimQuest(id){
  if (s.claimingQuest) return;
  s.claimingQuest = true;
try {
    const res = await authFetch(url, { method: "POST" });
    const res = await authFetch(`${API_URL}/quests/${encodeURIComponent(id)}/claim`, { method: "POST" });
const data = await res.json().catch(() => ({}));
if (!res.ok) {
      alert(data.detail || "Không thể nhận vàng");
    } else if (data.gold !== undefined) {
      s.gold = Number(data.gold) || 0;
      alert(data.detail || "Không nhận được vàng");
      fetchQuests();
      return;
}
    const q = s.quests.find(x => x.id === id);
    if (q) q.claimed = true;
    if (data.gold !== undefined) s.gold = Number(data.gold) || 0;
} catch (err) {
    console.error("Lỗi nhận vàng:", err);
    console.error("Lỗi nhận vàng nhiệm vụ:", err);
alert("Không kết nối được tới máy chủ Backend!");
} finally {
    questClaiming = false;
    s.claimingQuest = false;
}
  await fetchQuests(); // tải lại danh sách + số vàng trên thanh menu
  if (s.view === "quests") render();
}

function claimQuest(id){ return claimQuestRequest(`${API_URL}/quests/${Number(id)}/claim`); }
function claimAllQuests(){ return claimQuestRequest(`${API_URL}/quests/claim-all`); }
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
  const claimable = s.quests.filter(q => q.done && !q.claimed).length;
const pct = total ? Math.round(done * 100 / total) : 0;

  const rowsHtml = s.quests.map((q, i) => `<div class="quest-row${q.done ? " done" : ""}">
  const rowsHtml = s.quests.map((q, i) => `<div class="quest-row${q.done ? " done" : ""}${q.done && !q.claimed ? " claimable" : ""}">
     <div class="quest-index">${q.done ? "✓" : i + 1}</div>
     <div class="quest-info">
       <div class="quest-title">${esc(q.title)}</div>
       <div class="quest-desc">${esc(q.description)}</div>
     </div>
      ${!q.done
        ? `<span class="quest-status quest-status-pending">Chưa hoàn thành</span>`
        : q.claimed
          ? `<span class="quest-status">Đã nhận 🪙 ${Number(q.reward_gold) || 0}</span>`
          : `<button type="button" class="quest-claim-btn" onclick="claimQuest(${Number(q.id)})">Nhận 🪙 ${Number(q.reward_gold) || 0}</button>`}
      <div class="quest-actions">${questActionHtml(q)}</div>
   </div>`).join("");
  const claimable = s.quests.filter(q => q.done && !q.claimed);
  const claimableGold = claimable.reduce((sum, q) => sum + (Number(q.reward_gold) || 0), 0);
  const claimAllHtml = claimable.length
    ? `<button type="button" class="quest-claim-all" onclick="claimAllQuests()">🎁 Nhận tất cả (+🪙 ${claimableGold})</button>`
    : "";

const emptyHtml = `<div class="nav-search-empty" style="padding:2rem 1rem">
   <span class="nav-search-empty-icon">${s.questsLoaded ? "📭" : "⏳"}</span>${s.questsLoaded ? "Chưa có nhiệm vụ nào" : "Đang tải nhiệm vụ..."}
@@ -569,8 +561,7 @@ function questsView(){
     <section class="section">
       <div class="section-title">Nhiệm vụ</div>
       <h3>Hoàn thành nhiệm vụ (${done}/${total})</h3>
        <div class="quest-hint">Nhiệm vụ được hệ thống tự ghi nhận khi bạn hoàn thành. Bấm "Nhận" để lấy vàng thưởng.</div>
        ${claimAllHtml}
        <div class="quest-hint">Nhiệm vụ được hệ thống tự ghi nhận khi bạn hoàn thành. Mỗi nhiệm vụ nhận được <b>🪙 10 vàng</b> — bấm <b>Nhận</b> để lấy.${claimable ? ` Bạn có <b>${claimable}</b> phần thưởng chưa nhận!` : ""}</div>
       <div class="quest-progress"><div class="quest-progress-bar" style="width:${pct}%"></div></div>
       <div class="leaderboard quest-list">${rowsHtml || emptyHtml}</div>
     </section>
@@ -608,94 +599,66 @@ function formatPlayDuration(sec){
return m > 0 ? `${m} phút ${r} giây` : `${r} giây`;
}

function historyWhen(iso){
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

const HX_ICON_TETRIS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="6" height="6" rx="1.2"/><rect x="14" y="4" width="6" height="6" rx="1.2"/><rect x="9" y="14" width="6" height="6" rx="1.2"/></svg>`;
const HX_ICON_CHESS = `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="6.5" r="3"/><path d="M9 11h6l-1 5h2.2l1.3 4H6.5l1.3-4H10z"/></svg>`;
const HX_ICON_TREND = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg>`;
const HX_ICON_TROPHY = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/></svg>`;

function historyRowHtml(h){
  const when = historyWhen(h.played_at);
  const when = formatChatTime(h.played_at);

if (h.game_type === "chess") {
const resText = { win: "Thắng", loss: "Thua", draw: "Hòa" }[h.result] || "—";
const delta = Number(h.score_delta) || 0;
    const cls = delta > 0 ? "win" : (delta < 0 ? "loss" : "draw");
    const big = delta > 0 ? `+${delta}` : (delta < 0 ? `${delta}` : "0");
    const opp = h.opponent_name ? ` <i>•</i> đấu với ${esc(h.opponent_name)}` : "";
    const room = h.room_code ? ` <i>•</i> phòng ${esc(h.room_code)}` : "";
    return `<div class="hx-row">
      <div class="hx-icon chess">${HX_ICON_CHESS}</div>
      <div class="hx-info">
        <div class="hx-name">Cờ vua</div>
        <div class="hx-sub">${esc(when)}${opp}${room}</div>
    const badgeCls = delta > 0 ? "win" : (delta < 0 ? "loss" : "draw");
    const badgeText = delta > 0 ? `+${delta}` : (delta < 0 ? `${delta}` : "Hòa");
    const opp = h.opponent_name ? ` · đấu với ${esc(h.opponent_name)}` : "";
    const room = h.room_code ? ` · phòng ${esc(h.room_code)}` : "";
    return `<div class="quest-row history-row">
      <div class="quest-index history-icon">♟</div>
      <div class="quest-info">
        <div class="quest-title">Cờ vua — ${resText}</div>
        <div class="quest-desc">${when}${opp}${room}</div>
     </div>
      <div class="hx-result ${cls}"><b>${big}</b><span>${resText}</span></div>
      <span class="history-badge ${badgeCls}">${badgeText}</span>
   </div>`;
}

const score = Number(h.score) || 0;
const dur = (h.duration_seconds !== null && h.duration_seconds !== undefined)
    ? ` <i>•</i> ${formatPlayDuration(h.duration_seconds)}` : "";
  return `<div class="hx-row">
    <div class="hx-icon tetris">${HX_ICON_TETRIS}</div>
    <div class="hx-info">
      <div class="hx-name">Tetris</div>
      <div class="hx-sub">${esc(when)}${dur}</div>
    ? ` · ${formatPlayDuration(h.duration_seconds)}` : "";
  const isSnake = h.game_type === "snake";
  return `<div class="quest-row history-row">
    <div class="quest-index history-icon">${isSnake ? "🐍" : "🧱"}</div>
    <div class="quest-info">
      <div class="quest-title">${isSnake ? "Rắn săn mồi" : "Tetris"}</div>
      <div class="quest-desc">${when}${dur}</div>
   </div>
    <div class="hx-result score"><b>${score.toLocaleString("vi-VN")}</b><span>điểm</span></div>
    <span class="history-badge score">${score.toLocaleString("vi-VN")} điểm</span>
 </div>`;
}

function historyView(){
const filters = [
    { key: "all",    label: "Tất cả",  icon: "" },
    { key: "tetris", label: "Tetris",  icon: HX_ICON_TETRIS },
    { key: "chess",  label: "Cờ vua",  icon: HX_ICON_CHESS },
    { key: "all",    label: "Tất cả" },
    { key: "tetris", label: "🧱 Tetris" },
    { key: "snake",  label: "🐍 Rắn săn mồi" },
    { key: "chess",  label: "♟ Cờ vua" },
];
const list = s.gameHistory.filter(h => s.historyFilter === "all" || h.game_type === s.historyFilter);
  const sm = s.gameHistorySummary || {};

  const tetrisGames = Number(sm.tetris_games) || 0;
  const chessGames = Number(sm.chess_games) || 0;
  const wins = Number(sm.chess_wins) || 0;
  const losses = Number(sm.chess_losses) || 0;
  const draws = Number(sm.chess_draws) || 0;
  const winRate = chessGames ? (wins * 100 / chessGames).toFixed(1) : "0.0";
  const form = s.gameHistory.filter(h => h.game_type === "chess").slice(0, 10)
    .reduce((sum, h) => sum + (Number(h.score_delta) || 0), 0);
  const formCls = form > 0 ? "pos" : (form < 0 ? "neg" : "");
  const formText = form > 0 ? `+${form}` : `${form}`;

  const statsHtml = `<div class="hx-stats">
      <div class="hx-stat"><div class="hx-stat-icon">${HX_ICON_TETRIS}</div><div>
        <div class="hx-stat-label">Ván Tetris</div>
        <div class="hx-stat-num">${String(tetrisGames).padStart(2, "0")}</div>
        <div class="hx-stat-sub">Điểm cao nhất ${(Number(sm.tetris_best) || 0).toLocaleString("vi-VN")}</div></div></div>
      <div class="hx-stat"><div class="hx-stat-icon">${HX_ICON_CHESS}</div><div>
        <div class="hx-stat-label">Ván cờ vua</div>
        <div class="hx-stat-num">${chessGames.toLocaleString("vi-VN")}</div>
        <div class="hx-stat-sub">Tổng số trận đã chơi</div></div></div>
      <div class="hx-stat hl"><div class="hx-stat-icon">${HX_ICON_TREND}</div><div>
        <div class="hx-stat-label">Tỷ lệ thắng</div>
        <div class="hx-stat-num">${winRate}%</div>
        <div class="hx-stat-sub">${wins} thắng · ${draws} hòa</div></div></div>
      <div class="hx-stat"><div class="hx-stat-icon">${HX_ICON_TROPHY}</div><div>
        <div class="hx-stat-label">Phong độ</div>
        <div class="hx-stat-num ${formCls}">${formText}</div>
        <div class="hx-stat-sub">Trong 10 trận gần đây</div></div></div>
    </div>`;
  const sm = s.gameHistorySummary;

  const fmt = (v) => (Number(v) || 0).toLocaleString("vi-VN");
  const gameCard = (cls, icon, name, recordLabel, record, games, footer) => `
      <div class="history-game ${cls}">
        <div class="history-game-head"><span class="history-game-icon">${icon}</span><span class="history-game-name">${name}</span></div>
        <div class="history-game-stats">
          <div class="history-game-stat"><div class="history-game-num">${record}</div><div class="history-game-label">${recordLabel}</div></div>
          <div class="history-game-stat"><div class="history-game-num">${games}</div><div class="history-game-label">Số trận đã chơi</div></div>
        </div>${footer ? `<div class="history-game-foot">${footer}</div>` : ""}
      </div>`;

  const statsHtml = sm ? `<div class="history-summary">
      ${gameCard("hg-tetris", "🧱", "Tetris", "Kỷ lục", fmt(sm.tetris_best), fmt(sm.tetris_games))}
      ${gameCard("hg-snake", "🐍", "Rắn săn mồi", "Kỷ lục", fmt(sm.snake_best), fmt(sm.snake_games))}
      ${gameCard("hg-chess", "♟", "Cờ vua", "Số trận thắng", fmt(sm.chess_wins), fmt(sm.chess_games),
        `Thua <b>${fmt(sm.chess_losses)}</b> · Hòa <b>${fmt(sm.chess_draws)}</b>`)}
    </div>` : "";

const emptyHtml = `<div class="nav-search-empty" style="padding:2rem 1rem">
   <span class="nav-search-empty-icon">${s.gameHistoryLoaded ? "📭" : "⏳"}</span>${s.gameHistoryLoaded ? "Chưa có ván chơi nào" : "Đang tải lịch sử..."}
@@ -704,28 +667,16 @@ function historyView(){
return `<div class="home fade">
   <div class="gridbg fixed-grid"></div>
   ${navBar()}
    <main class="content hx">
      <header class="hx-head">
        <div>
          <div class="hx-eyebrow"><span></span>Hoạt động</div>
          <h1 class="hx-title">Lịch sử chơi</h1>
          <p class="hx-lead">Xem lại thành tích và phong độ của bạn qua từng ván đấu.</p>
        </div>
        <div class="hx-scope"><small>Phạm vi dữ liệu</small><b>100 ván gần nhất</b></div>
      </header>
      ${statsHtml}
      <section class="hx-card">
        <div class="hx-card-head">
          <div>
            <div class="hx-card-title">Hoạt động gần đây</div>
            <div class="hx-card-sub">${list.length} kết quả được hiển thị</div>
          </div>
          <div class="hx-seg">
            ${filters.map(f => `<button type="button" class="${s.historyFilter === f.key ? "active" : ""}" onclick="setHistoryFilter('${f.key}')">${f.icon}${f.label}</button>`).join("")}
          </div>
    <main class="content">
      <section class="section">
        <div class="section-title">Lịch sử</div>
        <h3>Lịch sử chơi game</h3>
        <div class="quest-hint">Hiển thị tối đa 100 ván gần nhất, ván mới nhất ở trên cùng.</div>
        ${statsHtml}
        <div class="chibi-filters">
          ${filters.map(f => `<button type="button" class="chibi-filter-btn${s.historyFilter === f.key ? " active" : ""}" onclick="setHistoryFilter('${f.key}')">${f.label}</button>`).join("")}
       </div>
        <div class="hx-cols"><span>Trò chơi &amp; thời gian</span><span>Kết quả</span></div>
        <div class="hx-list">${list.map(historyRowHtml).join("") || emptyHtml}</div>
        <div class="leaderboard quest-list">${list.map(historyRowHtml).join("") || emptyHtml}</div>
     </section>
   </main>
 </div>`;
@@ -1410,9 +1361,8 @@ function homeView(){
const displayName = s.nick || s.username || "GameThủ";
const ini = displayName.slice(0, 2).toUpperCase();
const myTier = getRankTier(s.userHighScore);
  const allAch = buildAchievements(s.userHighScore, s.userMatches, s.userRank);
  const prog = achievementProgress(allAch);
  const list = s.filter === "earned" ? allAch.filter(a => a.earned) : allAch;
  const allBadges = badgesFor(s.badges);
  const list = s.filter === "earned" ? allBadges.filter(a => a.earned) : allBadges;

let lbRows = "";
if (dbLeaderboard.length === 0) {
@@ -1440,7 +1390,7 @@ function homeView(){
}).join("");
}

  const achCards = list.map(achievementCardHtml).join("");
  const achCards = list.map(badgeCardHtml).join("");

return `<div class="home fade">
   <div class="gridbg fixed-grid"></div>
@@ -1486,10 +1436,10 @@ function homeView(){
             <button class="${s.filter === "earned" ? "active" : ""}" onclick="setFilter('earned')">Đã đạt</button>
           </div>
         </div>
          <div class="achievements">${achCards || `<div class="quest-hint">Bạn chưa đạt huy hiệu nào — chơi thêm vài ván nhé!</div>`}</div>
          <div class="achievements">${achCards}</div>
         <div class="progress">
            <div class="progress-head"><span>Tiến độ hoàn thành</span><b style="color:#8b5cf6">${prog.earned}/${prog.total} huy hiệu · ${prog.pct}%</b></div>
            <div class="bar"><i style="width:${prog.pct}%"></i></div>
            <div class="progress-head"><span>Tiến độ hoàn thành</span><b style="color:#8b5cf6">4/6</b></div>
            <div class="bar"><i></i></div>
         </div>
       </section>

@@ -1516,7 +1466,7 @@ function homeView(){
const GAMES = [
{ id:"tetris",      name:"Tetris",        desc:"Xếp hình kinh điển — leo rank, phá kỷ lục điểm cao.", icon:"🟦", tag:"ARCADE",     color:"#00d4ff", playable:true  },
{ id:"chess",       name:"Cờ Vua",        desc:"Cờ vua online 1vs1 qua mạng — tạo phòng và mời bạn bè vào đấu.", icon:"♟️", tag:"CHIẾN THUẬT", color:"#e8c97a", playable:true  },
  { id:"snake",       name:"Rắn săn mồi",   desc:"Điều khiển con rắn, ăn mồi và tránh va chạm.",         icon:"🐍", tag:"ARCADE",     color:"#22c55e", playable:false },
  { id:"snake",       name:"Rắn săn mồi",   desc:"Điều khiển con rắn, ăn mồi và tránh va chạm.",         icon:"🐍", tag:"ARCADE",     color:"#22c55e", playable:true  },
{ id:"2048",        name:"2048",          desc:"Trượt các ô số, kết hợp để đạt ô 2048.",               icon:"🔢", tag:"PUZZLE",     color:"#f97316", playable:false },
{ id:"flappy",      name:"Flappy Bird",   desc:"Vượt qua ống nước — kiểm tra phản xạ của bạn.",        icon:"🐦", tag:"PHẢN XẠ",    color:"#eab308", playable:false },
{ id:"minesweeper", name:"Dò mìn",        desc:"Lật ô, đánh dấu mìn và sống sót đến cuối.",            icon:"💣", tag:"CHIẾN THUẬT",color:"#ef4444", playable:false },
@@ -1618,7 +1568,14 @@ async function fetchChibis(){
if (!s.token) return;
try {
const res = await authFetch(`${API_URL}/chibis`);
    if (!res.ok) return;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      s.chibisError = `Lỗi ${res.status}: ${err.detail || "máy chủ không phản hồi đúng"}`;
      console.error("Lỗi /chibis:", s.chibisError);
      if (s.view === "shop") render();
      return;
    }
    s.chibisError = null;
const data = await res.json();
s.unlockedChibiCodes = new Set((data.chibis || []).filter(c => c.unlocked).map(c => c.code));
s.chibisLoaded = true;
@@ -1634,6 +1591,8 @@ async function fetchChibis(){
if (s.view === "chibi" || s.view === "shop") render();
} catch (err) {
console.error("Lỗi lấy danh sách chibi:", err);
    s.chibisError = "Không kết nối được máy chủ (kiểm tra API_URL trong config.js)";
    if (s.view === "shop") render();
}
}

@@ -1812,6 +1771,7 @@ function shopView(){
const items = shopItems();
let body;
if (!s.token) body = `<div class="quest-hint">Vui lòng đăng nhập để mua chibi.</div>`;
  else if (s.chibisError) body = `<div class="quest-hint">⚠️ Không tải được cửa hàng. ${esc(s.chibisError)}</div>`;
else if (!s.chibisLoaded) body = `<div class="quest-hint">Đang tải cửa hàng...</div>`;
else if (!items.length) body = `<div class="quest-hint">Bạn đã sở hữu tất cả chibi đang bán. Hãy quay lại sau nhé!</div>`;
else body = `<div class="chibi-grid">${items.map(shopCard).join("")}</div>`;
@@ -1914,7 +1874,8 @@ function gameView(){
// để server có căn cứ kiểm tra điểm nộp lên sau này có hợp lý hay không.
async function startGameSession(){
try {
    const res = await authFetch(`${API_URL}/start-game`, { method: "POST" });
    const game = s.selectedGame === "snake" ? "snake" : "tetris";   // phiên chơi gắn với loại game
    const res = await authFetch(`${API_URL}/start-game?game=${game}`, { method: "POST" });
if (res.ok) {
const data = await res.json();
s.gameSessionToken = data.session_token || "";
@@ -1928,6 +1889,7 @@ async function startGameSession(){
// Trả về {rank, highScore, totalMatches} nếu thành công, hoặc null nếu có lỗi.
// KHÔNG tự chuyển trang ở đây nữa — để tetris.js quyết định hiển thị gì sau khi có kết quả.
async function submitScore(finalScore){
  const gameType = s.selectedGame === "snake" ? "snake" : "tetris";
if (!s.gameSessionToken) {
alert("Không xác định được phiên chơi, điểm chưa được lưu. Vui lòng chơi lại ván mới.");
return null;
@@ -1936,7 +1898,7 @@ async function submitScore(finalScore){
const res = await authFetch(`${API_URL}/update-score`, {
method: "POST",
headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ score: finalScore, session_token: s.gameSessionToken })
      body: JSON.stringify({ score: finalScore, session_token: s.gameSessionToken, game_type: gameType })
});
if (!res.ok) {
const data = await res.json().catch(() => ({}));
@@ -1956,8 +1918,11 @@ async function submitScore(finalScore){
s.userRank = data.rank;
s.userMatches = data.total_matches;
s.userHighScore = data.high_score || 0;
      s.userSnakeScore = data.snake_score || 0;
s.gameSessionToken = "";
      return { rank: data.rank, highScore: data.high_score || 0, totalMatches: data.total_matches };
      // Rắn săn mồi hiển thị KỶ LỤC riêng của rắn; Tetris giữ nguyên như cũ.
      const best = gameType === "snake" ? (data.snake_score || 0) : (data.high_score || 0);
      return { rank: data.rank, highScore: best, totalMatches: data.total_matches };
}
} catch (err) {
console.error("Lỗi lấy thông tin xếp hạng:", err);
@@ -1979,6 +1944,9 @@ function render(){
if (typeof ChessGame !== "undefined") {
ChessGame.unmount();
}
  if (typeof SnakeGame !== "undefined") {
    SnakeGame.unmount();
  }

// Chỉ phát animation "fade" khi THỰC SỰ chuyển sang view khác.
// Nếu vẫn đang ở cùng 1 view (ví dụ chỉ bấm checkbox, đổi filter...),
@@ -2014,6 +1982,11 @@ function render(){
playerScore: s.userHighScore || 0,
authToken: s.token || ""
}));
    } else if (mountPoint && s.selectedGame === "snake" && typeof SnakeGame !== "undefined") {
      SnakeGame.mount(mountPoint, Object.assign({}, gameOpts, {
        onStart: startGameSession,      // chơi lại -> xin phiên chơi mới (token chỉ dùng được 1 lần)
        highScore: s.userSnakeScore || 0
      }));
} else if (mountPoint && typeof TetrisGame !== "undefined") {
TetrisGame.mount(mountPoint, gameOpts);
}
@@ -2026,7 +1999,6 @@ function go(view, gameId){
if(gameId) s.selectedGame = gameId;
s.view = view;
s.notifOpen = false;
  s.notifNewIds = new Set();
if(view === "home") {
fetchLeaderboard();
fetchUserStats();
@@ -2259,11 +2231,11 @@ function setFilter(f){

// ================== THÔNG BÁO ==================
// Thông báo do DATABASE tự tạo (hoàn thành nhiệm vụ, lời mời kết bạn, thành tích...).
// Chuông ở thanh menu hiện số chưa đọc (bấm chuông -> về 0); frontend hỏi server mỗi 10 giây.
// Chuông ở thanh menu hiện số chưa đọc; frontend hỏi server mỗi 30 giây.
// QUAN TRỌNG: cập nhật chuông bằng cách thay đúng khối #notifWrap, KHÔNG gọi render()
// (render() dựng lại cả trang -> sẽ làm game đang chơi bị khởi động lại).

const NOTIF_POLL_MS = 10000;
const NOTIF_POLL_MS = 30000;
let notifPollTimer = null;

const NOTIF_ICONS = { quest: "🎯", achievement: "🏆", friend_request: "👥", system: "🔔" };
@@ -2282,24 +2254,25 @@ function notifTimeAgo(iso){
}

function notifBellHtml(){
  if (!s.notifOpen && s.notifSeen.size) s.notifSeen.clear(); // đóng panel -> hết tô sáng
const unread = s.notifUnread || 0;
const badge = unread ? `<span class="notif-badge">${unread > 99 ? "99+" : unread}</span>` : "";

let panel = "";
if (s.notifOpen) {
    const items = s.notifications.map(n => { const isNew = !n.is_read || s.notifNewIds.has(n.id); return `<div class="notif-item${isNew ? " unread" : ""}" onclick="onNotifClick(${Number(n.id)})">
    const isNew = (n) => !n.is_read || s.notifSeen.has(n.id);
    const items = s.notifications.map(n => `<div class="notif-item${isNew(n) ? " unread" : ""}" onclick="onNotifClick(${Number(n.id)})">
       <div class="notif-icon">${notifIcon(n.type)}</div>
       <div class="notif-body">
         <div class="notif-text">${esc(n.content)}</div>
         <div class="notif-time">${esc(notifTimeAgo(n.created_at))}</div>
       </div>
        ${isNew ? `<span class="notif-dot"></span>` : ""}
      </div>`; }).join("");
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
@@ -2323,21 +2296,27 @@ function refreshNotifUI(){
if (wrap) wrap.outerHTML = notifBellHtml();
}

function toggleNotifPanel(){
  s.notifOpen = !s.notifOpen;
  if (s.notifOpen) {
    // Mở chuông = đã xem: số đỏ về 0 ngay. Các thông báo mới vẫn được tô sáng trong panel.
    s.notifNewIds = new Set(s.notifications.filter(n => !n.is_read).map(n => n.id));
    s.notifications.forEach(n => { n.is_read = true; });
// Mở chuông = đã xem: số đỏ trên chuông về 0 (server cũng đánh dấu đã đọc). Thông báo mới đến sau đó
// lại hiện số mới. Trong panel, các thông báo vừa xem vẫn được tô sáng cho tới khi đóng panel.
function markNotifsSeen(){
  let any = false;
  s.notifications.forEach(n => {
    if (!n.is_read) { s.notifSeen.add(n.id); n.is_read = true; any = true; }
  });
  if (any || s.notifUnread) {
s.notifUnread = 0;
    refreshNotifUI();
    markAllNotifRead().then(() => fetchNotifications());
  } else {
    s.notifNewIds = new Set();
    refreshNotifUI();
    authFetch(`${API_URL}/notifications/read-all`, { method: "POST" })
      .catch(err => console.error("Lỗi đánh dấu đã đọc:", err));
}
}

async function toggleNotifPanel(){
  s.notifOpen = !s.notifOpen;
  if (s.notifOpen) markNotifsSeen();
  refreshNotifUI();
  if (s.notifOpen) await fetchNotifications();
}

async function fetchNotifications(fromQuests){
if (!s.token) return;
try {
@@ -2350,24 +2329,17 @@ async function fetchNotifications(fromQuests){
// Lần tải đầu tiên chỉ ghi nhớ mốc, không bật toast cho thông báo cũ.
const prevLastId = s.notifLastId;
s.notifLastId = Math.max(prevLastId || 0, maxId);
    // Panel đang mở: thông báo mới đến coi như đã xem luôn (số đỏ giữ ở 0).
    const unreadNow = data.unread || 0;
    if (s.notifOpen && unreadNow > 0) {
      list.forEach(n => { if (!n.is_read) { s.notifNewIds.add(n.id); n.is_read = true; } });
      markAllNotifRead();
    }
    const fresh = prevLastId !== null
      ? list.filter(n => n.id > prevLastId && !n.is_read).reverse().slice(-3)
      : [];
s.notifications = list;
    s.notifUnread = s.notifOpen ? 0 : unreadNow;
    s.notifUnread = data.unread || 0;
s.notifLoaded = true;
    if (s.notifOpen) markNotifsSeen(); // đang mở chuông mà có thông báo mới -> coi như đã xem luôn
refreshNotifUI();

if (prevLastId !== null) {
      const fresh = list.filter(n => n.id > prevLastId && (!n.is_read || s.notifNewIds.has(n.id))).reverse().slice(-3);
fresh.forEach(showNotifToast);
      // Có lời mời / phản hồi kết bạn mới -> làm mới danh sách bạn bè.
      if (fresh.some(n => n.type === "friend_request")) {
        fetchFriends().then(() => { if (s.view === "friends") render(); });
      }
// Đang ở trang Nhiệm vụ mà có nhiệm vụ mới hoàn thành -> làm mới danh sách.
if (!fromQuests && s.view === "quests" && fresh.some(n => n.type === "quest")) fetchQuests();
}
@@ -2401,7 +2373,6 @@ function stopNotifPolling(){
s.notifOpen = false;
s.notifLoaded = false;
s.notifLastId = null;
  s.notifNewIds = new Set();
}

async function markNotifReadOnServer(id){
@@ -2419,7 +2390,6 @@ function onNotifClick(id){
markNotifReadOnServer(id);
}
s.notifOpen = false;
  s.notifNewIds = new Set();
if (n.type === "quest") go("quests");
else if (n.type === "friend_request") go("friends");
else refreshNotifUI();
@@ -2428,7 +2398,6 @@ function onNotifClick(id){
async function markAllNotifRead(){
s.notifications.forEach(n => { n.is_read = true; });
s.notifUnread = 0;
  s.notifNewIds = new Set();
refreshNotifUI();
try {
await authFetch(`${API_URL}/notifications/read-all`, { method: "POST" });
@@ -2726,7 +2695,7 @@ function profileModalHtml({ loading, error, data } = {}){
const name = data.display_name || "Ẩn danh";
const ini = name.slice(0, 2).toUpperCase();
const tier = getRankTier(data.high_score);
    const achCards = buildAchievements(data.high_score, data.total_matches, data.rank).map(achievementCardHtml).join("");
    const achCards = badgesFor(data.badges).map(badgeCardHtml).join("");

body = `
     <section class="profile profile-modal-section">
