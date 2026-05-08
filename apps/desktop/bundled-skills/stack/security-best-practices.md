---
name: security-best-practices
description: 任何涉及用户输入 / 认证 / 鉴权 / 数据存储 / 第三方调用 / 文件操作 / shell 执行 的代码，**必须调用此技能**做安全审查，避免常见漏洞（注入 / XSS / 路径穿越 / 凭据泄露 / SSRF）。
---

# 通用代码安全实践

## 适用场景

涉及任何**信任边界**的代码：
- 接收用户输入的接口 / 表单
- 认证 / 鉴权逻辑
- SQL / 数据库查询
- 文件上传 / 下载 / 路径处理
- 调用 shell / 子进程
- 调用第三方 API
- 序列化 / 反序列化
- 加密 / 哈希 / 签名

## OWASP Top 10 重点

### 1. 注入（Injection）

#### SQL 注入

❌ 字符串拼接：
```java
String sql = "SELECT * FROM users WHERE name = '" + name + "'";
```
攻击：`name = "Alice'; DROP TABLE users; --"`

✅ 参数化：
```java
PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE name = ?");
ps.setString(1, name);
```

JPA / Hibernate 的 `@Query` 也要用 `:param` 不要拼接。

#### Shell 注入

❌
```ts
exec(`grep ${userInput} file.txt`);  // userInput = "x; rm -rf /"
```

✅
```ts
spawn('grep', [userInput, 'file.txt']);  // 参数数组，不经 shell 解析
```

#### NoSQL 注入

MongoDB 接收 JSON 查询时，攻击者可注入操作符：

❌
```js
db.users.findOne({ name: req.body.name });  // name = { $ne: null }
```

✅
```js
db.users.findOne({ name: String(req.body.name) });  // 强制 string
```

### 2. XSS（跨站脚本）

❌ 直接插 innerHTML：
```js
div.innerHTML = `<p>${userMessage}</p>`;  // userMessage = "<script>alert(1)</script>"
```

✅ 用 textContent 或框架的转义：
```js
div.textContent = userMessage;  // React/Vue/Solid 默认转义
```

✅ 必须渲染 HTML 时用 DOMPurify：
```js
div.innerHTML = DOMPurify.sanitize(userMessage);
```

### 3. CSRF（跨站请求伪造）

防御：
- API 需要 token（JWT / session cookie + CSRF token）
- 关键操作要 `Origin` / `Referer` 校验
- Cookie 加 `SameSite=Strict` / `Lax`
- 不要把状态修改放在 GET（应该 POST/PUT/DELETE）

### 4. 路径穿越

❌
```ts
const path = `/uploads/${req.params.filename}`;
fs.readFileSync(path);  // filename = "../../etc/passwd"
```

✅
```ts
import path from 'path';
const safe = path.join('/uploads', path.basename(req.params.filename));
// 然后再校验 safe.startsWith('/uploads/')
```

### 5. 不安全的反序列化

❌ 信任不可信数据反序列化：
```java
ObjectInputStream in = new ObjectInputStream(req.getInputStream());
Object obj = in.readObject();  // ❌ 远程代码执行
```

✅ 用 JSON / 受限格式 + 校验类型。

### 6. 凭据泄露

#### 不要硬编码：

❌
```ts
const apiKey = "sk-abc123...";  // ❌ 进 git
const dbPassword = "p@ssw0rd";  // ❌
```

✅
```ts
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error("API_KEY missing");
```

#### `.gitignore` 必含：

```
.env
.env.local
.env.*.local
*.pem
*.key
secrets/
```

#### 已经 commit 的密钥：

1. **立即在源端 revoke**（重新生成 key）
2. 用 `git filter-repo` 从历史移除
3. 强推（提前通知协作者）
4. 评估泄露窗口（git 仓库被克隆到哪些地方？）

### 7. 不安全的依赖

