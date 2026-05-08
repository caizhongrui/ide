---
name: kubernetes-deployment
description: 任何 K8s 资源 YAML / Helm Chart / 部署任务，**调用此技能**遵守生产级配置规范（资源限制、健康检查、滚动更新、安全），避免裸 Pod、无 limits、root 用户等常见错误。
---

# Kubernetes 部署最佳实践

## 适用场景

- 写新 Deployment / StatefulSet / Service / Ingress
- 配置探针 / 资源限制 / 副本数
- Helm Chart 编写
- 配置滚动更新 / 蓝绿
- ConfigMap / Secret 管理

## 8 条铁律

### 1. 永远用 Deployment，不用裸 Pod

```yaml
# ❌ 裸 Pod —— 挂了不会自动重启，节点失联就完蛋
apiVersion: v1
kind: Pod
metadata:
  name: my-app
...

# ✅ Deployment 管 ReplicaSet 管 Pod
apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: app
          image: my-app:1.2.3
```

何时用 StatefulSet：DB / 有状态、需要稳定网络标识、有序扩缩。

### 2. 资源 requests / limits 必须设

```yaml
resources:
  requests:
    cpu: 100m         # 0.1 core
    memory: 128Mi
  limits:
    cpu: 500m
    memory: 512Mi
```

**没设的代价**：
- requests 没设 → 调度器无法合理放，节点容易过载
- limits 没设 → 一个 Pod OOM 拖垮邻居

**经验**：
- requests 略低于平均使用 → 提高密度
- limits 留出 burst 空间 → 高峰不被杀
- memory limit 一定要设（CPU limit 有争议）
- limit / request 比例不要 > 4

### 3. 健康检查三件套

```yaml
livenessProbe:                     # 活着吗？挂了重启
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 30
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3

readinessProbe:                    # 能接流量吗？没就绪移出 Service
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 5

startupProbe:                      # 启动慢的 app（如 Java）用
  httpGet:
    path: /health
    port: 3000
  failureThreshold: 30
  periodSeconds: 10                # 最多等 5 分钟启动
```

**应用层语义**：
- `/health` (liveness)：进程没死锁、关键依赖**可选**检查
- `/ready` (readiness)：DB / Redis / 关键依赖**都连上**才返 200

### 4. 标签和选择器规范

```yaml
metadata:
  labels:
    app.kubernetes.io/name: my-app
    app.kubernetes.io/instance: my-app-prod
    app.kubernetes.io/version: "1.2.3"
    app.kubernetes.io/component: api
    app.kubernetes.io/part-of: shop
    app.kubernetes.io/managed-by: helm
```

K8s 推荐标签集：方便用 selector 查询 / 监控分组。

### 5. 镜像 tag 不用 latest

```yaml
# ❌
image: my-app:latest      # 每次拉到的可能不同 → 不可重现

# ✅
image: my-app:1.2.3
imagePullPolicy: IfNotPresent

# 更稳：用 SHA
image: my-app@sha256:abc123...
```

`imagePullPolicy`:
- `Always`：每次启动拉（latest 默认）
- `IfNotPresent`：节点上有就用（推荐）
- `Never`：不拉（适合 minikube 调试）

### 6. 不用 root + 文件系统只读

```yaml
spec:
  template:
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
        - name: app
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: tmp
              mountPath: /tmp
            - name: cache
              mountPath: /app/cache
      volumes:
        - name: tmp
          emptyDir: {}
        - name: cache
          emptyDir: {}
```

### 7. 配置和密钥分离

```yaml
# ConfigMap：非敏感配置
apiVersion: v1
kind: ConfigMap
metadata:
  name: my-app-config
data:
  LOG_LEVEL: info
  DATABASE_HOST: postgres.db.svc.cluster.local

---
# Secret：敏感（base64 但不是加密！要配 SealedSecrets / Vault / SOPS）
apiVersion: v1
kind: Secret
metadata:
  name: my-app-secrets
type: Opaque
stringData:
  DATABASE_PASSWORD: pwd
  JWT_SECRET: xxx
```

