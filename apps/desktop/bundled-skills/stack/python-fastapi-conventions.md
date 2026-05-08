---
name: python-fastapi-conventions
description: 任何 Python + FastAPI 项目改动（路由、Pydantic 模型、依赖注入、数据库、异步），**调用此技能**遵守分层和异步规范，避免阻塞 / sqlite 误用 / Pydantic v1 v2 混用等问题。
---

# Python FastAPI 项目规范

## 适用场景

任何 FastAPI 后端任务：
- 路由 / endpoint 设计
- Pydantic 模型定义
- 依赖注入（Depends）
- 数据库（SQLAlchemy / SQLModel）
- 异步 / 同步混用
- 中间件 / 异常处理
- 测试

## 项目结构（推荐）

```
app/
├── main.py                  # FastAPI 实例 + 路由挂载
├── config.py                # Settings (pydantic-settings)
├── deps.py                  # 共用依赖（DB session、当前用户）
├── api/
│   └── v1/
│       ├── __init__.py
│       ├── users.py         # APIRouter
│       └── posts.py
├── models/                  # SQLAlchemy 模型
│   ├── __init__.py
│   └── user.py
├── schemas/                 # Pydantic 模型（请求/响应）
│   ├── __init__.py
│   └── user.py
├── services/                # 业务逻辑
│   └── user_service.py
├── db/
│   ├── session.py           # SessionLocal
│   └── migrations/          # Alembic
└── tests/
```

## 8 条铁律

### 1. async / sync — 不要混

FastAPI 同时支持 async 和 sync 路由，但**别在 async 路由里调阻塞函数**。

```python
import asyncio
from fastapi import FastAPI

app = FastAPI()

@app.get("/sync")
def sync_route():
    # FastAPI 在 threadpool 跑这个，OK
    time.sleep(1)
    return {}

@app.get("/async")
async def async_route():
    # ❌ 阻塞主 event loop，整个进程卡住
    time.sleep(1)
    
    # ✅
    await asyncio.sleep(1)
    
    # ❌ requests 库是阻塞的
    requests.get("...")
    
    # ✅ httpx 异步
    async with httpx.AsyncClient() as c:
        r = await c.get("...")
```

### 2. Pydantic v2 优先（FastAPI 0.100+）

```python
from pydantic import BaseModel, Field, EmailStr, ConfigDict

# ✅ Pydantic v2
class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=2, max_length=50)
    age: int = Field(ge=0, le=150)

class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)  # v2: 替代 orm_mode
    
    id: int
    email: EmailStr
    name: str
    created_at: datetime
```

v1 → v2 关键变化：
- `Config(orm_mode=True)` → `model_config = ConfigDict(from_attributes=True)`
- `dict()` → `model_dump()`
- `parse_obj` → `model_validate`
- `validator` → `field_validator`（且参数变了）

### 3. 路由用 APIRouter 分模块

```python
# api/v1/users.py
from fastapi import APIRouter, Depends, HTTPException
from app.deps import get_db, get_current_user
from app.schemas.user import UserCreate, UserResponse
from app.services import user_service

router = APIRouter(prefix="/users", tags=["users"])

@router.post("", response_model=UserResponse, status_code=201)
def create_user(
    data: UserCreate,
    db = Depends(get_db),
):
    if user_service.exists_by_email(db, data.email):
        raise HTTPException(409, detail={"code": "EMAIL_EXISTS", "message": "邮箱已注册"})
    return user_service.create(db, data)

@router.get("/{user_id}", response_model=UserResponse)
def get_user(user_id: int, db = Depends(get_db)):
    user = user_service.get(db, user_id)
    if not user:
        raise HTTPException(404, detail={"code": "USER_NOT_FOUND"})
    return user
```

主入口挂载：
```python
# main.py
from fastapi import FastAPI
from app.api.v1 import users, posts

app = FastAPI(title="My API", version="1.0")
app.include_router(users.router, prefix="/api/v1")
app.include_router(posts.router, prefix="/api/v1")
```

### 4. 依赖注入 — 共用逻辑通过 Depends

```python
# deps.py
from fastapi import Depends, HTTPException
from sqlalchemy.orm import Session
from app.db.session import SessionLocal

def get_db():
    db = SessionLocal()
    try:
        yield db  # 关键：用 generator
    finally:
        db.close()

def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    payload = decode_jwt(token)
    user = db.query(User).filter(User.id == payload["sub"]).first()
    if not user:
        raise HTTPException(401, "Invalid credentials")
    return user

# 使用
@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    return user
```

### 5. 异常处理 — 用 HTTPException，全局统一格式

