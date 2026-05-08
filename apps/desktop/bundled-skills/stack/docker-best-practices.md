---
name: docker-best-practices
description: 任何 Dockerfile / docker-compose / 容器化任务，**调用此技能**遵守多阶段构建 / 最小镜像 / 安全规范，避免镜像膨胀、root 用户、密钥泄露等常见问题。
---

# Docker 容器化最佳实践

## 适用场景

- 写新 Dockerfile
- 优化镜像体积
- docker-compose 编排
- CI/CD 推送镜像
- 安全扫描

## 8 条铁律

### 1. 多阶段构建（必须）

```dockerfile
# ❌ 单阶段 → 镜像里有编译器、build 工具、依赖缓存
FROM node:20
COPY . .
RUN npm install && npm run build
CMD ["node", "dist/server.js"]
# 结果：1.5GB 镜像

# ✅ 多阶段 → 只保留 runtime 文件
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
USER node
CMD ["node", "dist/server.js"]
# 结果：~150MB 镜像
```

### 2. 用 alpine / distroless / slim 基础镜像

```dockerfile
# ❌ ubuntu / centos 太大
FROM node:20            # ~1GB

# ✅
FROM node:20-alpine     # ~120MB
FROM node:20-slim       # ~200MB（glibc 兼容性更好）
FROM gcr.io/distroless/nodejs20  # ~80MB（无 shell，最小攻击面）
```

**注意**：alpine 用 musl libc，部分 native 模块（node-pty、sharp）需要重新编译。

### 3. .dockerignore 必加

```
# .dockerignore
.git
.github
.vscode
node_modules
npm-debug.log
.env
.env.*
*.md
docs/
tests/
.DS_Store
dist/
coverage/
```

不写 .dockerignore：
- COPY . . 把 .git / node_modules 都进去 → 镜像膨胀 + 缓存失效
- .env 进去 → 密钥泄露

### 4. 利用 layer 缓存

**关键**：依赖文件先 COPY，源代码后 COPY。

```dockerfile
# ✅
COPY package*.json ./    # ← 改这俩文件才重装依赖
RUN npm ci
COPY . .                  # ← 改源码不影响上面的层

# ❌ 改一行代码就重装依赖
COPY . .
RUN npm ci
```

### 5. 不要用 root 跑

```dockerfile
# Node.js 镜像自带 node 用户
USER node

# 自定义
RUN addgroup -g 1000 app && adduser -u 1000 -G app -s /bin/sh -D app
USER app

# 文件权限
COPY --chown=node:node . .
```

### 6. 只暴露必要端口 + HEALTHCHECK

```dockerfile
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
```

K8s / Docker Swarm 用 HEALTHCHECK 判断容器是否就绪。

### 7. 用 ENTRYPOINT + CMD 组合

```dockerfile
# ✅ 灵活：可以覆盖参数
ENTRYPOINT ["node"]
CMD ["dist/server.js"]

# 用户可以 docker run myimage --version 跑 node --version
```

```dockerfile
# 也行：固定命令
CMD ["node", "dist/server.js"]
```

### 8. 信号处理 — 优雅关闭

```dockerfile
# ❌ Node 拿不到 SIGTERM
CMD ["npm", "start"]   # npm 拦截信号

# ✅
CMD ["node", "dist/server.js"]

# 或用 dumb-init / tini 处理 PID 1 信号
RUN apk add --no-cache dumb-init
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
```

应用层监听 SIGTERM 优雅关闭：
```js
process.on('SIGTERM', async () => {
  await server.close()
  await db.close()
  process.exit(0)
})
```

## docker-compose 模式

```yaml
version: '3.9'
services:
  app:
    build:
      context: .
      target: runner
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://postgres:pwd@db:5432/app
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: pwd
      POSTGRES_DB: app
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redisdata:/data
    restart: unless-stopped

volumes:
  pgdata:
  redisdata:
```

要点：
- `depends_on.condition: service_healthy` 等依赖就绪
- `restart: unless-stopped` 自动重启
- volume 持久化数据（不要直接 bind mount 到生产）

## 安全

### 1. 不要把密钥写在 Dockerfile

```dockerfile
# ❌ 永远不要
ENV API_KEY=sk-xxx

# ✅ 运行时注入
docker run -e API_KEY=$API_KEY ...
# 或 secret
docker run --secret api_key ...
```

### 2. 镜像扫描

```bash
# Trivy（最流行）
trivy image myapp:latest

# Snyk
snyk container test myapp:latest

# Docker Scout（内置）
docker scout cves myapp:latest
```

CI 集成：发现 HIGH/CRITICAL 漏洞失败构建。

### 3. 用固定 tag，不用 latest

```dockerfile
# ❌ latest 不可控
FROM node:latest

# ✅
FROM node:20.10.0-alpine3.18

# 更安全：用 digest
FROM node@sha256:abc123...
```

### 4. 减少安装的包

```dockerfile
# ❌
RUN apt-get update && apt-get install -y curl wget vim git

# ✅ 只装必需
RUN apk add --no-cache curl

# 用完就清
RUN apk add --no-cache --virtual .build-deps gcc python3 \
    && pip install ... \
    && apk del .build-deps
```

## 性能 / 体积优化

### 看镜像层

```bash
# Dive（强烈推荐）
dive myapp:latest
# 看每一层多大、能不能合并

# 自带
docker history myapp:latest
```

### COPY 限制范围

```dockerfile
# ❌ COPY . . 把整个项目带进去
COPY . .

# ✅ 只 COPY 需要的
COPY src ./src
COPY tsconfig.json package.json ./
```

### 共享 base layer

公司所有服务用同一个 base image，build 缓存共享：
```dockerfile
FROM mycompany/node-base:20  # 自己的标准 base
```

## 常见反模式

❌ `RUN apt-get update`不接 install → 缓存陈旧
   ✅ `RUN apt-get update && apt-get install -y ...`

❌ 写死密码 / 密钥
   ✅ env / secret 注入

❌ 容器内跑 cron / supervisord 多进程
   ✅ 一容器一进程，多任务用多容器或用 systemd（host 上）

❌ 用 ADD（自动解压、远程下载）
   ✅ 用 COPY + 显式 RUN curl

❌ EXPOSE 80 + 实际监听 0.0.0.0:80
   ✅ 监听 0.0.0.0（不要 127.0.0.1，外部访问不到）

❌ 镜像 > 1GB
   ✅ 多阶段 + slim base，正常应用 < 200MB

## 应用类型速查

### Node.js
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

### Go
```dockerfile
FROM golang:1.22 AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app/server ./cmd/server

FROM gcr.io/distroless/static-debian12
COPY --from=builder /app/server /server
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/server"]
```

最终 < 20MB。

### Python
```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --user -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH
COPY . .
USER nobody
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

### Java
```dockerfile
FROM eclipse-temurin:21-jdk AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

FROM eclipse-temurin:21-jre-alpine
COPY --from=builder /app/target/*.jar /app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app.jar"]
```

## 与其他技能的关系

- CI/CD → ci-cd-github-actions
- K8s 部署 → kubernetes-deployment
- 安全扫描 → security-best-practices
