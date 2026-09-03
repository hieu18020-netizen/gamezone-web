from fastapi import FastAPI, HTTPException, Header, Depends, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from datetime import datetime, timedelta, timezone
from typing import Optional
import pyodbc
import bcrypt
import jwt
import time
import secrets
import re

app = FastAPI()

# ===== CORS =====
# Cho phép mọi domain gọi API (đủ dùng khi chạy trên máy cá nhân / qua Cloudflare Tunnel).
# allow_credentials=False vì app dùng token qua header Authorization, không dùng cookie —
# để True kèm allow_origins=["*"] sẽ khiến trình duyệt/Starlette không thêm được header CORS.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== Cấu hình xác thực (hash mật khẩu + token đăng nhập) =====
SECRET_KEY = "doi-chuoi-nay-thanh-mot-chuoi-ngau-nhien-that-dai-va-bi-mat"
ALGORITHM = "HS256"
TOKEN_EXPIRE_HOURS = 24 * 7  # token sống 7 ngày


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain_password: str, stored_value: str) -> bool:
    if not stored_value:
        return False
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), stored_value.encode("utf-8"))
    except ValueError:
        # stored_value không phải hash hợp lệ (dữ liệu cũ / lỗi định dạng)
        return False


def create_token(username: str) -> str:
    payload = {
        "sub": username,
        "exp": datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRE_HOURS),
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def get_current_username(authorization: str = Header(None)) -> str:
    """Đọc & xác thực token từ header 'Authorization: Bearer <token>'.
    Mọi API ghi dữ liệu (đổi nickname/avatar/điểm) đều phải đi qua hàm này,
    để KHÔNG tin vào username do client tự gửi lên nữa."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Thiếu token đăng nhập")
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload["sub"]
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Token không hợp lệ")

def get_optional_username(authorization: str = Header(None)) -> str | None:
    """Giống get_current_username nhưng KHÔNG bắt buộc phải có token —
    dùng cho các API công khai (leaderboard) muốn biết 'đây có phải dòng của tôi không'
    mà không bắt người xem phải đăng nhập."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except jwt.PyJWTError:
        return None

# ===== Chống gian lận điểm số =====
# Vấn đề: điểm số được TÍNH Ở FRONTEND (trình duyệt) rồi mới gửi lên server.
# Ai đó có thể mở Console (F12) và gọi thẳng submitScore(9999999) mà không cần chơi thật.
# Cách chặn: mỗi lần bắt đầu ván, server phát ra 1 "phiên chơi" (session_token) kèm thời điểm bắt đầu.
# Khi nộp điểm, server dùng token đó để tính thời gian đã chơi thật sự, rồi so điểm với
# 1 mức trần "hợp lý" theo thời gian đó — điểm quá cao so với thời gian chơi sẽ bị từ chối.
# Token dùng 1 lần (bị xoá ngay sau khi nộp điểm) để không bị gọi lại nhiều lần cho cùng 1 ván.
#
# GHI CHÚ: đây là lưu tạm trong RAM, đơn giản và đủ dùng cho 1 tiến trình uvicorn.
# Nếu sau này chạy nhiều worker/nhiều máy, cần chuyển sang lưu ở Redis/DB dùng chung.
ACTIVE_GAME_SESSIONS = {}  # session_token -> {"username": str, "start_time": float}

GAME_SESSION_TTL_SECONDS = 60 * 60   # phiên hết hạn sau 1 tiếng không nộp điểm
MIN_PLAY_SECONDS = 2                 # không thể có kết quả trong dưới 2 giây
MAX_SCORE_PER_SECOND = 1000          # mức trần RẤT rộng rãi, chơi giỏi cỡ nào cũng khó vượt qua


def _cleanup_expired_sessions():
    now = time.time()
    expired = [tok for tok, info in ACTIVE_GAME_SESSIONS.items()
               if now - info["start_time"] > GAME_SESSION_TTL_SECONDS]
    for tok in expired:
        ACTIVE_GAME_SESSIONS.pop(tok, None)

# Cấu hình kết nối SQL Server (chạy trên máy local, dùng Windows Auth)
DB_CONFIG = (
    "DRIVER={ODBC Driver 17 for SQL Server};"
    "SERVER=localhost;"
    "DATABASE=gamevui_db;"
    "Trusted_Connection=yes;"
)

def get_db_connection():
    try:
        conn = pyodbc.connect(DB_CONFIG)
        return conn
    except Exception as e:
        print(f"Lỗi kết nối CSDL: {e}")
        return None

# Chỉ cho phép tài khoản/mật khẩu không chứa khoảng trắng; mật khẩu bắt buộc có cả chữ và số.
USERNAME_RE = re.compile(r'^\S{8,}$')  # không khoảng trắng, tối thiểu 8 ký tự
PASSWORD_RE = re.compile(r'^(?=\S{8,}$)(?=.*[A-Za-z])(?=.*\d)\S+$')  # không khoảng trắng, tối thiểu 8 ký tự, có cả chữ và số

def generate_public_id(cursor) -> str:
    """Sinh 1 mã số 8 chữ số ngẫu nhiên, đảm bảo không trùng với ai đã có trong bảng users."""
    for _ in range(20):  # thử tối đa 20 lần, gần như không bao giờ cần tới vậy
        candidate = f"{secrets.randbelow(100_000_000):08d}"
        cursor.execute("SELECT id FROM users WHERE public_id = ?", (candidate,))
        if not cursor.fetchone():
            return candidate
    raise HTTPException(status_code=500, detail="Không thể tạo mã định danh, vui lòng thử lại")

class UserRegister(BaseModel):
    username: str
    password: str

class UserLogin(BaseModel):
    username: str
    password: str

class UpdateNickname(BaseModel):
    nickname: str

class UpdateAvatar(BaseModel):
    avatar: str  # chuỗi base64 dạng data URL, ví dụ "data:image/jpeg;base64,...."

class GameScore(BaseModel):
    score: int
    session_token: str

