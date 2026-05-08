---
name: go-gin-patterns
description: 任何 Go + Gin 项目代码（handler、middleware、context、GORM），**调用此技能**遵守 Go 惯用法，避免 panic 不处理 / context 误用 / goroutine 泄漏等问题。
---

# Go Gin Web 项目实战

## 适用场景

- Go HTTP API 项目（Gin 框架）
- handler / middleware / 路由设计
- 数据库（GORM / sqlx）
- 错误处理 / 日志
- 测试 / Goroutine

## 项目结构

```
.
├── cmd/server/main.go          # 入口
├── internal/                   # 私有包（不可被外部 import）
│   ├── api/                    # gin handler
│   │   ├── routes.go
│   │   └── user_handler.go
│   ├── service/                # 业务
│   ├── repository/             # 数据访问
│   ├── model/                  # GORM 模型
│   ├── dto/                    # 请求/响应结构
│   └── middleware/
├── pkg/                        # 可被外部 import 的（一般不需要）
├── config/                     # 配置
├── go.mod
└── Makefile
```

## 8 条铁律

### 1. errors 不要丢，必须返回

```go
// ❌ 吞错误
result, _ := db.Find(...)

// ✅ 显式处理
result, err := db.Find(...)
if err != nil {
    return fmt.Errorf("find user: %w", err)  // wrap 加上下文
}
```

每个错误必须：
- 返回给上层
- 或者 log 并继续（明确决定）
- 永远不要 `_ = err` 静默吞

### 2. error wrap 用 `%w`，错误链可追溯

```go
// service
if err := repo.GetUser(id); err != nil {
    return fmt.Errorf("user service: %w", err)
}

// handler 处
err := svc.GetUser(id)
var notFound *NotFoundError
if errors.As(err, &notFound) {
    c.JSON(404, gin.H{"code": "NOT_FOUND"})
    return
}
```

### 3. context 在第一个参数 + 全程透传

```go
func (s *UserService) Get(ctx context.Context, id int64) (*User, error) {
    return s.repo.GetUser(ctx, id)
}

func (r *UserRepo) GetUser(ctx context.Context, id int64) (*User, error) {
    var u User
    err := r.db.WithContext(ctx).First(&u, id).Error  // GORM 注入 ctx
    return &u, err
}
```

**为什么**：上游（Gin / 测试 / 取消信号）可以通过 ctx 控制请求生命周期。

### 4. handler 薄，只做 HTTP 转换

```go
// handler/user_handler.go
type UserHandler struct {
    svc *service.UserService
}

func (h *UserHandler) Create(c *gin.Context) {
    var req dto.CreateUserRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(400, gin.H{"code": "VALIDATION_FAILED", "message": err.Error()})
        return
    }
    
    user, err := h.svc.Create(c.Request.Context(), &req)
    if err != nil {
        respondError(c, err)
        return
    }
    
    c.JSON(201, dto.NewUserResponse(user))
}

// 路由
func RegisterRoutes(r *gin.RouterGroup, h *UserHandler) {
    r.POST("/users", h.Create)
    r.GET("/users/:id", h.Get)
}
```

### 5. 输入校验 — go-playground/validator

```go
type CreateUserRequest struct {
    Email string `json:"email" binding:"required,email"`
    Name  string `json:"name"  binding:"required,min=2,max=50"`
    Age   int    `json:"age"   binding:"gte=0,lte=150"`
}
```

`ShouldBindJSON` 自动跑 validator。

### 6. GORM — Select 防字段泄露

```go
// ❌ 默认 SELECT *，可能含 password_hash
db.First(&user, id)

// ✅ 明确字段
db.Select("id, email, name, created_at").First(&user, id)

// 或定义 DTO 直接扫描
type UserDTO struct {
    ID    int64
    Email string
    Name  string
}
db.Model(&User{}).Select("id, email, name").First(&dto, id)
```

预加载关联：
```go
// 一次性加载 user + posts + comments
db.Preload("Posts.Comments").First(&user, id)
```

### 7. middleware 模式

```go
// middleware/auth.go
func AuthRequired(jwtSecret string) gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("Authorization")
        if !strings.HasPrefix(token, "Bearer ") {
            c.AbortWithStatusJSON(401, gin.H{"code": "UNAUTHORIZED"})
            return
        }
        claims, err := parseJWT(token[7:], jwtSecret)
        if err != nil {
            c.AbortWithStatusJSON(401, gin.H{"code": "INVALID_TOKEN"})
            return
        }
        c.Set("userID", claims.Sub)
        c.Next()
    }
}

// 路由
r := gin.Default()
api := r.Group("/api/v1")
api.Use(AuthRequired(cfg.JWTSecret))
{
    api.GET("/me", handler.Me)
}
```