注入：
```yaml
env:
  - name: LOG_LEVEL
    valueFrom:
      configMapKeyRef:
        name: my-app-config
        key: LOG_LEVEL
  - name: DATABASE_PASSWORD
    valueFrom:
      secretKeyRef:
        name: my-app-secrets
        key: DATABASE_PASSWORD

# 或一次性导入所有键
envFrom:
  - configMapRef:
      name: my-app-config
  - secretRef:
      name: my-app-secrets
```

### 8. 滚动更新策略

```yaml
spec:
  replicas: 3
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1            # 最多多 1 个 Pod
      maxUnavailable: 0       # 不允许少（保证容量）
  minReadySeconds: 10         # 新 Pod 至少存活 10s 才算 ready
```

`maxUnavailable: 0` 保证升级期间不掉容量，但需要节点资源能多 1 个 Pod。

## Service / Ingress

```yaml
apiVersion: v1
kind: Service
metadata:
  name: my-app
spec:
  type: ClusterIP            # 内部访问（默认）
  selector:
    app.kubernetes.io/name: my-app
  ports:
    - name: http
      port: 80
      targetPort: 3000

---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-app
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
spec:
  ingressClassName: nginx
  tls:
    - hosts: [api.example.com]
      secretName: my-app-tls
  rules:
    - host: api.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-app
                port:
                  number: 80
```

## HPA（水平扩缩）

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-app
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300   # 缩容慢一点防抖
```

## PDB（防止驱逐过多）

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-app
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app.kubernetes.io/name: my-app
```

K8s 排空节点时，至少保留 2 个 Pod 跑。

## 优雅关闭（关键！）

```yaml
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 60
      containers:
        - name: app
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]   # 给 LB 时间摘掉这个 Pod
```

应用层监听 SIGTERM：
```js
let healthy = true
app.get('/ready', (req, res) => res.status(healthy ? 200 : 503).send())

process.on('SIGTERM', async () => {
  healthy = false                                       // 1. 标记不就绪
  await new Promise(r => setTimeout(r, 5000))           // 2. 等 LB 摘走
  await server.close()                                  // 3. 不接新请求
  await db.close()                                      // 4. 关连接
  process.exit(0)
})
```

## Helm Chart 模式

```
my-app/
├── Chart.yaml
├── values.yaml              # 默认值
├── values-prod.yaml         # 环境覆盖
└── templates/
    ├── deployment.yaml
    ├── service.yaml
    ├── ingress.yaml
    └── _helpers.tpl
```

```yaml
# templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "my-app.fullname" . }}
spec:
  replicas: {{ .Values.replicaCount }}
  template:
    spec:
      containers:
        - name: app
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
```

部署：
```bash
helm upgrade --install my-app ./my-app \
  -f values-prod.yaml \
  --set image.tag=1.2.3 \
  --namespace prod
```

## 监控 / 调试

```bash
# 看 Pod
kubectl get pods -n prod -l app=my-app

# 看日志
kubectl logs -f deployment/my-app -n prod
kubectl logs --previous pod-xxx -n prod  # 上次 crash 的日志

# 进容器
kubectl exec -it pod-xxx -n prod -- sh

# 描述（看事件）
kubectl describe pod pod-xxx -n prod

# 端口转发本地调试
kubectl port-forward svc/my-app 8080:80 -n prod

# 实时看资源用量
kubectl top pods -n prod
kubectl top nodes
```

## 常见反模式

❌ Deployment 没 selector 或 selector 与 template labels 不匹配
   ✅ selector.matchLabels 必须包含 template.metadata.labels 子集

❌ 写 hostNetwork: true / privileged: true
   ✅ 99% 应用不需要，安全风险

❌ secret 用 base64 当加密
   ✅ Sealed Secrets / External Secrets Operator / Vault

❌ 一个 Pod 多容器跑不相关服务
   ✅ Sidecar 模式仅用于 logging / proxy / 共享生命周期

❌ 数据库跑在 Deployment（emptyDir）
   ✅ StatefulSet + PersistentVolumeClaim

❌ 不设 namespace
   ✅ 按环境 / 团队分 ns，方便 RBAC 和限流

## 与其他技能的关系

- 容器构建 → docker-best-practices
- CI/CD 部署 → ci-cd-github-actions
- 微服务 → microservices-patterns
- 安全 → security-best-practices
