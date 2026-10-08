"""
GameZone backend — FastAPI + SQL Server, viết theo hướng đối tượng trong 1 file.

Cách đọc file này (từ trên xuống, mỗi phần là 1 nhóm class):
  1. Settings                      : toàn bộ cấu hình
  2. Repository (UserRepository...) : nơi DUY NHẤT chứa câu SQL
  3. Database                      : mở/đóng kết nối, commit/rollback
  4. PasswordHasher, TokenService, Authenticator : mật khẩu & đăng nhập
  5. Schemas                       : dữ liệu client gửi lên
  6. Services (Auth/User/Friend/Message/Quest) : nghiệp vụ
  7. ConnectionManager, DuelHub    : WebSocket realtime
  8. GameService, ChessService     : điểm Tetris & cờ vua
  9. GameZoneAPI                   : gắn mọi thứ thành các đường dẫn /api/...

Chạy:  python -m uvicorn backend:app --reload --port 5000
"""
import os
import re
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from contextlib import contextmanager
from typing import Optional

import bcrypt
import jwt
import pyodbc
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


# ======================================================================
# 1. CẤU HÌNH
# ======================================================================
@dataclass(frozen=True)
class Settings:
    # Xác thực (nên đặt biến môi trường GAMEZONE_SECRET_KEY; giữ mặc định thì token cũ vẫn dùng được)
    secret_key: str = os.getenv(
        "GAMEZONE_SECRET_KEY",
        "doi-chuoi-nay-thanh-mot-chuoi-ngau-nhien-that-dai-va-bi-mat",
    )
    jwt_algorithm: str = "HS256"
    token_expire_hours: int = 24 * 7

    # SQL Server (Windows Auth, chạy local)
    db_connection_string: str = (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        "SERVER=localhost;"
        "DATABASE=gamevui_db;"
        "Trusted_Connection=yes;"
    )

    # Luật đăng ký
    username_pattern: re.Pattern = re.compile(r"^\S{8,}$")
    password_pattern: re.Pattern = re.compile(r"^(?=\S{8,}$)(?=.*[A-Za-z])(?=.*\d)\S+$")

    # Avatar: chỉ nhận data URL ảnh, chặn chuỗi lạ bị chèn vào trang xếp hạng
    max_avatar_length: int = 2_000_000
    avatar_pattern: re.Pattern = re.compile(r"^data:image/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$")

    # Chibi
    chibi_code_pattern: re.Pattern = re.compile(r"^[A-Za-z0-9_-]{1,30}$")
    default_chibi_code: str = "1"
    max_active_chibis: int = 8

    # Chống gian lận điểm Tetris
    game_session_ttl_seconds: int = 60 * 60
    min_play_seconds: int = 2
    max_score_per_second: int = 1000

    # Phòng đấu & cờ vua
    lobby_room_ttl_seconds: int = 15 * 60
    chess_report_ttl_seconds: int = 30 * 60
    chess_score_delta: int = 100


settings = Settings()

NO_PUBLIC_ID = "--------"
TOTAL_SCORE = "(ISNULL(high_score, 0) + ISNULL(chess_score, 0))"      # điểm Tetris + cờ vua
TOTAL_SCORE_U = "(ISNULL(u.high_score, 0) + ISNULL(u.chess_score, 0))"


# ======================================================================
# 2. REPOSITORY — mọi câu SQL nằm ở đây
# ======================================================================
class BaseRepository:
    def __init__(self, cursor):
        self.cursor = cursor

    def _one(self, sql, *params):
        self.cursor.execute(sql, params)
        return self.cursor.fetchone()

    def _all(self, sql, *params):
        self.cursor.execute(sql, params)
        return self.cursor.fetchall()

    def _run(self, sql, *params):
        self.cursor.execute(sql, params)