### 8. goroutine — 必须有退出机制

```go
// ❌ 永远在跑，进程退出才停
go func() {
    for {
        process()
        time.Sleep(time.Second)
    }
}()

// ✅ 通过 ctx 控制
func (s *Service) StartWorker(ctx context.Context) {
    go func() {
        ticker := time.NewTicker(time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                log.Println("worker stopped")
                return
            case <-ticker.C:
                s.process()
            }
        }
    }()
}
```

启动 + 关闭：
```go
ctx, cancel := context.WithCancel(context.Background())
svc.StartWorker(ctx)

// 收到 SIGTERM 时
sig := make(chan os.Signal, 1)
signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
<-sig
cancel()  // 通知所有 worker 退出
```

## 优雅关闭 HTTP server

```go
func main() {
    r := setupRouter()
    srv := &http.Server{Addr: ":8080", Handler: r}
    
    go func() {
        if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()
    
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit
    
    log.Println("Shutting down...")
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()
    if err := srv.Shutdown(ctx); err != nil {
        log.Fatal("Shutdown error:", err)
    }
    log.Println("Stopped")
}
```

## 配置

```go
// config/config.go
type Config struct {
    Port        int    `env:"PORT" envDefault:"8080"`
    DatabaseURL string `env:"DATABASE_URL,required"`
    JWTSecret   string `env:"JWT_SECRET,required"`
}

// 用 github.com/caarlos0/env
cfg := &Config{}
if err := env.Parse(cfg); err != nil {
    log.Fatal(err)
}
```

## 测试

```go
func TestCreateUser(t *testing.T) {
    gin.SetMode(gin.TestMode)
    r := gin.New()
    h := &UserHandler{svc: mockSvc}
    r.POST("/users", h.Create)
    
    body := `{"email":"a@b.com","name":"Alice"}`
    req := httptest.NewRequest("POST", "/users", strings.NewReader(body))
    req.Header.Set("Content-Type", "application/json")
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    
    assert.Equal(t, 201, w.Code)
    var resp dto.UserResponse
    json.Unmarshal(w.Body.Bytes(), &resp)
    assert.Equal(t, "a@b.com", resp.Email)
}
```

依赖隔离用 mock：testify/mock 或手写 interface。

## 常见陷阱

### 陷阱 1：闭包捕获循环变量

```go
// ❌ Go 1.21 之前
for _, item := range items {
    go func() { process(item) }()  // 所有 goroutine 拿到最后一个 item
}

// ✅
for _, item := range items {
    item := item  // 显式捕获
    go func() { process(item) }()
}

// Go 1.22+ 修了这个坑，无需 shadow
```

### 陷阱 2：map 并发读写 panic

```go
// ❌
var cache = map[string]string{}
go func() { cache["a"] = "1" }()
go func() { _ = cache["a"] }()

// ✅
import "sync"
var cache sync.Map
cache.Store("a", "1")
v, _ := cache.Load("a")

// 或者 RWMutex
var (
    cache = map[string]string{}
    mu    sync.RWMutex
)
```

### 陷阱 3：nil interface 陷阱

```go
// ❌
var err error
var nilErr *MyError = nil
err = nilErr
fmt.Println(err == nil)  // false! 类型不为 nil

// ✅ 显式返回 nil
if condition {
    return nil  // 而不是 return nilErr
}
```

### 陷阱 4：slice 共享底层数组

```go
// ❌
a := []int{1, 2, 3, 4}
b := a[1:3]
b = append(b, 99)
// a 可能被改：[1, 2, 3, 99]

// ✅ 用 copy 或 full slice expression
b := make([]int, 2)
copy(b, a[1:3])
```

### 陷阱 5：context.Background() 在请求里用

```go
// ❌ 失去取消传播
db.WithContext(context.Background()).First(&u, id)

// ✅ 用请求 ctx
db.WithContext(c.Request.Context()).First(&u, id)
```

## 性能

- gin 默认已启用连接复用、buffered writer
- DB 连接池：`db.SetMaxOpenConns(50); db.SetMaxIdleConns(10)`
- HTTP client 复用：单实例 + Transport 自定义
- 大文件用 `io.Copy` + Stream，不要 `ioutil.ReadAll`

## 与其他技能的关系

- 数据库 → database-migration-safety（用 golang-migrate / GORM AutoMigrate 谨慎）
- API 设计 → api-design
- 微服务架构 → microservices-patterns
