---
name: spring-boot-conventions
description: 当用户要写 / 改 Spring Boot 后端（Controller / Service / Repository / Entity / 配置）时，**必须调用此技能**遵守分层与命名约定，避免业务逻辑泄露到 Controller 或 entity 当 DTO 用导致的常见问题。
---

# Spring Boot 项目规范（3.x）

## 适用场景

任何 Java + Spring Boot 后端任务：
- 新建 Controller / Service / Repository
- 加接口 / 改业务逻辑
- 配置数据库 / 第三方
- 加单元测试 / 集成测试

## 分层职责（**严格分离**）

```
┌─────────────────────────────────────────┐
│ Controller   — 收 HTTP，转 DTO，调 Service │
├─────────────────────────────────────────┤
│ Service      — 业务逻辑，事务管理            │
├─────────────────────────────────────────┤
│ Repository   — 数据访问，JPA / MyBatis      │
├─────────────────────────────────────────┤
│ Entity       — JPA 实体，对应数据库表        │
└─────────────────────────────────────────┘
```

### Controller — 薄，**不写业务**

```java
@RestController
@RequestMapping("/api/users")
@RequiredArgsConstructor
public class UserController {
    private final UserService userService;

    @GetMapping("/{id}")
    public UserDTO getUser(@PathVariable Long id) {
        return userService.getUser(id);  // ✅ 直接转交
    }

    @PostMapping
    public UserDTO createUser(@Valid @RequestBody CreateUserRequest req) {
        return userService.createUser(req);
    }
}
```

❌ 不要在 Controller 里：
- 写 if-else 业务判断
- 直接调 Repository
- 处理事务

### Service — 业务核心，事务边界

```java
@Service
@RequiredArgsConstructor
public class UserService {
    private final UserRepository userRepo;
    private final EmailService emailService;

    @Transactional
    public UserDTO createUser(CreateUserRequest req) {
        // 业务校验
        if (userRepo.existsByEmail(req.email())) {
            throw new BusinessException("EMAIL_EXISTS");
        }

        // 持久化
        User user = User.builder()
            .email(req.email())
            .name(req.name())
            .build();
        user = userRepo.save(user);

        // 副作用（同事务内）
        emailService.sendWelcome(user);

        return UserDTO.from(user);
    }

    @Transactional(readOnly = true)
    public UserDTO getUser(Long id) {
        User user = userRepo.findById(id)
            .orElseThrow(() -> new NotFoundException("USER_NOT_FOUND"));
        return UserDTO.from(user);
    }
}
```

**事务规则**：
- 写操作（create/update/delete）→ `@Transactional`
- 只读 → `@Transactional(readOnly = true)`（性能优化）
- 不要在 Controller 加 `@Transactional`（粒度错位）

### Repository — 接口，不写实现

```java
public interface UserRepository extends JpaRepository<User, Long> {
    Optional<User> findByEmail(String email);
    boolean existsByEmail(String email);

    // 复杂查询用 @Query
    @Query("SELECT u FROM User u WHERE u.tenantId = :tid AND u.status = 'ACTIVE'")
    List<User> findActiveByTenant(@Param("tid") Long tenantId);
}
```

### Entity — 数据库映射，**不直接对外**

```java
@Entity
@Table(name = "users")
@Getter
@NoArgsConstructor(access = AccessLevel.PROTECTED)
@AllArgsConstructor(access = AccessLevel.PRIVATE)
@Builder
public class User {
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true)
    private String email;

    @Column(nullable = false)
    private String name;

    @CreatedDate
    @Column(updatable = false)
    private LocalDateTime createdAt;

    @LastModifiedDate
    private LocalDateTime updatedAt;
}
```

❌ **不要把 Entity 当作 API 响应/请求返回**——会暴露内部字段，循环引用，懒加载异常。

### DTO — 用 Java Record（17+）

```java
// 请求 DTO（带校验）
public record CreateUserRequest(
    @NotBlank @Email String email,
    @NotBlank @Size(min = 2, max = 50) String name
) {}

// 响应 DTO
public record UserDTO(
    Long id,
    String email,
    String name,
    LocalDateTime createdAt
) {
    public static UserDTO from(User user) {
        return new UserDTO(
            user.getId(),
            user.getEmail(),
            user.getName(),
            user.getCreatedAt()
        );
    }
}
```

## 异常处理（统一）

### A. 自定义异常（按业务语义）