class UserRepository(BaseRepository):
    """Bảng users."""

    # --- tìm kiếm cơ bản ---
    def exists(self, username):
        return self._one("SELECT id FROM users WHERE username = ?", username) is not None

    def get_id(self, username):
        row = self._one("SELECT id FROM users WHERE username = ?", username)
        return row.id if row else None

    def require_id(self, username):
        user_id = self.get_id(username)
        if user_id is None:
            raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")
        return user_id

    def require_by_public_id(self, public_id):
        row = self._one("SELECT id, username FROM users WHERE public_id = ?", public_id)
        if not row:
            raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")
        return row

    def get_card(self, user_id):
        return self._one(
            "SELECT ISNULL(nickname, username) AS display_name, avatar, public_id FROM users WHERE id = ?",
            user_id,
        )

    # --- tạo tài khoản / đăng nhập ---
    def new_public_id(self):
        for _ in range(20):
            candidate = f"{secrets.randbelow(100_000_000):08d}"
            if not self._one("SELECT id FROM users WHERE public_id = ?", candidate):
                return candidate
        raise HTTPException(status_code=500, detail="Không thể tạo mã định danh, vui lòng thử lại")

    def create(self, username, password_hash, public_id, active_chibi_code):
        self._run(
            "INSERT INTO users (username, password, high_score, total_matches, public_id, active_chibi_code) "
            "VALUES (?, ?, 0, 0, ?, ?)",
            username, password_hash, public_id, active_chibi_code,
        )

    def find_for_login(self, username):
        return self._one(
            "SELECT username, password, nickname, avatar, active_chibi_code FROM users WHERE username = ?",
            username,
        )

    def set_password(self, username, password_hash):
        self._run("UPDATE users SET password = ? WHERE username = ?", password_hash, username)

    # --- hồ sơ ---
    def set_nickname(self, username, nickname):
        self._run("UPDATE users SET nickname = ? WHERE username = ?", nickname, username)

    def set_avatar(self, username, avatar):
        self._run("UPDATE users SET avatar = ? WHERE username = ?", avatar, username)

    def set_public_id(self, username, public_id):
        self._run("UPDATE users SET public_id = ? WHERE username = ?", public_id, username)

    def get_active_chibis_raw(self, username):
        row = self._one("SELECT active_chibi_code FROM users WHERE username = ?", username)
        return row.active_chibi_code if row else None

    def set_active_chibis_raw(self, username, raw):
        self._run("UPDATE users SET active_chibi_code = ? WHERE username = ?", raw, username)

    # --- điểm số ---
    def get_play_stats(self, username):
        return self._one(
            "SELECT ISNULL(high_score, 0) AS high_score, ISNULL(total_matches, 0) AS total_matches "
            "FROM users WHERE username = ?",
            username,
        )

    def save_play_stats(self, username, high_score, total_matches):
        self._run(
            "UPDATE users SET high_score = ?, total_matches = ? WHERE username = ?",
            high_score, total_matches, username,
        )

    def add_chess_result(self, username, delta):
        self._run(
            "UPDATE users SET chess_score = ISNULL(chess_score, 0) + ?, "
            "total_matches = ISNULL(total_matches, 0) + 1 WHERE username = ?",
            delta, username,
        )

    # --- thống kê / xếp hạng ---
    def rank_of(self, username):
        row = self._one(
            f"""
            SELECT rank_num FROM (
                SELECT username, ROW_NUMBER() OVER (ORDER BY {TOTAL_SCORE} DESC, id ASC) AS rank_num
                FROM users
            ) AS ranked_users
            WHERE username = ?
            """,
            username,
        )
        return row.rank_num if row else None

    def get_stats(self, username):
        return self._one(
            f"SELECT ISNULL(total_matches, 0) AS total_matches, {TOTAL_SCORE} AS score, "
            "avatar, public_id, active_chibi_code FROM users WHERE username = ?",
            username,
        )

    def top(self, limit=10):
        return self._all(
            f"""
            SELECT TOP {int(limit)}
                username, ISNULL(nickname, username) AS display_name,
                {TOTAL_SCORE} AS score, avatar, public_id
            FROM users
            ORDER BY score DESC, id ASC
            """
        )

    def search(self, text, limit=8):
        like = f"%{text}%"
        return self._all(
            f"""
            SELECT TOP {int(limit)}
                ISNULL(nickname, username) AS display_name,
                {TOTAL_SCORE} AS score, avatar, public_id
            FROM users
            WHERE ISNULL(nickname, username) LIKE ? OR public_id LIKE ?
            ORDER BY score DESC, id ASC
            """,
            like, like,
        )

    def profile_by_public_id(self, public_id):
        return self._one(
            f"""
            SELECT id, rank_num, display_name, score, avatar, public_id, total_matches FROM (
                SELECT
                    id,
                    ISNULL(nickname, username) AS display_name,
                    {TOTAL_SCORE} AS score,
                    avatar, public_id,
                    ISNULL(total_matches, 0) AS total_matches,
                    ROW_NUMBER() OVER (ORDER BY {TOTAL_SCORE} DESC, id ASC) AS rank_num
                FROM users
            ) AS ranked_users
            WHERE public_id = ?
            """,
            public_id,
        )


class FriendRepository(BaseRepository):
    """Bảng friends. Mỗi cặp người chỉ có 1 dòng nên mọi truy vấn kiểm tra cả 2 chiều."""

    _PAIR = "((requester_id = ? AND addressee_id = ?) OR (requester_id = ? AND addressee_id = ?))"

    def relation(self, a_id, b_id):
        return self._one(
            f"SELECT requester_id, status FROM friends WHERE {self._PAIR}", a_id, b_id, b_id, a_id
        )

    def status_between(self, my_id, target_id):
        """self | none | friends | pending_sent | pending_received (nhìn từ my_id)."""
        if my_id == target_id:
            return "self"
        row = self.relation(my_id, target_id)
        if not row:
            return "none"
        if row.status == "accepted":
            return "friends"
        return "pending_sent" if row.requester_id == my_id else "pending_received"

    def create_request(self, requester_id, addressee_id):
        self._run(
            "INSERT INTO friends (requester_id, addressee_id, status) VALUES (?, ?, 'pending')",
            requester_id, addressee_id,
        )

    def pending_status(self, requester_id, addressee_id):
        row = self._one(
            "SELECT status FROM friends WHERE requester_id = ? AND addressee_id = ?",
            requester_id, addressee_id,
        )
        return row.status if row else None

    def accept(self, requester_id, addressee_id):
        self._run(
            "UPDATE friends SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?",
            requester_id, addressee_id,
        )

    def delete_request(self, requester_id, addressee_id):
        self._run(
            "DELETE FROM friends WHERE requester_id = ? AND addressee_id = ?",
            requester_id, addressee_id,
        )

    def delete_pair(self, a_id, b_id):
        self._run(f"DELETE FROM friends WHERE {self._PAIR}", a_id, b_id, b_id, a_id)

    def list_friends(self, my_id):
        return self._all(
            f"""
            SELECT u.public_id, ISNULL(u.nickname, u.username) AS display_name,
                   {TOTAL_SCORE_U} AS score, u.avatar
            FROM friends f
            JOIN users u ON u.id = CASE WHEN f.requester_id = ? THEN f.addressee_id ELSE f.requester_id END
            WHERE (f.requester_id = ? OR f.addressee_id = ?) AND f.status = 'accepted'
            ORDER BY ISNULL(u.nickname, u.username)
            """,
            my_id, my_id, my_id,
        )

    def list_incoming(self, my_id):
        return self._all(
            f"""
            SELECT u.public_id, ISNULL(u.nickname, u.username) AS display_name,
                   {TOTAL_SCORE_U} AS score, u.avatar
            FROM friends f JOIN users u ON u.id = f.requester_id
            WHERE f.addressee_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
            """,
            my_id,
        )

    def list_outgoing(self, my_id):
        return self._all(
            f"""
            SELECT u.public_id, ISNULL(u.nickname, u.username) AS display_name,
                   {TOTAL_SCORE_U} AS score, u.avatar
            FROM friends f JOIN users u ON u.id = f.addressee_id
            WHERE f.requester_id = ? AND f.status = 'pending'
            ORDER BY f.created_at DESC
            """,
            my_id,
        )