class SetActiveChibi(BaseModel):
    chibi_code: str    # mã chibi, vd "1" — khớp với code trong CHIBI_GALLERY ở frontend
    active: bool = True  # True = bật chibi này (thêm vào danh sách đang chạy), False = tắt (chỉ bỏ đúng chibi này, không đụng chibi khác)

@app.post("/api/register")
def register(user: UserRegister):
    if not USERNAME_RE.match(user.username):
        raise HTTPException(status_code=400, detail="Tên tài khoản không được chứa khoảng trắng và phải có ít nhất 8 ký tự")
    if not PASSWORD_RE.match(user.password):
        raise HTTPException(status_code=400, detail="Mật khẩu không được chứa khoảng trắng, tối thiểu 8 ký tự và phải có cả chữ và số")

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id FROM users WHERE username = ?", (user.username,))
        if cursor.fetchone():
            raise HTTPException(status_code=400, detail="Tên tài khoản đã tồn tại")

        public_id = generate_public_id(cursor)
        # Tài khoản mới mặc định dùng luôn chibi "1" (Eruka) -> đăng nhập lần đầu
        # là đã thấy chibi chạy trên màn hình, không cần vào trang Chibi bấm "Sử dụng".
        cursor.execute(
            "INSERT INTO users (username, password, high_score, total_matches, public_id, active_chibi_code) VALUES (?, ?, 0, 0, ?, ?)",
            (user.username, hash_password(user.password), public_id, "1")
        )
        conn.commit()
        return {"message": "Đăng ký thành công"}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi Register: {e}")
        raise HTTPException(status_code=500, detail="Lỗi hệ thống khi đăng ký")
    finally:
        conn.close()