```java
public class BusinessException extends RuntimeException {
    private final String code;
    public BusinessException(String code) { ... }
}
public class NotFoundException extends BusinessException { ... }
public class ForbiddenException extends BusinessException { ... }
```

### B. 全局处理器

```java
@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(NotFoundException.class)
    @ResponseStatus(HttpStatus.NOT_FOUND)
    public ErrorResponse notFound(NotFoundException e) {
        return new ErrorResponse(e.getCode(), e.getMessage());
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    @ResponseStatus(HttpStatus.BAD_REQUEST)
    public ErrorResponse validationFailed(MethodArgumentNotValidException e) {
        // 把 BindingResult 转成结构化错误
        ...
    }

    @ExceptionHandler(Exception.class)
    @ResponseStatus(HttpStatus.INTERNAL_SERVER_ERROR)
    public ErrorResponse fallback(Exception e) {
        log.error("Unhandled", e);
        return new ErrorResponse("INTERNAL_ERROR", "服务器开小差了");
    }
}
```

## 配置管理

### application.yml 分环境

```
src/main/resources/
├── application.yml              # 通用
├── application-dev.yml          # 开发
├── application-prod.yml         # 生产
└── application-test.yml         # 测试
```

启动时：`--spring.profiles.active=prod`

### 敏感信息**不进 git**

❌ 数据库密码 / API key 写在 yml 里 commit
✅ 用环境变量 `${DB_PASSWORD}` + `.env` (gitignored) + Spring 自动注入
✅ 生产用 Vault / K8s Secret

## 测试

### 单元测试 — 用 Mockito 隔离

```java
@ExtendWith(MockitoExtension.class)
class UserServiceTest {
    @Mock UserRepository userRepo;
    @Mock EmailService emailService;
    @InjectMocks UserService userService;

    @Test
    void createUser_whenEmailExists_throws() {
        when(userRepo.existsByEmail("a@b.com")).thenReturn(true);
        var req = new CreateUserRequest("a@b.com", "Alice");
        assertThrows(BusinessException.class, () -> userService.createUser(req));
    }
}
```

### 集成测试 — `@SpringBootTest` + Testcontainers

```java
@SpringBootTest
@Testcontainers
class UserApiTest {
    @Container
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @DynamicPropertySource
    static void config(DynamicPropertyRegistry r) {
        r.add("spring.datasource.url", postgres::getJdbcUrl);
        ...
    }

    @Autowired MockMvc mockMvc;

    @Test
    void createUser_returns201() throws Exception {
        mockMvc.perform(post("/api/users")
                .contentType(APPLICATION_JSON)
                .content("""
                    {"email":"a@b.com","name":"Alice"}
                    """))
            .andExpect(status().isCreated());
    }
}
```

## 常见陷阱

### 1. N+1 查询

```java
List<Order> orders = orderRepo.findAll();
for (Order o : orders) {
    o.getItems().size();  // ❌ 每个 order 触发一次 SELECT
}
```

修：
```java
@Query("SELECT o FROM Order o JOIN FETCH o.items")
List<Order> findAllWithItems();
```

### 2. Lazy 字段在事务外被访问

```java
@Transactional(readOnly = true)
public User getUser(Long id) {
    return userRepo.findById(id).orElseThrow();
    // 事务结束
}

// Controller / 调用方
User u = userService.getUser(1L);
u.getOrders().size();  // ❌ LazyInitializationException
```

修：
- 在 Service 里面就把需要的关联加载好（FETCH JOIN 或转 DTO）
- Controller 拿到的是 DTO 不是 Entity

### 3. `@Async` 方法事务边界

`@Async` 默认不参与调用方事务。如果需要事务，方法内部加 `@Transactional`。

## Maven 项目骨架

```
pom.xml
src/
├── main/
│   ├── java/com/example/app/
│   │   ├── Application.java         # 启动类
│   │   ├── config/                  # @Configuration
│   │   ├── controller/
│   │   ├── service/
│   │   ├── repository/
│   │   ├── entity/
│   │   ├── dto/
│   │   └── exception/
│   └── resources/
│       ├── application.yml
│       └── db/migration/            # Flyway
└── test/
    └── java/com/example/app/...
```

## 与其他技能的关系

- 写之前先 `brainstorming` 明确需求
- 复杂改动 → `writing-plans` 拆步骤
- 实现完 → `verification-before-completion` 验证
- 涉及 SQL 性能 → 用 `EXPLAIN` 看执行计划