- 定期跑 `npm audit` / `mvn dependency-check` / `cargo audit`
- 用 Dependabot / Renovate 自动 PR
- 锁版本（`package-lock.json` / `pnpm-lock.yaml` / `Cargo.lock` 必须 commit）

### 8. SSRF（服务端请求伪造）

❌
```ts
fetch(req.body.url);  // url = "http://169.254.169.254/" (AWS metadata)
```

✅
- 白名单域名 / IP 范围
- 解析 URL，拒绝内网 IP（127.x / 10.x / 172.16-31.x / 192.168.x / 169.254.x）
- 禁用重定向跟随（防绕过）

### 9. 弱认证

#### 密码：

- bcrypt / Argon2 / scrypt（**不要** MD5 / SHA1 / SHA256）
- bcrypt cost ≥ 12（2026 年标准）

```java
String hash = BCrypt.hashpw(password, BCrypt.gensalt(12));
```

#### Token：

- JWT 算法用 RS256 / ES256，不用 HS256（共享密钥风险）
- 设置过期 + 短刷新窗口
- HttpOnly + Secure + SameSite cookie 存储

### 10. 日志里别记敏感信息

❌
```ts
log.info("用户登录", { email, password });  // ❌
log.info("响应", { body: response });  // body 可能含 token
```

✅
```ts
log.info("用户登录", { email });  // 不记 password
log.info("响应 status", { status: response.status });
```

加 redact 中间件自动脱敏 `password` / `token` / `secret` 字段。

## 加密原则

| 场景 | 推荐 |
|---|---|
| 哈希密码 | bcrypt / Argon2 |
| 数据完整性 | HMAC-SHA256 |
| 对称加密 | AES-256-GCM（带 nonce） |
| 非对称加密 | RSA-2048+ / Ed25519 |
| 随机数 | `crypto.randomBytes()` / `SecureRandom`（**不**用 `Math.random()`） |

❌ **不要自己造加密轮子**。用成熟库（`crypto` / `bouncycastle` / `tweetnacl`）。

## 输入校验"白名单优于黑名单"

❌
```ts
if (input.includes('<script>')) reject();  // 黑名单永远漏
```

✅
```ts
if (!/^[a-zA-Z0-9_-]+$/.test(input)) reject();  // 白名单：只允许这些字符
```

## 错误信息别泄露内部细节

❌ 把 stacktrace / SQL 错误消息直接返给客户端：
```
Error: Column 'admin_password' not found in users
```

✅ 通用错误：
```json
{ "code": "INTERNAL_ERROR", "message": "请求失败" }
```
内部用 trace_id 关联日志，让运维能查。

## CORS 配置

❌ `Access-Control-Allow-Origin: *` + `Allow-Credentials: true` — 互斥不安全
✅ 白名单：明确写允许的 origin

## CSP（内容安全策略）

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-xyz'; ...
```

可以挡 90% 的反射型 / 存储型 XSS。

## 文件上传

- 限制大小（防 DoS）
- 限制 MIME 类型（白名单）+ 校验真实文件头（不只看后缀）
- 存储路径**不**让用户控制
- 不直接暴露存储路径（用 ID 引用 + 鉴权后下载）
- 病毒扫描（ClamAV 等）

## 日常安全自检（**review 时过一遍**）

- [ ] 用户输入有没有验证 / 转义？
- [ ] SQL / shell / 路径有没有用参数化方式？
- [ ] 密钥有没有硬编码 / 进 git？
- [ ] 错误响应有没有泄露内部细节？
- [ ] 鉴权有没有遗漏？（每个接口都该有，除非明确公开）
- [ ] 日志有没有记敏感信息？
- [ ] 依赖有没有已知漏洞？

## 与其他技能的关系

- 任何代码改动都建议用 `code-review-checklist` 时叠加本 skill
- 发现安全问题 → `systematic-debugging` 找根因
- 修了再 `verification-before-completion`（包含写一个攻击场景的回归测试）