@app.post("/api/login")
def login(user: UserLogin):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        cursor.execute(
            "SELECT username, password, nickname, avatar, active_chibi_code FROM users WHERE username = ?",
            (user.username,)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không đúng")

        stored_password = row[1] or ""
        is_hashed = stored_password.startswith("$2")  # chuỗi bcrypt luôn bắt đầu bằng $2

        if is_hashed:
            password_ok = verify_password(user.password, stored_password)
        else:
            # Tài khoản tạo từ trước khi vá lỗi: mật khẩu đang lưu thô.
            # So sánh trực tiếp 1 lần cuối, rồi nâng cấp lên hash ngay để không còn lưu thô nữa.
            password_ok = (stored_password == user.password)

        if not password_ok:
            raise HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không đúng")

        if not is_hashed:
            cursor.execute(
                "UPDATE users SET password = ? WHERE username = ?",
                (hash_password(user.password), row[0])
            )
            conn.commit()

        token = create_token(row[0])
        return {
            "username": row[0],
            "nickname": row[2] if row[2] else "",
            "avatar": row[3] if row[3] else "",
            # Các chibi đang được chọn từ lần trước (nếu chưa từng chọn thì rỗng -> frontend không chạy chibi nào cả)
            "active_chibi_codes": parse_active_chibis(row[4]),
            "token": token
        }
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi Login: {e}")
        raise HTTPException(status_code=500, detail="Lỗi hệ thống khi đăng nhập")
    finally:
        conn.close()

@app.post("/api/update-nickname")
def update_nickname(data: UpdateNickname, current_username: str = Depends(get_current_username)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        cursor.execute(
            "UPDATE users SET nickname = ? WHERE username = ?",
            (data.nickname, current_username)
        )
        conn.commit()
        return {"message": "Cập nhật bí danh thành công"}
    except Exception as e:
        print(f"Lỗi Update Nickname: {e}")
        raise HTTPException(status_code=500, detail="Lỗi cập nhật bí danh")
    finally:
        conn.close()

MAX_AVATAR_LENGTH = 2_000_000  # ~1.5MB ảnh gốc sau khi encode base64, đủ dùng cho avatar đã resize

# Chỉ chấp nhận đúng định dạng data URL ảnh: data:image/<loại>;base64,<dữ liệu base64>
# Việc này chặn mọi chuỗi lạ (ví dụ chứa dấu " hoặc thẻ HTML) bị lưu vào cột avatar,
# vì avatar sẽ được chèn thẳng vào trang leaderboard cho mọi người xem.
AVATAR_DATA_URL_RE = re.compile(r'^data:image/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$')

@app.post("/api/update-avatar")
def update_avatar(data: UpdateAvatar, current_username: str = Depends(get_current_username)):
    if data.avatar and len(data.avatar) > MAX_AVATAR_LENGTH:
        raise HTTPException(status_code=400, detail="Ảnh quá lớn, vui lòng chọn ảnh nhỏ hơn")
    if data.avatar and not AVATAR_DATA_URL_RE.match(data.avatar):
        raise HTTPException(status_code=400, detail="Định dạng ảnh đại diện không hợp lệ")

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT id FROM users WHERE username = ?", (current_username,))
        if not cursor.fetchone():
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        cursor.execute(
            "UPDATE users SET avatar = ? WHERE username = ?",
            (data.avatar, current_username)
        )
        conn.commit()
        return {"message": "Cập nhật ảnh đại diện thành công"}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi Update Avatar: {e}")
        raise HTTPException(status_code=500, detail="Lỗi cập nhật ảnh đại diện")
    finally:
        conn.close()

# Mã chibi chỉ gồm chữ/số, tối đa 30 ký tự — khớp với cột chibi_code (VARCHAR(30))
# và chặn luôn việc lỡ gửi giá trị lạ (vd chứa "/", "..") bị dùng để build đường dẫn ảnh ở frontend.
CHIBI_CODE_RE = re.compile(r'^[A-Za-z0-9_-]{1,30}$')

# Cột users.active_chibi_code giờ lưu NHIỀU mã chibi cùng lúc, ngăn cách bởi dấu phẩy
# (vd "1,2"), để nhiều chibi có thể cùng chạy song song trên màn hình. Dữ liệu cũ chỉ
# có 1 mã (vd "1") vẫn đọc đúng bình thường vì nó cũng là 1 danh sách 1 phần tử.
MAX_ACTIVE_CHIBIS = 8  # chặn 1 tài khoản bật cùng lúc quá nhiều chibi (vd gửi request giả)

def parse_active_chibis(raw):
    if not raw:
        return []
    return [c for c in raw.split(",") if c]

def serialize_active_chibis(codes):
    return ",".join(codes) if codes else None

@app.post("/api/set-active-chibi")
def set_active_chibi(data: SetActiveChibi, current_username: str = Depends(get_current_username)):
    """Bật hoặc tắt 1 chibi cụ thể trong danh sách chibi đang chạy trên màn hình
    (không đụng tới các chibi khác đang active) -> có thể có NHIỀU chibi cùng
    active 1 lúc. Lần đăng nhập kế tiếp, /api/login trả về active_chibi_codes
    (mảng) để frontend tự chạy lại đúng các chibi đó (xem chibi-runner.js +
    applyChibiRunnerState() trong app.js)."""
    code = data.chibi_code.strip()
    if not code or not CHIBI_CODE_RE.match(code):
        raise HTTPException(status_code=400, detail="Mã chibi không hợp lệ")

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT active_chibi_code FROM users WHERE username = ?", (current_username,))
        row = cursor.fetchone()
        codes = parse_active_chibis(row[0] if row else None)

        if data.active:
            if code not in codes:
                if len(codes) >= MAX_ACTIVE_CHIBIS:
                    raise HTTPException(status_code=400, detail="Đã đạt số lượng chibi tối đa có thể chạy cùng lúc")
                codes.append(code)
        else:
            codes = [c for c in codes if c != code]

        cursor.execute(
            "UPDATE users SET active_chibi_code = ? WHERE username = ?",
            (serialize_active_chibis(codes), current_username)
        )
        conn.commit()
        return {"active_chibi_codes": codes}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi Set Active Chibi: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi lưu chibi đang dùng")
    finally:
        conn.close()

@app.post("/api/start-game")
def start_game(current_username: str = Depends(get_current_username)):
    """Gọi API này ngay khi người chơi bắt đầu 1 ván mới.
    Trả về session_token để gửi kèm khi nộp điểm ở /api/update-score."""
    _cleanup_expired_sessions()
    session_token = secrets.token_hex(16)
    ACTIVE_GAME_SESSIONS[session_token] = {
        "username": current_username,
        "start_time": time.time()
    }
    return {"session_token": session_token}


@app.post("/api/update-score")
def update_score(data: GameScore, current_username: str = Depends(get_current_username)):
    # Token phiên chơi phải tồn tại, đúng chủ, và chỉ dùng được 1 lần (pop ra khỏi bộ nhớ ngay).
    session = ACTIVE_GAME_SESSIONS.pop(data.session_token, None)
    if not session or session["username"] != current_username:
        raise HTTPException(status_code=400, detail="Phiên chơi không hợp lệ hoặc đã hết hạn, vui lòng chơi lại từ đầu")

    elapsed_seconds = time.time() - session["start_time"]
    if elapsed_seconds < MIN_PLAY_SECONDS:
        raise HTTPException(status_code=400, detail="Kết quả không hợp lệ")

    max_allowed_score = elapsed_seconds * MAX_SCORE_PER_SECOND
    if data.score < 0 or data.score > max_allowed_score:
        raise HTTPException(status_code=400, detail="Điểm số không hợp lệ")

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        # Lấy high_score hiện tại của user
        cursor.execute("SELECT ISNULL(high_score, 0), ISNULL(total_matches, 0) FROM users WHERE username = ?", (current_username,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")
        
        current_high = row[0]
        current_matches = row[1]

        # Nếu điểm trận mới cao hơn điểm cao nhất cũ thì cập nhật high_score mới
        new_high = max(current_high, data.score)
        new_matches = current_matches + 1

        cursor.execute(
            "UPDATE users SET high_score = ?, total_matches = ? WHERE username = ?",
            (new_high, new_matches, current_username)
        )
        conn.commit()
        return {"message": "Cập nhật điểm thành công", "high_score": new_high}
    except Exception as e:
        print(f"Lỗi Update Score: {e}")
        raise HTTPException(status_code=500, detail="Lỗi lưu điểm số")
    finally:
        conn.close()

@app.get("/api/user-stats/{username}")
def get_user_stats(username: str):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        # "Thành tích" & thứ hạng tính theo TỔNG điểm = high_score (Tetris cao nhất) + chess_score (Cờ vua).
        rank_query = """
            SELECT rank_num FROM (
                SELECT username, ROW_NUMBER() OVER (ORDER BY (ISNULL(high_score, 0) + ISNULL(chess_score, 0)) DESC, id ASC) as rank_num
                FROM users
            ) as ranked_users
            WHERE username = ?
        """
        cursor.execute(rank_query, (username,))
        rank_row = cursor.fetchone()
        user_rank = rank_row[0] if rank_row else "-"

        cursor.execute(
            "SELECT ISNULL(total_matches, 0), (ISNULL(high_score, 0) + ISNULL(chess_score, 0)), avatar, public_id, active_chibi_code FROM users WHERE username = ?",
            (username,)
        )
        match_row = cursor.fetchone()
        total_matches = match_row[0] if match_row else 0
        high_score = match_row[1] if match_row else 0
        avatar = match_row[2] if match_row and match_row[2] else ""
        public_id = match_row[3] if match_row else None
        active_chibi_codes = parse_active_chibis(match_row[4] if match_row else None)

        # Tài khoản cũ (tạo trước khi có tính năng public_id) sẽ có giá trị NULL ở đây.
        # Tự sinh 1 mã mới và lưu lại vào CSDL luôn, để lần sau không còn bị "--------" nữa.
        if match_row and not public_id:
            public_id = generate_public_id(cursor)
            cursor.execute(
                "UPDATE users SET public_id = ? WHERE username = ?",
                (public_id, username)
            )
            conn.commit()
        if not public_id:
            public_id = "--------"

        return {
            "rank": f"#{user_rank}",
            "total_matches": total_matches,
            "high_score": high_score,
            "avatar": avatar,
            "public_id": public_id,
            "active_chibi_codes": active_chibi_codes
        }
    except Exception as e:
        print(f"Lỗi User Stats: {e}")
        raise HTTPException(status_code=500, detail="Lỗi lấy dữ liệu người dùng")
    finally:
        conn.close()

@app.get("/api/leaderboard")
def get_leaderboard(current_username: str = Depends(get_optional_username)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        query = """
            SELECT TOP 10 
                username,
                ISNULL(nickname, username) AS display_name, 
                (ISNULL(high_score, 0) + ISNULL(chess_score, 0)) AS score,
                avatar,
                public_id
            FROM users 
            ORDER BY score DESC, id ASC
        """
        cursor.execute(query)
        rows = cursor.fetchall()

        leaderboard = []
        for index, row in enumerate(rows, start=1):
            leaderboard.append({
                "rank": index,
                "username": row[1],
                "score": row[2],
                "avatar": row[3] if row[3] else "",
                "public_id": row[4] or "--------",
                # Không trả tên đăng nhập thật (row[0]) cho ai xem cũng thấy nữa.
                # Chỉ báo true/false cho đúng chủ tài khoản, dựa vào token của chính người gọi API.
                "is_me": bool(current_username) and row[0].lower() == current_username.lower()
            })
        return leaderboard
    except Exception as e:
        print(f"Lỗi Leaderboard: {e}")
        raise HTTPException(status_code=500, detail="Lỗi lấy bảng xếp hạng")
    finally:
        conn.close()

# ===== Tìm kiếm người chơi & xem hồ sơ công khai =====
# Chỉ trả về bí danh (nickname/username hiển thị) + public_id, KHÔNG trả username đăng nhập thật,
# giống cách /api/leaderboard đã làm, để không lộ tài khoản đăng nhập của người khác.

@app.get("/api/search-users")
def search_users(q: str = ""):
    query = (q or "").strip()
    if not query:
        return []

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT TOP 8
                ISNULL(nickname, username) AS display_name,
                (ISNULL(high_score, 0) + ISNULL(chess_score, 0)) AS score,
                avatar,
                public_id
            FROM users
            WHERE ISNULL(nickname, username) LIKE ?
               OR public_id LIKE ?
            ORDER BY score DESC, id ASC
            """,
            (f"%{query}%", f"%{query}%")
        )
        rows = cursor.fetchall()
        return [
            {
                "display_name": row[0],
                "high_score": row[1],
                "avatar": row[2] if row[2] else "",
                "public_id": row[3] or "--------",
            }
            for row in rows
        ]
    except Exception as e:
        print(f"Lỗi Search Users: {e}")
        raise HTTPException(status_code=500, detail="Lỗi tìm kiếm người chơi")
    finally:
        conn.close()


@app.get("/api/profile/{public_id}")
def get_profile_by_public_id(public_id: str, current_username: str | None = Depends(get_optional_username)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        cursor.execute(
            """
            SELECT rank_num, display_name, score, avatar, public_id FROM (
                SELECT
                    ISNULL(nickname, username) AS display_name,
                    (ISNULL(high_score, 0) + ISNULL(chess_score, 0)) AS score,
                    avatar,
                    public_id,
                    ROW_NUMBER() OVER (ORDER BY (ISNULL(high_score, 0) + ISNULL(chess_score, 0)) DESC, id ASC) as rank_num
                FROM users
            ) as ranked_users
            WHERE public_id = ?
            """,
            (public_id,)
        )
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")

        cursor.execute("SELECT ISNULL(total_matches, 0), id FROM users WHERE public_id = ?", (public_id,))
        match_row = cursor.fetchone()
        total_matches = match_row[0] if match_row else 0
        target_id = match_row[1] if match_row else None

        # Chỉ tính quan hệ kết bạn khi người xem đã đăng nhập; khách vãng lai xem hồ sơ bình thường,
        # không thấy trạng thái kết bạn (frontend sẽ ẩn nút kết bạn khi friend_status là null).
        friend_status = None
        if current_username and target_id is not None:
            my_id = _get_user_id(cursor, current_username)
            if my_id is not None:
                friend_status = _get_friend_status(cursor, my_id, target_id)

        return {
            "display_name": row[1],
            "high_score": row[2],
            "avatar": row[3] if row[3] else "",
            "public_id": row[4],
            "rank": f"#{row[0]}",
            "total_matches": total_matches,
            "friend_status": friend_status,
        }
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi Profile: {e}")
        raise HTTPException(status_code=500, detail="Lỗi lấy hồ sơ người chơi")
    finally:
        conn.close()


# ===== Kết bạn =====
# Cần tạo bảng "friends" trong CSDL trước khi dùng tính năng này (chạy 1 lần trong SSMS):
#
#   CREATE TABLE friends (
#       id INT IDENTITY(1,1) PRIMARY KEY,
#       requester_id INT NOT NULL FOREIGN KEY REFERENCES users(id),
#       addressee_id INT NOT NULL FOREIGN KEY REFERENCES users(id),
#       status VARCHAR(10) NOT NULL DEFAULT 'pending',  -- 'pending' | 'accepted'
#       created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
#       CONSTRAINT UQ_friend_pair UNIQUE (requester_id, addressee_id)
#   );
#
# Mỗi cặp người dùng chỉ có tối đa 1 dòng (không phân biệt ai là người gửi trước),
# nên mọi truy vấn đều phải kiểm tra cả 2 chiều (requester_id, addressee_id).

class FriendRespond(BaseModel):
    action: str  # "accept" | "decline"


def _get_user_id(cursor, username: str):
    cursor.execute("SELECT id FROM users WHERE username = ?", (username,))
    row = cursor.fetchone()
    return row[0] if row else None


def _get_user_by_public_id(cursor, public_id: str):
    cursor.execute("SELECT id, username FROM users WHERE public_id = ?", (public_id,))
    row = cursor.fetchone()
    return (row[0], row[1]) if row else None


def _get_friend_status(cursor, my_id: int, target_id: int):
    """Trả về quan hệ kết bạn giữa 2 người, đứng từ góc nhìn của my_id."""
    if my_id == target_id:
        return "self"
    cursor.execute(
        "SELECT requester_id, status FROM friends "
        "WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)",
        (my_id, target_id, target_id, my_id)
    )
    row = cursor.fetchone()
    if not row:
        return "none"
    requester_id, status = row
    if status == "accepted":
        return "friends"
    return "pending_sent" if requester_id == my_id else "pending_received"


@app.post("/api/friends/request/{public_id}")
def send_friend_request(public_id: str, current_username: str = Depends(get_current_username)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        my_id = _get_user_id(cursor, current_username)
        if not my_id:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        target = _get_user_by_public_id(cursor, public_id)
        if not target:
            raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")
        target_id, _ = target

        if target_id == my_id:
            raise HTTPException(status_code=400, detail="Không thể tự kết bạn với chính mình")

        cursor.execute(
            "SELECT requester_id, status FROM friends "
            "WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)",
            (my_id, target_id, target_id, my_id)
        )
        existing = cursor.fetchone()
        if existing:
            ex_requester, ex_status = existing
            if ex_status == "accepted":
                raise HTTPException(status_code=400, detail="Hai người đã là bạn bè")
            if ex_requester == my_id:
                raise HTTPException(status_code=400, detail="Bạn đã gửi lời mời kết bạn trước đó")
            # Đối phương đã gửi lời mời cho mình trước đó -> chấp nhận luôn, không tạo dòng mới.
            cursor.execute(
                "UPDATE friends SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?",
                (target_id, my_id)
            )
            conn.commit()
            return {"message": "Đã chấp nhận lời mời kết bạn", "friend_status": "friends"}

        cursor.execute(
            "INSERT INTO friends (requester_id, addressee_id, status) VALUES (?, ?, 'pending')",
            (my_id, target_id)
        )
        conn.commit()
        return {"message": "Đã gửi lời mời kết bạn", "friend_status": "pending_sent"}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi gửi lời mời kết bạn: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi gửi lời mời kết bạn")
    finally:
        conn.close()


@app.post("/api/friends/respond/{public_id}")
def respond_friend_request(public_id: str, data: FriendRespond, current_username: str = Depends(get_current_username)):
    action = (data.action or "").strip().lower()
    if action not in ("accept", "decline"):
        raise HTTPException(status_code=400, detail="Hành động không hợp lệ")

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        my_id = _get_user_id(cursor, current_username)
        if not my_id:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        target = _get_user_by_public_id(cursor, public_id)
        if not target:
            raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")
        target_id, _ = target

        cursor.execute(
            "SELECT status FROM friends WHERE requester_id = ? AND addressee_id = ?",
            (target_id, my_id)
        )
        row = cursor.fetchone()
        if not row or row[0] != "pending":
            raise HTTPException(status_code=404, detail="Không có lời mời kết bạn nào từ người này")

        if action == "accept":
            cursor.execute(
                "UPDATE friends SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?",
                (target_id, my_id)
            )
            conn.commit()
            return {"message": "Đã chấp nhận kết bạn", "friend_status": "friends"}
        else:
            cursor.execute(
                "DELETE FROM friends WHERE requester_id = ? AND addressee_id = ?",
                (target_id, my_id)
            )
            conn.commit()
            return {"message": "Đã từ chối lời mời kết bạn", "friend_status": "none"}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi phản hồi lời mời kết bạn: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi phản hồi lời mời kết bạn")
    finally:
        conn.close()


@app.delete("/api/friends/{public_id}")
def remove_friend(public_id: str, current_username: str = Depends(get_current_username)):
    """Huỷ kết bạn (đã là bạn), hoặc huỷ lời mời đã gửi/đã nhận — dùng chung 1 API."""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        my_id = _get_user_id(cursor, current_username)
        if not my_id:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        target = _get_user_by_public_id(cursor, public_id)
        if not target:
            raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")
        target_id, _ = target

        cursor.execute(
            "DELETE FROM friends WHERE (requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?)",
            (my_id, target_id, target_id, my_id)
        )
        conn.commit()
        return {"message": "Đã huỷ kết bạn", "friend_status": "none"}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi huỷ kết bạn: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi huỷ kết bạn")
    finally:
        conn.close()


@app.get("/api/friends")
def list_friends(current_username: str = Depends(get_current_username)):
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        my_id = _get_user_id(cursor, current_username)
        if not my_id:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        def _rows_to_list(rows):
            return [
                {
                    "public_id": r[0],
                    "display_name": r[1],
                    "high_score": r[2],
                    "avatar": r[3] if r[3] else "",
                }
                for r in rows
            ]

        # Bạn bè (đã chấp nhận cả 2 chiều)
        cursor.execute(
            """
            SELECT u.public_id, ISNULL(u.nickname, u.username), (ISNULL(u.high_score,0)+ISNULL(u.chess_score,0)), u.avatar
            FROM friends f
            JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
            WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
            ORDER BY ISNULL(u.nickname, u.username)
            """,
            (my_id, my_id, my_id)
        )
        friends = _rows_to_list(cursor.fetchall())

        # Lời mời người khác gửi cho mình, đang chờ phản hồi
        cursor.execute(
            """
            SELECT u.public_id, ISNULL(u.nickname, u.username), (ISNULL(u.high_score,0)+ISNULL(u.chess_score,0)), u.avatar
            FROM friends f
            JOIN users u ON u.id = f.requester_id
            WHERE f.addressee_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
            """,
            (my_id,)
        )
        incoming = _rows_to_list(cursor.fetchall())

        # Lời mời mình đã gửi, đang chờ đối phương phản hồi
        cursor.execute(
            """
            SELECT u.public_id, ISNULL(u.nickname, u.username), (ISNULL(u.high_score,0)+ISNULL(u.chess_score,0)), u.avatar
            FROM friends f
            JOIN users u ON u.id = f.addressee_id
            WHERE f.requester_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
            """,
            (my_id,)
        )
        outgoing = _rows_to_list(cursor.fetchall())

        return {"friends": friends, "incoming": incoming, "outgoing": outgoing}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi lấy danh sách bạn bè: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi lấy danh sách bạn bè")
    finally:
        conn.close()


# ===== Nhắn tin (Messenger) =====
# Cần tạo thêm bảng "messages" trong CSDL trước khi dùng tính năng này (chạy 1 lần trong SSMS,
# nhớ USE đúng database gamevui_db trước khi chạy — xem hướng dẫn ở phần "Kết bạn" phía trên):
#
#   CREATE TABLE messages (
#       id INT IDENTITY(1,1) PRIMARY KEY,
#       sender_id INT NOT NULL FOREIGN KEY REFERENCES users(id),
#       receiver_id INT NOT NULL FOREIGN KEY REFERENCES users(id),
#       content NVARCHAR(2000) NOT NULL,
#       created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
#       is_read BIT NOT NULL DEFAULT 0
#   );
#   CREATE INDEX IX_messages_conversation ON messages(sender_id, receiver_id, created_at);
#
# Chỉ cho phép nhắn tin giữa 2 người ĐÃ LÀ BẠN BÈ (dùng lại bảng "friends" ở trên để kiểm tra),
# giống Messenger/Zalo: không ai nhắn được cho người lạ.
#
# Gửi tin nhắn đi qua REST (POST) để đảm bảo lưu CSDL chắc chắn trước, sau đó nếu người nhận
# đang mở app (có kết nối WebSocket /api/ws/messages) thì đẩy tin nhắn realtime cho họ ngay,
# không cần họ tự bấm F5 hay đợi polling.

# username -> danh sách WebSocket đang mở (1 người có thể mở nhiều tab/thiết bị cùng lúc)
ONLINE_MESSAGE_SOCKETS: dict[str, list[WebSocket]] = {}


async def _push_to_user(username: str, payload: dict):
    """Đẩy 1 sự kiện realtime (tin nhắn mới...) tới tất cả kết nối đang mở của 1 người dùng.
    Nếu người đó không online (không có kết nối nào) thì bỏ qua — họ sẽ thấy khi mở app /
    tải lại danh sách hội thoại, tin nhắn vẫn nằm an toàn trong CSDL."""
    conns = ONLINE_MESSAGE_SOCKETS.get(username, [])
    dead = []
    for ws in conns:
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        if ws in conns:
            conns.remove(ws)
    if username in ONLINE_MESSAGE_SOCKETS and not ONLINE_MESSAGE_SOCKETS[username]:
        ONLINE_MESSAGE_SOCKETS.pop(username, None)


def _iso(dt) -> str:
    try:
        return dt.isoformat()
    except Exception:
        return str(dt)


class SendMessage(BaseModel):
    content: str


@app.websocket("/api/ws/messages")
async def messages_ws(websocket: WebSocket, token: str = ""):
    """Kênh realtime riêng của mỗi người dùng, dùng để nhận tin nhắn mới ngay khi có.
    Trình duyệt (WebSocket API) không tự set được header Authorization, nên token được
    truyền qua query string: /api/ws/messages?token=<jwt>."""
    await websocket.accept()
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username = payload["sub"]
    except jwt.PyJWTError:
        await websocket.send_json({"type": "auth_error"})
        await websocket.close()
        return

    ONLINE_MESSAGE_SOCKETS.setdefault(username, []).append(websocket)
    try:
        while True:
            # Không cần xử lý dữ liệu từ client — kênh này chỉ dùng để server đẩy tin xuống.
            # receive_text() ở đây chỉ để phát hiện khi nào client ngắt kết nối.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        conns = ONLINE_MESSAGE_SOCKETS.get(username)
        if conns and websocket in conns:
            conns.remove(websocket)
        if conns is not None and not conns:
            ONLINE_MESSAGE_SOCKETS.pop(username, None)


@app.get("/api/messages/conversations")
def list_conversations(current_username: str = Depends(get_current_username)):
    """Danh sách hội thoại = tất cả bạn bè, kèm tin nhắn gần nhất (nếu có) và số tin chưa đọc."""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        my_id = _get_user_id(cursor, current_username)
        if not my_id:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        cursor.execute(
            """
            SELECT
                u.public_id,
                ISNULL(u.nickname, u.username),
                u.avatar,
                lm.content,
                lm.created_at,
                lm.sender_id,
                ISNULL((
                    SELECT COUNT(*) FROM messages um
                    WHERE um.sender_id = u.id AND um.receiver_id = ? AND um.is_read = 0
                ), 0) AS unread
            FROM friends f
            JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
            OUTER APPLY (
                SELECT TOP 1 content, created_at, sender_id
                FROM messages m
                WHERE (m.sender_id = u.id AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = u.id)
                ORDER BY m.created_at DESC
            ) lm
            WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
            ORDER BY ISNULL(lm.created_at, CAST('1900-01-01' AS DATETIME2)) DESC
            """,
            (my_id, my_id, my_id, my_id, my_id, my_id)
        )
        rows = cursor.fetchall()
        conversations = []
        for r in rows:
            conversations.append({
                "public_id": r[0],
                "display_name": r[1],
                "avatar": r[2] if r[2] else "",
                "last_message": r[3],
                "last_message_at": _iso(r[4]) if r[4] else None,
                "last_message_is_mine": (r[5] == my_id) if r[5] is not None else None,
                "unread_count": r[6] or 0,
            })
        return conversations
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi lấy danh sách hội thoại: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi lấy danh sách hội thoại")
    finally:
        conn.close()


@app.get("/api/messages/{public_id}")
def get_conversation(public_id: str, before_id: Optional[int] = None, limit: int = 50,
                      current_username: str = Depends(get_current_username)):
    """Lấy lịch sử tin nhắn với 1 người bạn (mới nhất trước, rồi đảo lại theo thứ tự tăng dần).
    Đồng thời đánh dấu đã đọc mọi tin đối phương gửi cho mình trong hội thoại này."""
    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        my_id = _get_user_id(cursor, current_username)
        if not my_id:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        target = _get_user_by_public_id(cursor, public_id)
        if not target:
            raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")
        target_id, _ = target

        if _get_friend_status(cursor, my_id, target_id) != "friends":
            raise HTTPException(status_code=403, detail="Chỉ có thể xem tin nhắn với bạn bè")

        safe_limit = max(1, min(int(limit or 50), 100))
        query = """
            SELECT TOP (?) id, sender_id, content, created_at
            FROM messages
            WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
        """
        params = [safe_limit, my_id, target_id, target_id, my_id]
        if before_id:
            query += " AND id < ?"
            params.append(before_id)
        query += " ORDER BY id DESC"
        cursor.execute(query, params)
        rows = cursor.fetchall()

        messages = [
            {"id": r[0], "is_mine": r[1] == my_id, "content": r[2], "created_at": _iso(r[3])}
            for r in rows
        ]
        messages.reverse()  # trả về theo thứ tự thời gian tăng dần cho FE dễ render

        cursor.execute(
            "UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0",
            (target_id, my_id)
        )
        conn.commit()

        return {"messages": messages, "has_more": len(rows) == safe_limit}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi lấy lịch sử tin nhắn: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi lấy lịch sử tin nhắn")
    finally:
        conn.close()


@app.post("/api/messages/{public_id}")
async def send_message(public_id: str, data: SendMessage, current_username: str = Depends(get_current_username)):
    content = (data.content or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Nội dung tin nhắn không được để trống")
    if len(content) > 2000:
        raise HTTPException(status_code=400, detail="Tin nhắn quá dài (tối đa 2000 ký tự)")

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        my_id = _get_user_id(cursor, current_username)
        if not my_id:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")

        target = _get_user_by_public_id(cursor, public_id)
        if not target:
            raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")
        target_id, target_username = target

        if target_id == my_id:
            raise HTTPException(status_code=400, detail="Không thể tự nhắn tin cho chính mình")
        if _get_friend_status(cursor, my_id, target_id) != "friends":
            raise HTTPException(status_code=403, detail="Chỉ có thể nhắn tin với bạn bè")

        cursor.execute(
            "INSERT INTO messages (sender_id, receiver_id, content) OUTPUT INSERTED.id, INSERTED.created_at VALUES (?, ?, ?)",
            (my_id, target_id, content)
        )
        inserted = cursor.fetchone()
        conn.commit()
        message_id, created_at = inserted[0], inserted[1]

        cursor.execute("SELECT ISNULL(nickname, username), avatar, public_id FROM users WHERE id = ?", (my_id,))
        me_row = cursor.fetchone()
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"Lỗi gửi tin nhắn: {e}")
        raise HTTPException(status_code=500, detail="Lỗi khi gửi tin nhắn")
    finally:
        conn.close()

    created_at_iso = _iso(created_at)
    await _push_to_user(target_username, {
        "type": "new_message",
        "public_id": me_row[2],
        "display_name": me_row[0],
        "avatar": me_row[1] if me_row[1] else "",
        "content": content,
        "created_at": created_at_iso,
        "message_id": message_id,
    })

    return {"message_id": message_id, "created_at": created_at_iso}


# ===== Phòng đấu Stickman / Cờ vua (game 1vs1 qua mạng) =====
# Server ở đây chỉ đóng vai trò "relay" (chuyển tiếp) — không tính toán vật lý/damage/luật cờ.
# Mỗi máy tự chạy game của mình rồi gửi trạng thái (vị trí, đòn đánh, nước đi...) cho máy còn lại
# qua đúng room_code, để cả 2 màn hình luôn đồng bộ. Dữ liệu chỉ lưu tạm trong RAM,
# phòng sẽ tự bị xoá khi cả 2 người đều rời đi.
DUEL_ROOMS: dict[str, list[WebSocket]] = {}

# ===== Sảnh chờ (danh sách phòng đang mở, chưa đủ người) =====
# Khi một người bấm "Tạo phòng", server tự sinh mã phòng (id) rồi lưu tạm ở đây để
# những người khác thấy trong sảnh. Khi phòng đủ 2 người (bắt đầu chơi) hoặc người tạo
# rời đi trước khi có ai vào, phòng sẽ tự biến mất khỏi sảnh.
LOBBY_ROOMS: dict[str, dict] = {}
LOBBY_ROOM_TTL_SECONDS = 15 * 60  # dọn rác nếu phòng mở quá lâu mà không ai vào


class CreateDuelRoom(BaseModel):
    game: str = "chess"
    creator_name: str = "Ẩn danh"


def _generate_room_code() -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # bỏ ký tự dễ nhầm (0/O, 1/I...)
    while True:
        code = "".join(secrets.choice(alphabet) for _ in range(6))
        if code not in DUEL_ROOMS and code not in LOBBY_ROOMS:
            return code


def _purge_stale_lobby_rooms():
    now = time.time()
    stale = [code for code, info in LOBBY_ROOMS.items() if now - info["created_at"] > LOBBY_ROOM_TTL_SECONDS]
    for code in stale:
        LOBBY_ROOMS.pop(code, None)


@app.post("/api/duel/create-room")
async def create_duel_room(payload: CreateDuelRoom):
    """Server tự sinh mã phòng (id) cho người tạo, rồi đăng phòng lên sảnh chờ."""
    _purge_stale_lobby_rooms()
    game = (payload.game or "chess").strip()[:20] or "chess"
    creator_name = (payload.creator_name or "Ẩn danh").strip()[:30] or "Ẩn danh"
    room_code = _generate_room_code()
    LOBBY_ROOMS[room_code] = {
        "game": game,
        "creator_name": creator_name,
        "created_at": time.time(),
    }
    return {"room_code": room_code}


@app.get("/api/duel/rooms")
async def list_duel_rooms(game: Optional[str] = None):
    """Danh sách phòng đang mở (chờ đối thủ) để hiển thị trong sảnh."""
    _purge_stale_lobby_rooms()
    rooms = [
        {"room_code": code, "game": info["game"], "creator_name": info["creator_name"], "created_at": info["created_at"]}
        for code, info in LOBBY_ROOMS.items()
        if not game or info["game"] == game
    ]
    rooms.sort(key=lambda r: r["created_at"], reverse=True)
    return rooms


@app.websocket("/api/ws/duel/{room_code}")
async def duel_room(websocket: WebSocket, room_code: str):
    room_code = (room_code or "").strip().upper()[:12]
    await websocket.accept()

    room = DUEL_ROOMS.setdefault(room_code, [])
    if len(room) >= 2:
        # Phòng đã đủ 2 người, từ chối người thứ 3.
        await websocket.send_json({"type": "room_full"})
        await websocket.close()
        return

    room.append(websocket)
    role = len(room)  # 1 = người tạo phòng, 2 = người vào sau
    await websocket.send_json({"type": "role", "role": role})

    if len(room) == 2:
        # Đủ người rồi -> ẩn phòng khỏi sảnh chờ, không cho người thứ 3 thấy nữa.
        LOBBY_ROOMS.pop(room_code, None)
        for ws in room:
            await ws.send_json({"type": "start"})

    try:
        while True:
            data = await websocket.receive_text()
            # Chuyển tiếp nguyên văn tin nhắn (di chuyển, đòn đánh, máu...) cho người còn lại.
            for ws in room:
                if ws is not websocket:
                    try:
                        await ws.send_text(data)
                    except Exception:
                        pass
    except WebSocketDisconnect:
        pass
    finally:
        if websocket in room:
            room.remove(websocket)
        for ws in room:
            try:
                await ws.send_json({"type": "opponent_left"})
            except Exception:
                pass
        if not room and room_code in DUEL_ROOMS:
            del DUEL_ROOMS[room_code]
        # Người tạo rời đi trước khi có ai vào -> phòng không còn hợp lệ, gỡ khỏi sảnh chờ.
        LOBBY_ROOMS.pop(room_code, None)


# ===== Tính điểm thắng/thua Cờ vua =====
# Ai thắng +100 điểm, ai thua -100 điểm (hoà thì không đổi) vào cột chess_score.
# Mỗi ván cờ hợp lệ (thắng, thua, hoặc hoà) đều +1 vào total_matches cho CẢ 2 người chơi,
# giống cách Tetris tính "Số trận đã chơi" ở API /api/update-score.
# "Thành tích" hiển thị & dùng để xếp hạng trên toàn hệ thống = high_score (điểm Tetris cao nhất) + chess_score.
#
# Chống gian lận cơ bản: điểm CHỈ được cộng/trừ khi CẢ HAI người chơi trong cùng 1 phòng đều tự báo cáo
# kết quả (qua API có token đăng nhập) và 2 báo cáo đó khớp nhau (1 thắng - 1 thua, hoặc cả 2 hoà).
# Nếu chỉ 1 người báo hoặc 2 người báo mâu thuẫn nhau thì KHÔNG tính điểm cho ai cả.
# Lưu ý: đây chỉ là chống gian lận ở mức cơ bản (chưa việt xác thực lại toàn bộ nước đi ở server),
# nên không loại trừ hoàn toàn trường hợp 2 tài khoản tự dàn xếp trận đấu với nhau.
CHESS_SCORE_DELTA = 100
CHESS_ROOM_REPORTS: dict[str, dict] = {}  # room_code -> {username: {"result": str, "ts": float}}
CHESS_REPORT_TTL_SECONDS = 30 * 60  # dọn rác nếu chỉ 1 bên báo cáo rồi bỏ đi, không quay lại nữa


class ChessMatchResult(BaseModel):
    room_code: str
    result: str  # "win" | "loss" | "draw"


def _purge_stale_chess_reports():
    now = time.time()
    stale_rooms = []
    for room_code, reports in CHESS_ROOM_REPORTS.items():
        if all(now - r["ts"] > CHESS_REPORT_TTL_SECONDS for r in reports.values()):
            stale_rooms.append(room_code)
    for room_code in stale_rooms:
        CHESS_ROOM_REPORTS.pop(room_code, None)


@app.post("/api/chess/report-result")
def report_chess_result(data: ChessMatchResult, current_username: str = Depends(get_current_username)):
    _purge_stale_chess_reports()

    room_code = (data.room_code or "").strip().upper()[:12]
    result = (data.result or "").strip().lower()
    if not room_code:
        raise HTTPException(status_code=400, detail="Thiếu mã phòng")
    if result not in ("win", "loss", "draw"):
        raise HTTPException(status_code=400, detail="Kết quả không hợp lệ")

    reports = CHESS_ROOM_REPORTS.setdefault(room_code, {})
    reports[current_username] = {"result": result, "ts": time.time()}

    # Chưa đủ 2 người báo cáo -> chỉ ghi nhận, chờ đối thủ báo cáo nốt.
    if len(reports) < 2:
        return {"message": "Đã ghi nhận, đang chờ xác nhận từ đối thủ", "applied": False}

    usernames = list(reports.keys())
    r1, r2 = reports[usernames[0]]["result"], reports[usernames[1]]["result"]
    consistent = (
        (r1 == "win" and r2 == "loss") or
        (r1 == "loss" and r2 == "win") or
        (r1 == "draw" and r2 == "draw")
    )

    # Dùng 1 lần rồi xoá, tránh báo cáo lại nhiều lần để cộng điểm khống.
    final_reports = dict(reports)
    CHESS_ROOM_REPORTS.pop(room_code, None)

    if not consistent:
        return {"message": "Kết quả 2 người chơi báo cáo không khớp nhau, không tính điểm", "applied": False}

    conn = get_db_connection()
    if not conn:
        raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")
    cursor = conn.cursor()
    try:
        for uname, info in final_reports.items():
            if info["result"] == "win":
                delta = CHESS_SCORE_DELTA
            elif info["result"] == "loss":
                delta = -CHESS_SCORE_DELTA
            else:
                delta = 0
            cursor.execute(
                "UPDATE users SET chess_score = ISNULL(chess_score, 0) + ?, total_matches = ISNULL(total_matches, 0) + 1 WHERE username = ?",
                (delta, uname)
            )
        conn.commit()
        my_delta = CHESS_SCORE_DELTA if result == "win" else (-CHESS_SCORE_DELTA if result == "loss" else 0)
        return {"message": "Đã cập nhật điểm cờ vua", "applied": True, "delta": my_delta}
    except Exception as e:
        print(f"Lỗi cập nhật điểm cờ vua: {e}")
        raise HTTPException(status_code=500, detail="Lỗi lưu điểm cờ vua")
    finally:
        conn.close()


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)