class MessageRepository(BaseRepository):
    """Bảng messages."""

    def conversations(self, my_id):
        return self._all(
            """
            SELECT
                u.public_id,
                ISNULL(u.nickname, u.username) AS display_name,
                u.avatar,
                lm.content AS last_message,
                lm.created_at AS last_message_at,
                lm.sender_id AS last_sender_id,
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
            my_id, my_id, my_id, my_id, my_id, my_id,
        )

    def history(self, my_id, target_id, limit, before_id=None):
        sql = (
            "SELECT TOP (?) id, sender_id, content, created_at FROM messages "
            "WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))"
        )
        params = [limit, my_id, target_id, target_id, my_id]
        if before_id:
            sql += " AND id < ?"
            params.append(before_id)
        sql += " ORDER BY id DESC"
        return self._all(sql, *params)

    def mark_read(self, sender_id, receiver_id):
        self._run(
            "UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0",
            sender_id, receiver_id,
        )

    def insert(self, sender_id, receiver_id, content):
        row = self._one(
            "INSERT INTO messages (sender_id, receiver_id, content) "
            "OUTPUT INSERTED.id, INSERTED.created_at VALUES (?, ?, ?)",
            sender_id, receiver_id, content,
        )
        return row[0], row[1]


class QuestRepository(BaseRepository):
    """Bảng quests (định nghĩa nhiệm vụ) và user_quests (ai đã hoàn thành)."""

    def list_quests(self):
        return self._all(
            "SELECT id, code, title, description, icon, metric, target FROM quests ORDER BY sort_order, id"
        )

    def metrics(self, username):
        """Các chỉ số của người chơi, đọc thẳng từ CSDL để đối chiếu với mốc nhiệm vụ."""
        return self._one(
            """
            SELECT
                ISNULL(u.total_matches, 0) AS matches,
                ISNULL(u.high_score, 0)    AS high_score,
                ISNULL(u.chess_score, 0)   AS chess_score,
                (SELECT COUNT(*) FROM friends f
                  WHERE (f.requester_id = u.id OR f.addressee_id = u.id) AND f.status = 'accepted') AS friends,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS messages_sent,
                CASE WHEN ISNULL(u.nickname, '') <> '' AND ISNULL(u.avatar, '') <> '' THEN 1 ELSE 0 END AS profile_complete,
                CASE WHEN ISNULL(u.active_chibi_code, '') <> '' THEN 1 ELSE 0 END AS chibi_active
            FROM users u WHERE u.username = ?
            """,
            username,
        )

    def completed(self, user_id):
        return self._all("SELECT quest_id, completed_at FROM user_quests WHERE user_id = ?", user_id)

    def mark_completed(self, user_id, quest_id):
        self._run(
            "IF NOT EXISTS (SELECT 1 FROM user_quests WHERE user_id = ? AND quest_id = ?) "
            "INSERT INTO user_quests (user_id, quest_id) VALUES (?, ?)",
            user_id, quest_id, user_id, quest_id,
        )


class Repositories:
    """Gom các repository dùng chung 1 cursor (= cùng 1 giao dịch)."""

    def __init__(self, cursor):
        self.users = UserRepository(cursor)
        self.friends = FriendRepository(cursor)
        self.messages = MessageRepository(cursor)
        self.quests = QuestRepository(cursor)


# ======================================================================
# 3. DATABASE
# ======================================================================
class Database:
    def __init__(self, connection_string: str):
        self._connection_string = connection_string

    @contextmanager
    def session(self):
        """Dùng:  with db.session() as repo:  repo.users.xxx() ...
        Thoát bình thường -> commit | có lỗi -> rollback.
        HTTPException (400, 404...) giữ nguyên; lỗi bất ngờ khác -> ghi log, trả 500 chung."""
        try:
            conn = pyodbc.connect(self._connection_string)
        except Exception as e:
            print(f"Lỗi kết nối CSDL: {e}")
            raise HTTPException(status_code=500, detail="Không thể kết nối CSDL")

        try:
            yield Repositories(conn.cursor())
            conn.commit()
        except HTTPException:
            conn.rollback()
            raise
        except Exception as e:
            conn.rollback()
            print(f"Lỗi CSDL: {e!r}")
            raise HTTPException(status_code=500, detail="Lỗi hệ thống, vui lòng thử lại")
        finally:
            conn.close()


# ======================================================================
# 4. MẬT KHẨU & ĐĂNG NHẬP
# ======================================================================
class PasswordHasher:
    def hash(self, password: str) -> str:
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    def verify(self, plain_password: str, stored_value: str) -> bool:
        if not stored_value:
            return False
        try:
            return bcrypt.checkpw(plain_password.encode("utf-8"), stored_value.encode("utf-8"))
        except ValueError:
            return False

    @staticmethod
    def is_hashed(stored_value: str) -> bool:
        return bool(stored_value) and stored_value.startswith("$2")  # bcrypt luôn bắt đầu bằng $2


class TokenService:
    def __init__(self, config: Settings):
        self._config = config

    def create(self, username: str) -> str:
        payload = {
            "sub": username,
            "exp": datetime.now(timezone.utc) + timedelta(hours=self._config.token_expire_hours),
        }
        return jwt.encode(payload, self._config.secret_key, algorithm=self._config.jwt_algorithm)

    def decode(self, token: str) -> str:
        """Trả về username; ném jwt.PyJWTError nếu token sai/hết hạn."""
        payload = jwt.decode(token, self._config.secret_key, algorithms=[self._config.jwt_algorithm])
        return payload["sub"]


class Authenticator:
    """Hai 'cổng' xác thực dùng với Depends(...) trong route."""

    def __init__(self, tokens: TokenService):
        self.tokens = tokens

    @staticmethod
    def _bearer(authorization: Optional[str]) -> Optional[str]:
        if not authorization or not authorization.startswith("Bearer "):
            return None
        return authorization.split(" ", 1)[1]

    def require_user(self, authorization: str = Header(None)) -> str:
        """BẮT BUỘC đăng nhập. Username lấy từ token, không tin client tự gửi."""
        token = self._bearer(authorization)
        if not token:
            raise HTTPException(status_code=401, detail="Thiếu token đăng nhập")
        try:
            return self.tokens.decode(token)
        except jwt.ExpiredSignatureError:
            raise HTTPException(status_code=401, detail="Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại")
        except jwt.InvalidTokenError:
            raise HTTPException(status_code=401, detail="Token không hợp lệ")

    def optional_user(self, authorization: str = Header(None)) -> Optional[str]:
        """Route công khai nhưng muốn biết người xem là ai nếu họ có đăng nhập."""
        token = self._bearer(authorization)
        if not token:
            return None
        try:
            return self.tokens.decode(token)
        except jwt.PyJWTError:
            return None


hasher = PasswordHasher()
tokens = TokenService(settings)
authenticator = Authenticator(tokens)
CurrentUser = Depends(authenticator.require_user)
OptionalUser = Depends(authenticator.optional_user)


# ======================================================================
# 5. SCHEMAS (dữ liệu client gửi lên)
# ======================================================================
class Credentials(BaseModel):
    username: str
    password: str


class UpdateNickname(BaseModel):
    nickname: str


class UpdateAvatar(BaseModel):
    avatar: str  # data URL base64


class GameScore(BaseModel):
    score: int
    session_token: str


class SetActiveChibi(BaseModel):
    chibi_code: str
    active: bool = True  # True = bật, False = chỉ tắt đúng chibi này


class FriendRespond(BaseModel):
    action: str  # "accept" | "decline"


class SendMessage(BaseModel):
    content: str


class CreateDuelRoom(BaseModel):
    game: str = "chess"
    creator_name: str = "Ẩn danh"


class ChessMatchResult(BaseModel):
    room_code: str
    result: str  # "win" | "loss" | "draw"


# ======================================================================
# 6. SERVICES (nghiệp vụ) — không viết SQL, không biết gì về đường dẫn HTTP
# ======================================================================
def to_iso(dt) -> str:
    try:
        return dt.isoformat()
    except Exception:
        return str(dt)


class ChibiList:
    """Cột users.active_chibi_code lưu nhiều mã cách nhau bằng dấu phẩy, vd "1,2"."""

    @staticmethod
    def parse(raw) -> list[str]:
        return [c for c in raw.split(",") if c] if raw else []

    @staticmethod
    def serialize(codes: list[str]) -> Optional[str]:
        return ",".join(codes) if codes else None


class AuthService:
    def __init__(self, db: Database, config: Settings, hasher: PasswordHasher, tokens: TokenService):
        self.db, self.config, self.hasher, self.tokens = db, config, hasher, tokens

    def register(self, username: str, password: str) -> dict:
        if not self.config.username_pattern.match(username):
            raise HTTPException(status_code=400, detail="Tên tài khoản không được chứa khoảng trắng và phải có ít nhất 8 ký tự")
        if not self.config.password_pattern.match(password):
            raise HTTPException(status_code=400, detail="Mật khẩu không được chứa khoảng trắng, tối thiểu 8 ký tự và phải có cả chữ và số")

        with self.db.session() as repo:
            if repo.users.exists(username):
                raise HTTPException(status_code=400, detail="Tên tài khoản đã tồn tại")
            repo.users.create(
                username,
                self.hasher.hash(password),
                repo.users.new_public_id(),
                self.config.default_chibi_code,
            )
        return {"message": "Đăng ký thành công"}

    def login(self, username: str, password: str) -> dict:
        wrong = HTTPException(status_code=401, detail="Tên đăng nhập hoặc mật khẩu không đúng")

        with self.db.session() as repo:
            user = repo.users.find_for_login(username)
            if not user:
                raise wrong

            stored = user.password or ""
            if self.hasher.is_hashed(stored):
                password_ok = self.hasher.verify(password, stored)
            else:
                # Tài khoản cũ lưu mật khẩu thô: so sánh 1 lần rồi nâng cấp lên hash.
                password_ok = stored == password
                if password_ok:
                    repo.users.set_password(user.username, self.hasher.hash(password))
            if not password_ok:
                raise wrong

        return {
            "username": user.username,
            "nickname": user.nickname or "",
            "avatar": user.avatar or "",
            "active_chibi_codes": ChibiList.parse(user.active_chibi_code),
            "token": self.tokens.create(user.username),
        }


class UserService:
    """Hồ sơ cá nhân, bảng xếp hạng, tìm kiếm, chibi."""

    def __init__(self, db: Database, config: Settings):
        self.db, self.config = db, config

    def update_nickname(self, username: str, nickname: str) -> dict:
        with self.db.session() as repo:
            repo.users.set_nickname(username, nickname)
        return {"message": "Cập nhật bí danh thành công"}

    def update_avatar(self, username: str, avatar: str) -> dict:
        if avatar and len(avatar) > self.config.max_avatar_length:
            raise HTTPException(status_code=400, detail="Ảnh quá lớn, vui lòng chọn ảnh nhỏ hơn")
        if avatar and not self.config.avatar_pattern.match(avatar):
            raise HTTPException(status_code=400, detail="Định dạng ảnh đại diện không hợp lệ")

        with self.db.session() as repo:
            repo.users.require_id(username)
            repo.users.set_avatar(username, avatar)
        return {"message": "Cập nhật ảnh đại diện thành công"}

    def set_active_chibi(self, username: str, chibi_code: str, active: bool) -> dict:
        code = chibi_code.strip()
        if not code or not self.config.chibi_code_pattern.match(code):
            raise HTTPException(status_code=400, detail="Mã chibi không hợp lệ")

        with self.db.session() as repo:
            codes = ChibiList.parse(repo.users.get_active_chibis_raw(username))
            if active:
                if code not in codes:
                    if len(codes) >= self.config.max_active_chibis:
                        raise HTTPException(status_code=400, detail="Đã đạt số lượng chibi tối đa có thể chạy cùng lúc")
                    codes.append(code)
            else:
                codes = [c for c in codes if c != code]
            repo.users.set_active_chibis_raw(username, ChibiList.serialize(codes))
        return {"active_chibi_codes": codes}

    def stats(self, username: str) -> dict:
        with self.db.session() as repo:
            rank = repo.users.rank_of(username)
            row = repo.users.get_stats(username)

            public_id = row.public_id if row else None
            if row and not public_id:
                # Tài khoản cũ chưa có public_id -> tự sinh và lưu lại.
                public_id = repo.users.new_public_id()
                repo.users.set_public_id(username, public_id)

        return {
            "rank": f"#{rank if rank is not None else '-'}",
            "total_matches": row.total_matches if row else 0,
            "high_score": row.score if row else 0,
            "avatar": (row.avatar or "") if row else "",
            "public_id": public_id or NO_PUBLIC_ID,
            "active_chibi_codes": ChibiList.parse(row.active_chibi_code) if row else [],
        }

    def leaderboard(self, viewer: Optional[str]) -> list[dict]:
        with self.db.session() as repo:
            rows = repo.users.top(10)
        # Không trả tên đăng nhập thật; chỉ báo is_me cho đúng chủ tài khoản.
        return [
            {
                "rank": index,
                "username": row.display_name,
                "score": row.score,
                "avatar": row.avatar or "",
                "public_id": row.public_id or NO_PUBLIC_ID,
                "is_me": bool(viewer) and row.username.lower() == viewer.lower(),
            }
            for index, row in enumerate(rows, start=1)
        ]

    def search(self, text: str) -> list[dict]:
        text = (text or "").strip()
        if not text:
            return []
        with self.db.session() as repo:
            rows = repo.users.search(text)
        return [
            {
                "display_name": row.display_name,
                "high_score": row.score,
                "avatar": row.avatar or "",
                "public_id": row.public_id or NO_PUBLIC_ID,
            }
            for row in rows
        ]

    def public_profile(self, public_id: str, viewer: Optional[str]) -> dict:
        with self.db.session() as repo:
            row = repo.users.profile_by_public_id(public_id)
            if not row:
                raise HTTPException(status_code=404, detail="Không tìm thấy người chơi")

            # Khách chưa đăng nhập vẫn xem được hồ sơ, chỉ không có trạng thái kết bạn.
            friend_status = None
            if viewer:
                my_id = repo.users.get_id(viewer)
                if my_id is not None:
                    friend_status = repo.friends.status_between(my_id, row.id)

        return {
            "display_name": row.display_name,
            "high_score": row.score,
            "avatar": row.avatar or "",
            "public_id": row.public_id,
            "rank": f"#{row.rank_num}",
            "total_matches": row.total_matches,
            "friend_status": friend_status,
        }


class FriendService:
    def __init__(self, db: Database):
        self.db = db

    @staticmethod
    def _resolve(repo, username: str, public_id: str):
        """Trả về (id của mình, id đối phương)."""
        return repo.users.require_id(username), repo.users.require_by_public_id(public_id).id

    def send_request(self, username: str, public_id: str) -> dict:
        with self.db.session() as repo:
            my_id, target_id = self._resolve(repo, username, public_id)
            if target_id == my_id:
                raise HTTPException(status_code=400, detail="Không thể tự kết bạn với chính mình")

            existing = repo.friends.relation(my_id, target_id)
            if existing:
                if existing.status == "accepted":
                    raise HTTPException(status_code=400, detail="Hai người đã là bạn bè")
                if existing.requester_id == my_id:
                    raise HTTPException(status_code=400, detail="Bạn đã gửi lời mời kết bạn trước đó")
                # Đối phương đã mời mình từ trước -> chấp nhận luôn.
                repo.friends.accept(target_id, my_id)
                return {"message": "Đã chấp nhận lời mời kết bạn", "friend_status": "friends"}

            repo.friends.create_request(my_id, target_id)
        return {"message": "Đã gửi lời mời kết bạn", "friend_status": "pending_sent"}

    def respond(self, username: str, public_id: str, action: str) -> dict:
        action = (action or "").strip().lower()
        if action not in ("accept", "decline"):
            raise HTTPException(status_code=400, detail="Hành động không hợp lệ")

        with self.db.session() as repo:
            my_id, target_id = self._resolve(repo, username, public_id)
            if repo.friends.pending_status(target_id, my_id) != "pending":
                raise HTTPException(status_code=404, detail="Không có lời mời kết bạn nào từ người này")

            if action == "accept":
                repo.friends.accept(target_id, my_id)
                return {"message": "Đã chấp nhận kết bạn", "friend_status": "friends"}
            repo.friends.delete_request(target_id, my_id)
        return {"message": "Đã từ chối lời mời kết bạn", "friend_status": "none"}

    def remove(self, username: str, public_id: str) -> dict:
        """Huỷ kết bạn, hoặc huỷ lời mời đã gửi/nhận."""
        with self.db.session() as repo:
            my_id, target_id = self._resolve(repo, username, public_id)
            repo.friends.delete_pair(my_id, target_id)
        return {"message": "Đã huỷ kết bạn", "friend_status": "none"}

    def overview(self, username: str) -> dict:
        def to_dicts(rows):
            return [
                {"public_id": r.public_id, "display_name": r.display_name,
                 "high_score": r.score, "avatar": r.avatar or ""}
                for r in rows
            ]

        with self.db.session() as repo:
            my_id = repo.users.require_id(username)
            return {
                "friends": to_dicts(repo.friends.list_friends(my_id)),
                "incoming": to_dicts(repo.friends.list_incoming(my_id)),
                "outgoing": to_dicts(repo.friends.list_outgoing(my_id)),
            }


class QuestService:
    """Nhiệm vụ: mỗi lần mở danh sách, server đối chiếu chỉ số THẬT trong CSDL với mốc của từng
    nhiệm vụ. Nhiệm vụ nào vừa đạt thì ghi vào user_quests và giữ mãi (kể cả sau này chỉ số tụt)."""

    METRICS = {"matches", "high_score", "chess_score", "friends",
               "messages_sent", "profile_complete", "chibi_active"}

    def __init__(self, db: Database):
        self.db = db

    def list_for(self, username: str) -> dict:
        with self.db.session() as repo:
            user_id = repo.users.require_id(username)
            quests = repo.quests.list_quests()
            metrics = repo.quests.metrics(username)
            done = {r.quest_id: r.completed_at for r in repo.quests.completed(user_id)}

            items = []
            for q in quests:
                value = int(getattr(metrics, q.metric, 0) or 0) if q.metric in self.METRICS else 0
                if q.id not in done and value >= q.target:
                    repo.quests.mark_completed(user_id, q.id)  # vừa hoàn thành -> lưu lại
                    done[q.id] = datetime.now(timezone.utc)
                items.append({
                    "code": q.code,
                    "title": q.title,
                    "description": q.description,
                    "icon": q.icon,
                    "progress": q.target if q.id in done else max(0, min(value, q.target)),
                    "target": q.target,
                    "completed": q.id in done,
                    "completed_at": to_iso(done[q.id]) if q.id in done else None,
                })
        return {"completed_count": sum(1 for i in items if i["completed"]),
                "total": len(items), "quests": items}


# ======================================================================
# 7. REALTIME (WebSocket)
# ======================================================================
class ConnectionManager:
    """Quản lý các kết nối WebSocket nhận tin nhắn (1 người có thể mở nhiều tab)."""

    def __init__(self):
        self._sockets: dict[str, list[WebSocket]] = {}

    def add(self, username: str, websocket: WebSocket):
        self._sockets.setdefault(username, []).append(websocket)

    def remove(self, username: str, websocket: WebSocket):
        conns = self._sockets.get(username)
        if conns and websocket in conns:
            conns.remove(websocket)
        if conns is not None and not conns:
            self._sockets.pop(username, None)

    async def push(self, username: str, payload: dict):
        """Đẩy sự kiện tới mọi kết nối đang mở của 1 người; không online thì bỏ qua
        (tin vẫn nằm an toàn trong CSDL)."""
        for ws in list(self._sockets.get(username, [])):
            try:
                await ws.send_json(payload)
            except Exception:
                self.remove(username, ws)


class MessageService:
    """Chỉ cho nhắn tin giữa 2 người ĐÃ LÀ BẠN. Lưu CSDL trước, rồi đẩy realtime."""

    MAX_LENGTH = 2000

    def __init__(self, db: Database, connections: ConnectionManager):
        self.db, self.connections = db, connections

    def conversations(self, username: str) -> list[dict]:
        with self.db.session() as repo:
            my_id = repo.users.require_id(username)
            rows = repo.messages.conversations(my_id)
        return [
            {
                "public_id": r.public_id,
                "display_name": r.display_name,
                "avatar": r.avatar or "",
                "last_message": r.last_message,
                "last_message_at": to_iso(r.last_message_at) if r.last_message_at else None,
                "last_message_is_mine": (r.last_sender_id == my_id) if r.last_sender_id is not None else None,
                "unread_count": r.unread or 0,
            }
            for r in rows
        ]

    def history(self, username: str, public_id: str, before_id: Optional[int], limit: int) -> dict:
        with self.db.session() as repo:
            my_id = repo.users.require_id(username)
            target_id = repo.users.require_by_public_id(public_id).id
            if repo.friends.status_between(my_id, target_id) != "friends":
                raise HTTPException(status_code=403, detail="Chỉ có thể xem tin nhắn với bạn bè")

            safe_limit = max(1, min(int(limit or 50), 100))
            rows = repo.messages.history(my_id, target_id, safe_limit, before_id)
            repo.messages.mark_read(target_id, my_id)

        messages = [
            {"id": r.id, "is_mine": r.sender_id == my_id, "content": r.content, "created_at": to_iso(r.created_at)}
            for r in rows
        ]
        messages.reverse()  # thứ tự thời gian tăng dần cho frontend dễ render
        return {"messages": messages, "has_more": len(rows) == safe_limit}

    def _save(self, username: str, public_id: str, content: str):
        with self.db.session() as repo:
            my_id = repo.users.require_id(username)
            target = repo.users.require_by_public_id(public_id)
            if target.id == my_id:
                raise HTTPException(status_code=400, detail="Không thể tự nhắn tin cho chính mình")
            if repo.friends.status_between(my_id, target.id) != "friends":
                raise HTTPException(status_code=403, detail="Chỉ có thể nhắn tin với bạn bè")

            message_id, created_at = repo.messages.insert(my_id, target.id, content)
            sender = repo.users.get_card(my_id)
        return message_id, to_iso(created_at), target.username, sender

    async def send(self, username: str, public_id: str, content: str) -> dict:
        content = (content or "").strip()
        if not content:
            raise HTTPException(status_code=400, detail="Nội dung tin nhắn không được để trống")
        if len(content) > self.MAX_LENGTH:
            raise HTTPException(status_code=400, detail=f"Tin nhắn quá dài (tối đa {self.MAX_LENGTH} ký tự)")

        message_id, created_at, target_username, sender = await run_in_threadpool(
            self._save, username, public_id, content
        )
        await self.connections.push(target_username, {
            "type": "new_message",
            "public_id": sender.public_id,
            "display_name": sender.display_name,
            "avatar": sender.avatar or "",
            "content": content,
            "created_at": created_at,
            "message_id": message_id,
        })
        return {"message_id": message_id, "created_at": created_at}


class DuelHub:
    """Phòng đấu 1vs1 (Stickman / Cờ vua). Server chỉ chuyển tiếp tin giữa 2 máy,
    không tính luật. Dữ liệu lưu tạm trong RAM; phòng tự xoá khi cả 2 rời đi."""

    ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # bỏ ký tự dễ nhầm (0/O, 1/I...)

    def __init__(self, lobby_ttl_seconds: int):
        self.lobby_ttl = lobby_ttl_seconds
        self._rooms: dict[str, list[WebSocket]] = {}   # đang kết nối WebSocket
        self._lobby: dict[str, dict] = {}              # phòng đang chờ đối thủ (hiện ở sảnh)

    # --- sảnh chờ ---
    def _purge_stale_lobby(self):
        now = time.time()
        for code in [c for c, info in self._lobby.items() if now - info["created_at"] > self.lobby_ttl]:
            self._lobby.pop(code, None)

    def _new_code(self) -> str:
        while True:
            code = "".join(secrets.choice(self.ALPHABET) for _ in range(6))
            if code not in self._rooms and code not in self._lobby:
                return code

    def create_lobby_room(self, game: str, creator_name: str) -> str:
        self._purge_stale_lobby()
        code = self._new_code()
        self._lobby[code] = {
            "game": (game or "chess").strip()[:20] or "chess",
            "creator_name": (creator_name or "Ẩn danh").strip()[:30] or "Ẩn danh",
            "created_at": time.time(),
        }
        return code

    def list_lobby_rooms(self, game: Optional[str]) -> list[dict]:
        self._purge_stale_lobby()
        rooms = [
            {"room_code": code, **info}
            for code, info in self._lobby.items()
            if not game or info["game"] == game
        ]
        rooms.sort(key=lambda r: r["created_at"], reverse=True)
        return rooms

    # --- phòng đang chơi ---
    async def serve(self, websocket: WebSocket, room_code: str):
        room_code = (room_code or "").strip().upper()[:12]
        await websocket.accept()

        room = self._rooms.setdefault(room_code, [])
        if len(room) >= 2:
            await websocket.send_json({"type": "room_full"})
            await websocket.close()
            return

        room.append(websocket)
        await websocket.send_json({"type": "role", "role": len(room)})  # 1 = người tạo, 2 = người vào sau

        if len(room) == 2:
            self._lobby.pop(room_code, None)  # đủ người -> ẩn khỏi sảnh
            for ws in room:
                await ws.send_json({"type": "start"})

        try:
            while True:
                data = await websocket.receive_text()
                for ws in room:  # chuyển tiếp nguyên văn cho người còn lại
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
            if not room:
                self._rooms.pop(room_code, None)
            self._lobby.pop(room_code, None)  # người tạo rời trước khi có ai vào


# ======================================================================
# 8. ĐIỂM SỐ
# ======================================================================
class GameService:
    """Điểm Tetris + chống gian lận: server phát 'phiên chơi' lúc bắt đầu ván, khi nộp điểm
    thì so điểm với mức trần hợp lý theo thời gian chơi thật. Token dùng 1 lần.
    (Lưu trong RAM, đủ cho 1 tiến trình uvicorn; nhiều worker thì cần Redis/DB.)"""

    def __init__(self, db: Database, config: Settings):
        self.db, self.config = db, config
        self._sessions: dict[str, dict] = {}  # session_token -> {"username", "start_time"}

    def _purge_expired(self):
        now = time.time()
        for tok in [t for t, s in self._sessions.items() if now - s["start_time"] > self.config.game_session_ttl_seconds]:
            self._sessions.pop(tok, None)

    def start(self, username: str) -> dict:
        self._purge_expired()
        token = secrets.token_hex(16)
        self._sessions[token] = {"username": username, "start_time": time.time()}
        return {"session_token": token}

    def submit_score(self, username: str, score: int, session_token: str) -> dict:
        session = self._sessions.pop(session_token, None)  # dùng 1 lần
        if not session or session["username"] != username:
            raise HTTPException(status_code=400, detail="Phiên chơi không hợp lệ hoặc đã hết hạn, vui lòng chơi lại từ đầu")

        elapsed = time.time() - session["start_time"]
        if elapsed < self.config.min_play_seconds:
            raise HTTPException(status_code=400, detail="Kết quả không hợp lệ")
        if score < 0 or score > elapsed * self.config.max_score_per_second:
            raise HTTPException(status_code=400, detail="Điểm số không hợp lệ")

        with self.db.session() as repo:
            stats = repo.users.get_play_stats(username)
            if not stats:
                raise HTTPException(status_code=404, detail="Không tìm thấy người dùng")
            new_high = max(stats.high_score, score)
            repo.users.save_play_stats(username, new_high, stats.total_matches + 1)
        return {"message": "Cập nhật điểm thành công", "high_score": new_high}


class ChessService:
    """Thắng +100, thua -100, hoà 0 (cột chess_score); mỗi ván +1 total_matches cho cả 2.
    Chỉ tính điểm khi CẢ HAI người trong phòng cùng báo kết quả và 2 báo cáo khớp nhau.
    (Chống gian lận mức cơ bản: chưa xác thực lại nước đi ở server.)"""

    def __init__(self, db: Database, config: Settings):
        self.db, self.config = db, config
        self._reports: dict[str, dict] = {}  # room_code -> {username: {"result", "ts"}}

    def _purge_stale(self):
        now = time.time()
        stale = [room for room, reps in self._reports.items()
                 if all(now - r["ts"] > self.config.chess_report_ttl_seconds for r in reps.values())]
        for room in stale:
            self._reports.pop(room, None)

    def _delta(self, result: str) -> int:
        d = self.config.chess_score_delta
        return d if result == "win" else (-d if result == "loss" else 0)

    def report_result(self, username: str, room_code: str, result: str) -> dict:
        self._purge_stale()
        room_code = (room_code or "").strip().upper()[:12]
        result = (result or "").strip().lower()
        if not room_code:
            raise HTTPException(status_code=400, detail="Thiếu mã phòng")
        if result not in ("win", "loss", "draw"):
            raise HTTPException(status_code=400, detail="Kết quả không hợp lệ")

        reports = self._reports.setdefault(room_code, {})
        reports[username] = {"result": result, "ts": time.time()}

        if len(reports) < 2:
            return {"message": "Đã ghi nhận, đang chờ xác nhận từ đối thủ", "applied": False}

        final = dict(reports)
        self._reports.pop(room_code, None)  # dùng 1 lần, tránh báo lại để cộng điểm khống

        r1, r2 = (info["result"] for info in final.values())
        if {r1, r2} not in ({"win", "loss"}, {"draw"}):
            return {"message": "Kết quả 2 người chơi báo cáo không khớp nhau, không tính điểm", "applied": False}

        with self.db.session() as repo:
            for uname, info in final.items():
                repo.users.add_chess_result(uname, self._delta(info["result"]))
        return {"message": "Đã cập nhật điểm cờ vua", "applied": True, "delta": self._delta(result)}


# ======================================================================
# 9. ỨNG DỤNG: gắn các service vào đường dẫn /api/...
# ======================================================================
class GameZoneAPI:
    def __init__(self, config: Settings = settings):
        self.config = config

        # Các đối tượng dùng chung
        self.db = Database(config.db_connection_string)
        self.connections = ConnectionManager()
        self.duel_hub = DuelHub(config.lobby_room_ttl_seconds)

        self.auth = AuthService(self.db, config, hasher, tokens)
        self.users = UserService(self.db, config)
        self.friends = FriendService(self.db)
        self.messages = MessageService(self.db, self.connections)
        self.game = GameService(self.db, config)
        self.chess = ChessService(self.db, config)
        self.quests = QuestService(self.db)

        # FastAPI
        self.app = FastAPI()
        self.app.add_middleware(
            CORSMiddleware,
            allow_origins=["*"],
            allow_credentials=False,  # dùng token qua header, không dùng cookie
            allow_methods=["*"],
            allow_headers=["*"],
        )
        self.router = APIRouter(prefix="/api")
        self._register_routes()
        self.app.include_router(self.router)

    def _register_routes(self):
        r = self.router
        # Tài khoản & hồ sơ
        r.add_api_route("/register", self.register, methods=["POST"])
        r.add_api_route("/login", self.login, methods=["POST"])
        r.add_api_route("/update-nickname", self.update_nickname, methods=["POST"])
        r.add_api_route("/update-avatar", self.update_avatar, methods=["POST"])
        r.add_api_route("/set-active-chibi", self.set_active_chibi, methods=["POST"])
        r.add_api_route("/user-stats/{username}", self.user_stats, methods=["GET"])
        r.add_api_route("/leaderboard", self.leaderboard, methods=["GET"])
        r.add_api_route("/search-users", self.search_users, methods=["GET"])
        r.add_api_route("/profile/{public_id}", self.profile, methods=["GET"])
        r.add_api_route("/quests", self.list_quests, methods=["GET"])
        # Điểm số
        r.add_api_route("/start-game", self.start_game, methods=["POST"])
        r.add_api_route("/update-score", self.update_score, methods=["POST"])
        r.add_api_route("/chess/report-result", self.report_chess_result, methods=["POST"])
        # Bạn bè
        r.add_api_route("/friends/request/{public_id}", self.send_friend_request, methods=["POST"])
        r.add_api_route("/friends/respond/{public_id}", self.respond_friend_request, methods=["POST"])
        r.add_api_route("/friends/{public_id}", self.remove_friend, methods=["DELETE"])
        r.add_api_route("/friends", self.list_friends, methods=["GET"])
        # Nhắn tin (đặt /conversations trước /{public_id})
        r.add_api_websocket_route("/ws/messages", self.messages_ws)
        r.add_api_route("/messages/conversations", self.list_conversations, methods=["GET"])
        r.add_api_route("/messages/{public_id}", self.get_conversation, methods=["GET"])
        r.add_api_route("/messages/{public_id}", self.send_message, methods=["POST"])
        # Phòng đấu
        r.add_api_route("/duel/create-room", self.create_duel_room, methods=["POST"])
        r.add_api_route("/duel/rooms", self.list_duel_rooms, methods=["GET"])
        r.add_api_websocket_route("/ws/duel/{room_code}", self.duel_ws)

    # ---------- Tài khoản & hồ sơ ----------
    def register(self, user: Credentials):
        return self.auth.register(user.username, user.password)

    def login(self, user: Credentials):
        return self.auth.login(user.username, user.password)

    def update_nickname(self, data: UpdateNickname, username: str = CurrentUser):
        return self.users.update_nickname(username, data.nickname)

    def update_avatar(self, data: UpdateAvatar, username: str = CurrentUser):
        return self.users.update_avatar(username, data.avatar)

    def set_active_chibi(self, data: SetActiveChibi, username: str = CurrentUser):
        return self.users.set_active_chibi(username, data.chibi_code, data.active)

    def user_stats(self, username: str):
        return self.users.stats(username)

    def leaderboard(self, viewer: Optional[str] = OptionalUser):
        return self.users.leaderboard(viewer)

    def search_users(self, q: str = ""):
        return self.users.search(q)

    def profile(self, public_id: str, viewer: Optional[str] = OptionalUser):
        return self.users.public_profile(public_id, viewer)

    def list_quests(self, username: str = CurrentUser):
        return self.quests.list_for(username)

    # ---------- Điểm số ----------
    def start_game(self, username: str = CurrentUser):
        return self.game.start(username)

    def update_score(self, data: GameScore, username: str = CurrentUser):
        return self.game.submit_score(username, data.score, data.session_token)

    def report_chess_result(self, data: ChessMatchResult, username: str = CurrentUser):
        return self.chess.report_result(username, data.room_code, data.result)

    # ---------- Bạn bè ----------
    def send_friend_request(self, public_id: str, username: str = CurrentUser):
        return self.friends.send_request(username, public_id)

    def respond_friend_request(self, public_id: str, data: FriendRespond, username: str = CurrentUser):
        return self.friends.respond(username, public_id, data.action)

    def remove_friend(self, public_id: str, username: str = CurrentUser):
        return self.friends.remove(username, public_id)

    def list_friends(self, username: str = CurrentUser):
        return self.friends.overview(username)

    # ---------- Nhắn tin ----------
    async def messages_ws(self, websocket: WebSocket, token: str = ""):
        """Kênh realtime nhận tin mới. Trình duyệt không set được header nên token đi qua query string."""
        await websocket.accept()
        try:
            username = tokens.decode(token)
        except jwt.PyJWTError:
            await websocket.send_json({"type": "auth_error"})
            await websocket.close()
            return

        self.connections.add(username, websocket)
        try:
            while True:
                await websocket.receive_text()  # chỉ để phát hiện client ngắt kết nối
        except WebSocketDisconnect:
            pass
        finally:
            self.connections.remove(username, websocket)

    def list_conversations(self, username: str = CurrentUser):
        return self.messages.conversations(username)

    def get_conversation(self, public_id: str, before_id: Optional[int] = None, limit: int = 50,
                         username: str = CurrentUser):
        return self.messages.history(username, public_id, before_id, limit)

    async def send_message(self, public_id: str, data: SendMessage, username: str = CurrentUser):
        return await self.messages.send(username, public_id, data.content)

    # ---------- Phòng đấu ----------
    def create_duel_room(self, payload: CreateDuelRoom):
        return {"room_code": self.duel_hub.create_lobby_room(payload.game, payload.creator_name)}

    def list_duel_rooms(self, game: Optional[str] = None):
        return self.duel_hub.list_lobby_rooms(game)

    async def duel_ws(self, websocket: WebSocket, room_code: str):
        await self.duel_hub.serve(websocket, room_code)


app = GameZoneAPI().app