```python
from fastapi import Request
from fastapi.responses import JSONResponse

class BusinessException(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code = code
        self.message = message
        self.status = status

@app.exception_handler(BusinessException)
async def business_exception_handler(request: Request, exc: BusinessException):
    return JSONResponse(
        status_code=exc.status,
        content={"code": exc.code, "message": exc.message},
    )

@app.exception_handler(Exception)
async def fallback_handler(request: Request, exc: Exception):
    logger.exception("Unhandled")
    return JSONResponse(500, content={"code": "INTERNAL_ERROR", "message": "服务器开小差"})
```

### 6. SQLAlchemy 2.x — 用新 select() 语法

```python
# ❌ 老风格 1.x
db.query(User).filter(User.email == "x").first()

# ✅ 新风格 2.x
from sqlalchemy import select
stmt = select(User).where(User.email == "x")
db.execute(stmt).scalar_one_or_none()
```

异步：
```python
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

engine = create_async_engine("postgresql+asyncpg://...")

async def get_user(db: AsyncSession, id: int) -> User:
    result = await db.execute(select(User).where(User.id == id))
    return result.scalar_one_or_none()
```

### 7. 配置用 pydantic-settings

```python
# config.py
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    database_url: str
    jwt_secret: str
    redis_url: str = "redis://localhost:6379"
    debug: bool = False
    
    model_config = {"env_file": ".env", "case_sensitive": False}

settings = Settings()
```

`.env`:
```
DATABASE_URL=postgresql://...
JWT_SECRET=xxx
DEBUG=false
```

### 8. 后台任务 — BackgroundTasks 或队列

短任务（< 几秒）用 BackgroundTasks：
```python
from fastapi import BackgroundTasks

@router.post("/users")
def create_user(data: UserCreate, bg: BackgroundTasks, db = Depends(get_db)):
    user = user_service.create(db, data)
    bg.add_task(send_welcome_email, user.email)
    return user
```

长任务用 Celery / RQ / Dramatiq + Redis。

## 测试

```python
# tests/conftest.py
import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.deps import get_db
from app.db.session import TestSessionLocal

def override_get_db():
    db = TestSessionLocal()
    try: yield db
    finally: db.close()

app.dependency_overrides[get_db] = override_get_db

@pytest.fixture
def client():
    return TestClient(app)

# tests/test_users.py
def test_create_user(client):
    r = client.post("/api/v1/users", json={"email": "a@b.com", "name": "Alice", "age": 30})
    assert r.status_code == 201
    assert r.json()["email"] == "a@b.com"
```

异步测试用 `pytest-asyncio` + `httpx.AsyncClient`。

## 常见陷阱

### 陷阱 1：在 sync 路由里直接 await

```python
# ❌ sync 函数里不能 await
@router.get("/x")
def sync_route():
    data = await fetch()  # 语法错误

# ✅ 选其一
@router.get("/x")
async def async_route():
    data = await fetch()
```

### 陷阱 2：Pydantic 模型循环引用

```python
# ❌ User 引用 Post，Post 引用 User
class User(BaseModel):
    posts: list["Post"]

class Post(BaseModel):
    author: "User"

# ✅ Pydantic v2 自动处理 forward reference，但建议用 ID
class UserResponse(BaseModel):
    id: int
    email: str
    post_ids: list[int]
```

### 陷阱 3：Session 跨请求共享

```python
# ❌ 全局 session
db = SessionLocal()  # 不行，多请求并发会互相影响

# ✅ 每请求一个 session（用 Depends(get_db))
```

### 陷阱 4：N+1 查询

```python
# ❌
users = db.execute(select(User)).scalars().all()
for u in users:
    print(u.posts)  # 每个 user 触发一次 SELECT

# ✅ joinedload
from sqlalchemy.orm import joinedload
users = db.execute(select(User).options(joinedload(User.posts))).scalars().unique().all()
```

### 陷阱 5：response_model 没设置

```python
# ❌ 直接返回 ORM 模型可能泄露字段（password_hash 等）
@router.get("/me")
def get_me(user: User = Depends(get_current_user)):
    return user

# ✅ 用 response_model 强制过滤
@router.get("/me", response_model=UserResponse)
def get_me(user: User = Depends(get_current_user)):
    return user  # FastAPI 自动用 UserResponse 序列化
```

## 性能

- **启动**：用 `uvicorn app.main:app --workers 4`（生产）
- **CPU 密集**：放 worker 进程或 Celery
- **数据库连接池**：`pool_size=20, max_overflow=10`
- **HTTP 客户端**：用 httpx.AsyncClient(transport=…) 复用连接
- **缓存**：FastAPI-Cache2 + Redis

## 与其他技能的关系

- 数据库迁移 → database-migration-safety（用 Alembic）
- API 设计 → api-design
- 安全 → security-best-practices（FastAPI Security utils）
