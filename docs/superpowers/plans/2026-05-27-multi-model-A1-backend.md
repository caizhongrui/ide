# Plan A1: 多模型选择 — qdport-ai-api 后端

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 qdport-ai-api 后端为 ai_business_model_config 表加 alias_code + 5 个用户面元数据字段，新增 GET /ai/proxy/available-models endpoint 暴露用户可见模型清单，改造 chat/completions endpoint 接受 aliasCode body 字段实现"按 alias 锁定行、绕过 priority fallback"。

**Architecture:** 两层路由——business_code 保留现有语义（业务场景分组 + priority fallback），新增 alias_code 作为用户面唯一 ID（1:1 锁定到具体行）。向后兼容：老客户端不传 alias 时行为完全不变。

**Tech Stack:** Java 8 + Spring Boot + MyBatis-Plus + Lombok + Sa-Token

**Spec 来源:** `docs/specs/2026-05-27-multi-model-selector.md` §3

**Repo cwd:** `/Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api`（**注意：当前 worktree 是 maxian 客户端，本 plan 必须切到 qdport-ai-api 执行**）

---

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `sql/V_multi_model_alias_code.sql` | Create | DDL：加 6 字段 + 唯一索引 + 复合索引 |
| `sql/V_multi_model_alias_init.sql` | Create | DML：把现有 IDE_CHAT_CODE / IDE_CHAT_ASK 行补 alias_code 等元数据 |
| `boyo-system/src/main/java/com/boyo/system/domain/AiBusinessModelConfig.java` | Modify | Entity 加 6 字段 |
| `boyo-system/src/main/resources/mapper/system/AiBusinessModelConfigMapper.xml` | Modify | resultMap + selectColumns + insert/update SQL 加 6 列 |
| `boyo-system/src/main/java/com/boyo/system/mapper/AiBusinessModelConfigMapper.java` | Modify | 加 `selectByAliasCode(String aliasCode)` 方法 |
| `boyo-system/src/main/java/com/boyo/system/service/IAiBusinessModelConfigService.java` | Modify | 加 `selectByAliasCode` 接口 + `listPublicModels()` 接口 |
| `boyo-system/src/main/java/com/boyo/system/service/impl/AiBusinessModelConfigServiceImpl.java` | Modify | 实现上面两个方法 |
| `boyo-knowledge/src/main/java/com/boyo/knowledge/domain/dto/AvailableModelVO.java` | Create | 用户面 DTO |
| `boyo-knowledge/src/main/java/com/boyo/knowledge/domain/dto/AiProxyRequest.java` | Modify | 加 `aliasCode` 字段 |
| `boyo-knowledge/src/main/java/com/boyo/knowledge/controller/AiProxyController.java` | Modify | 加 `GET /available-models` endpoint |
| `boyo-knowledge/src/main/java/com/boyo/knowledge/service/impl/AiProxyServiceImpl.java` | Modify | `routeModel`：若 request.aliasCode 非空，按 alias 锁定行；否则保持现 priority pool |

**改动总数**：2 新 SQL + 1 新 DTO + 1 新 Controller endpoint + 8 文件修改。

---

## 前置准备

- [ ] **Step 0: 确认仓库可编译**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-system,boyo-knowledge -am compile -q
```

Expected: 编译通过，无 error。如有 error 先解决再继续。

---

## Task 1: DDL — schema 迁移

**Files:**
- Create: `sql/V_multi_model_alias_code.sql`

- [ ] **Step 1: 写 DDL 文件**

文件内容（**完整**复制）：

```sql
-- 多模型选择功能 v0.2.25
-- 来源: docs/specs/2026-05-27-multi-model-selector.md §3.1

-- 给 ai_business_model_config 加 6 个字段：
--   alias_code         用户面唯一 ID（前端按这个标识具体模型行）
--   display_name       用户面显示文案
--   context_window     上下文窗口 token 数
--   supports_vision    是否支持图片输入
--   is_public          是否对用户面可见
--   sort_no            前端清单排序

ALTER TABLE ai_business_model_config
  ADD COLUMN alias_code      VARCHAR(64)  DEFAULT NULL COMMENT '用户面唯一 ID',
  ADD COLUMN display_name    VARCHAR(128) NOT NULL DEFAULT '' COMMENT '用户面显示文案',
  ADD COLUMN context_window  INT          DEFAULT NULL COMMENT '上下文窗口 token 数',
  ADD COLUMN supports_vision TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '是否支持图片输入',
  ADD COLUMN is_public       TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '是否对用户面可见',
  ADD COLUMN sort_no         INT          NOT NULL DEFAULT 0 COMMENT '前端清单排序';

-- alias_code 全表唯一索引（用户面 ID）。允许 NULL（fallback 行不需要 alias）。
CREATE UNIQUE INDEX uniq_aibmc_alias ON ai_business_model_config (alias_code);

-- 复合索引：endpoint /available-models 的过滤 + 排序
CREATE INDEX idx_aibmc_public_sort ON ai_business_model_config (is_public, sort_no);
```

- [ ] **Step 2: 在测试库执行 DDL**

```bash
mysql -h <test-db-host> -u <user> -p<password> qdport_ai < sql/V_multi_model_alias_code.sql
```

Expected: `Query OK, N rows affected`（N = 现有行数）+ 2 个 CREATE INDEX 成功。

- [ ] **Step 3: 验证字段已加**

```bash
mysql -h <test-db-host> -u <user> -p<password> qdport_ai -e "DESCRIBE ai_business_model_config" | grep -E "alias_code|display_name|context_window|supports_vision|is_public|sort_no"
```

Expected: 6 行输出，每个字段一行。

- [ ] **Step 4: 验证索引已建**

```bash
mysql -h <test-db-host> -u <user> -p<password> qdport_ai -e "SHOW INDEX FROM ai_business_model_config WHERE Key_name IN ('uniq_aibmc_alias', 'idx_aibmc_public_sort')"
```

Expected: 至少 2 行（每个索引一行）。

- [ ] **Step 5: Commit**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
git add sql/V_multi_model_alias_code.sql
git commit -m "feat(schema): ai_business_model_config 加 alias_code + 5 个用户面元数据字段 (#multi-model-selector)"
```

---

## Task 2: Entity 加字段

**Files:**
- Modify: `boyo-system/src/main/java/com/boyo/system/domain/AiBusinessModelConfig.java`

- [ ] **Step 1: 加 6 个字段**

在 `private String description;` 行后追加：

```java
    /** 用户面唯一 ID（前端按这个标识具体模型行，1:1 锁定到此行） */
    private String aliasCode;

    /** 用户面显示文案，如 "Claude Sonnet 4.5" */
    private String displayName;

    /** 上下文窗口 token 数 */
    private Integer contextWindow;

    /** 是否支持图片输入 */
    private Integer supportsVision;

    /** 是否对用户面可见（用户端模型选择器仅显示 is_public = 1 的行） */
    private Integer isPublic;

    /** 前端清单排序，升序 */
    private Integer sortNo;
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-system -am compile -q
```

Expected: 编译通过，0 error。

- [ ] **Step 3: Commit**

```bash
git add boyo-system/src/main/java/com/boyo/system/domain/AiBusinessModelConfig.java
git commit -m "feat(domain): AiBusinessModelConfig 加 alias_code + 5 个用户面元数据字段 (#multi-model-selector)"
```

---

## Task 3: Mapper XML 加字段映射

**Files:**
- Modify: `boyo-system/src/main/resources/mapper/system/AiBusinessModelConfigMapper.xml`

- [ ] **Step 1: 在 `<resultMap>` 内加 6 行 `<result>`**

在 `<result property="description"` 行后追加：

```xml
        <result property="aliasCode"         column="alias_code"        />
        <result property="displayName"       column="display_name"      />
        <result property="contextWindow"     column="context_window"    />
        <result property="supportsVision"    column="supports_vision"   />
        <result property="isPublic"          column="is_public"         />
        <result property="sortNo"            column="sort_no"           />
```

- [ ] **Step 2: 改 `<sql id="selectColumns">` 把新 6 列加进 SELECT**

把原 SELECT 改成：

```xml
    <sql id="selectColumns">
        SELECT id, business_code, business_name, business_category, provider, model,
               priority, is_enabled, temperature, max_tokens, description,
               alias_code, display_name, context_window, supports_vision, is_public, sort_no,
               create_time, update_time, create_by, update_by
        FROM ai_business_model_config
    </sql>
```

- [ ] **Step 3: 加 `<select id="selectByAliasCode">` 查询**

在 `<select id="selectByBusinessCode">` 后追加：

```xml
    <select id="selectByAliasCode" parameterType="String" resultMap="AiBusinessModelConfigResult">
        <include refid="selectColumns"/>
        WHERE alias_code = #{aliasCode}
          AND is_enabled = 1
        LIMIT 1
    </select>

    <select id="selectPublicList" resultMap="AiBusinessModelConfigResult">
        <include refid="selectColumns"/>
        WHERE is_enabled = 1
          AND is_public = 1
          AND alias_code IS NOT NULL
          AND alias_code != ''
        ORDER BY sort_no ASC, id ASC
    </select>
```

- [ ] **Step 4: 若 mapper 有 `<insert>` / `<update>` 语句也要加新字段**

```bash
grep -n "<insert\|<update" boyo-system/src/main/resources/mapper/system/AiBusinessModelConfigMapper.xml
```

如果有，按 mapper 现有 pattern 把 6 个新字段加到 column list + VALUES / SET 列表。

如果当前 mapper 没 `<insert>` / `<update>`（MyBatis-Plus 用 `BaseMapper` 自动生成 SQL，不需要手写），跳过本步。

- [ ] **Step 5: 验证编译通过 + mapper XML 合法**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-system -am compile -q
```

Expected: 编译通过。MyBatis 在启动时才会校验 XML resultMap 跟 entity 字段对齐，编译期不报错——这里仅确保 XML 语法合法。

- [ ] **Step 6: Commit**

```bash
git add boyo-system/src/main/resources/mapper/system/AiBusinessModelConfigMapper.xml
git commit -m "feat(mapper): AiBusinessModelConfigMapper 加新 6 字段 resultMap + selectByAliasCode/selectPublicList (#multi-model-selector)"
```

---

## Task 4: Mapper 接口加方法

**Files:**
- Modify: `boyo-system/src/main/java/com/boyo/system/mapper/AiBusinessModelConfigMapper.java`

- [ ] **Step 1: 先看现有 Mapper 接口结构**

```bash
cat boyo-system/src/main/java/com/boyo/system/mapper/AiBusinessModelConfigMapper.java
```

记下：
- 接口名 / package
- 是否 `extends BaseMapper<AiBusinessModelConfig>`（MyBatis-Plus）
- 现有方法签名

- [ ] **Step 2: 在接口里加 2 个方法**

按现有方法的 javadoc/annotation pattern 加：

```java
    /**
     * 按 alias_code 查询单行（用户在前端选了某个模型 → 后端用 alias 锁定行）。
     * 注：alias_code 全表唯一。
     */
    AiBusinessModelConfig selectByAliasCode(@Param("aliasCode") String aliasCode);

    /**
     * 用户面可见的模型清单：is_enabled=1 AND is_public=1 AND alias_code 非空，按 sort_no 升序。
     * 用于 GET /ai/proxy/available-models。
     */
    List<AiBusinessModelConfig> selectPublicList();
```

注意 `@Param` import：`import org.apache.ibatis.annotations.Param;`（如未 import）。

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-system -am compile -q
```

Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add boyo-system/src/main/java/com/boyo/system/mapper/AiBusinessModelConfigMapper.java
git commit -m "feat(mapper): AiBusinessModelConfigMapper 加 selectByAliasCode/selectPublicList 接口 (#multi-model-selector)"
```

---

## Task 5: Service 接口 + 实现

**Files:**
- Modify: `boyo-system/src/main/java/com/boyo/system/service/IAiBusinessModelConfigService.java`
- Modify: `boyo-system/src/main/java/com/boyo/system/service/impl/AiBusinessModelConfigServiceImpl.java`

- [ ] **Step 1: 接口加方法**

在 `IAiBusinessModelConfigService.java` 的现有方法后追加：

```java
    /**
     * 按 alias_code 锁定具体配置行（用户精确选择模型时用，绕过 priority fallback）。
     */
    AiBusinessModelConfig selectByAliasCode(String aliasCode);

    /**
     * 用户面可见的模型清单。
     */
    List<AiBusinessModelConfig> listPublicModels();
```

注意：如果文件没 import `List`，加 `import java.util.List;`。

- [ ] **Step 2: 实现类加方法**

在 `AiBusinessModelConfigServiceImpl.java` 的现有方法后追加：

```java
    @Override
    public AiBusinessModelConfig selectByAliasCode(String aliasCode) {
        if (aliasCode == null || aliasCode.isEmpty()) {
            return null;
        }
        return baseMapper.selectByAliasCode(aliasCode);
    }

    @Override
    public List<AiBusinessModelConfig> listPublicModels() {
        return baseMapper.selectPublicList();
    }
```

注意：如果文件没 import `List`，加 `import java.util.List;`。`baseMapper` 是 ServiceImpl 继承自 MyBatis-Plus 的字段。

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-system -am compile -q
```

Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add boyo-system/src/main/java/com/boyo/system/service/IAiBusinessModelConfigService.java \
        boyo-system/src/main/java/com/boyo/system/service/impl/AiBusinessModelConfigServiceImpl.java
git commit -m "feat(service): AiBusinessModelConfigService 加 selectByAliasCode/listPublicModels (#multi-model-selector)"
```

---

## Task 6: 新建 AvailableModelVO

**Files:**
- Create: `boyo-knowledge/src/main/java/com/boyo/knowledge/domain/dto/AvailableModelVO.java`

- [ ] **Step 1: 创建文件**

```java
package com.boyo.knowledge.domain.dto;

import lombok.Builder;
import lombok.Data;

/**
 * 用户面可见的模型 VO。
 *
 * 用于 GET /ai/proxy/available-models 响应字段。前端按 aliasCode 标识具体模型，
 * 用户选择后通过 chat/completions 的 aliasCode body 字段传回后端，
 * 后端按 alias 锁定具体行（绕过 priority fallback）。
 *
 * @author boyo
 * @date 2026-05-27
 */
@Data
@Builder
public class AvailableModelVO {

    /** 用户面唯一 ID（前端按这个标识 + 传回后端定位行） */
    private String aliasCode;

    /** 业务场景代码（仅作分组 / 调试展示，路由不依赖它） */
    private String businessCode;

    /** 用户面显示文案 */
    private String displayName;

    /** AI 提供商标识：openai / qwen / deepseek / claude 等 */
    private String provider;

    /** 上下文窗口 token 数（可能为 null，前端按默认 128k fallback） */
    private Integer contextWindow;

    /** 是否支持视觉输入 */
    private Boolean supportsVision;

    /** 排序，升序（后端已按此排序，前端展示原顺序即可） */
    private Integer sortNo;
}
```

- [ ] **Step 2: 验证编译通过**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-knowledge -am compile -q
```

Expected: 编译通过。

- [ ] **Step 3: Commit**

```bash
git add boyo-knowledge/src/main/java/com/boyo/knowledge/domain/dto/AvailableModelVO.java
git commit -m "feat(dto): 新增 AvailableModelVO 用户面模型清单 DTO (#multi-model-selector)"
```

---

## Task 7: AiProxyController 加 endpoint

**Files:**
- Modify: `boyo-knowledge/src/main/java/com/boyo/knowledge/controller/AiProxyController.java`

- [ ] **Step 1: 在 import 区加依赖**

在现有 import 末尾追加：

```java
import com.boyo.knowledge.domain.dto.AvailableModelVO;
import com.boyo.system.service.IAiBusinessModelConfigService;
import com.boyo.system.domain.AiBusinessModelConfig;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.util.StringUtils;
import org.springframework.web.bind.annotation.GetMapping;
import java.util.List;
import java.util.stream.Collectors;
```

去重：有些 import 上面已有，跳过即可。

- [ ] **Step 2: 在 class 内注入 Service**

在现有 `@Autowired` 字段（如 `private IAiProxyService aiProxyService;`）旁追加：

```java
    @Autowired
    private IAiBusinessModelConfigService aiBusinessModelConfigService;
```

- [ ] **Step 3: 在 class 末尾追加 endpoint 方法**

```java
    /**
     * 用户面可见的模型清单（用于客户端模型选择器）。
     *
     * 过滤：is_enabled=1 AND is_public=1 AND alias_code 非空
     * 排序：sort_no 升序
     */
    @GetMapping("/available-models")
    @Operation(summary = "用户面可见的模型清单", description = "供客户端模型选择器使用")
    public R<List<AvailableModelVO>> listAvailableModels() {
        try {
            List<AiBusinessModelConfig> rows = aiBusinessModelConfigService.listPublicModels();
            List<AvailableModelVO> list = rows.stream().map(r -> AvailableModelVO.builder()
                .aliasCode(r.getAliasCode())
                .businessCode(r.getBusinessCode())
                .displayName(StringUtils.hasText(r.getDisplayName()) ? r.getDisplayName() : r.getBusinessName())
                .provider(r.getProvider())
                .contextWindow(r.getContextWindow())
                .supportsVision(r.getSupportsVision() != null && r.getSupportsVision() == 1)
                .sortNo(r.getSortNo())
                .build()).collect(Collectors.toList());
            return R.ok(list);
        } catch (Exception e) {
            log.error("listAvailableModels 失败", e);
            return R.fail("获取模型清单失败: " + e.getMessage());
        }
    }
```

- [ ] **Step 4: 验证编译通过**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-knowledge -am compile -q
```

Expected: 编译通过。

- [ ] **Step 5: Commit**

```bash
git add boyo-knowledge/src/main/java/com/boyo/knowledge/controller/AiProxyController.java
git commit -m "feat(api): AiProxyController 加 GET /ai/proxy/available-models 端点 (#multi-model-selector)"
```

---

## Task 8: AiProxyRequest 加 aliasCode 字段

**Files:**
- Modify: `boyo-knowledge/src/main/java/com/boyo/knowledge/domain/dto/AiProxyRequest.java`

- [ ] **Step 1: 先看现有字段**

```bash
grep -n "private\s\+\(String\|Integer\|Boolean\|List\|Object\)\b" boyo-knowledge/src/main/java/com/boyo/knowledge/domain/dto/AiProxyRequest.java | head -10
```

- [ ] **Step 2: 在合适位置（businessCode 旁）加 aliasCode 字段**

找到 `private String businessCode;`，在它后面追加：

```java
    /**
     * 用户面模型 alias_code（多模型选择 v0.2.25）。
     * 若非空，服务端按 alias 锁定具体配置行，绕过 priority fallback。
     * 若为 null/空，保持原 businessCode + priority 行为（向后兼容）。
     */
    private String aliasCode;
```

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-knowledge -am compile -q
```

Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add boyo-knowledge/src/main/java/com/boyo/knowledge/domain/dto/AiProxyRequest.java
git commit -m "feat(dto): AiProxyRequest 加 aliasCode 字段（多模型选择 alias 锁定路由）(#multi-model-selector)"
```

---

## Task 9: AiProxyService 路由分支：alias 优先于 businessCode

**Files:**
- Modify: `boyo-knowledge/src/main/java/com/boyo/knowledge/service/impl/AiProxyServiceImpl.java`

- [ ] **Step 1: 找现有路由方法**

```bash
grep -n "selectByBusinessCode\|aiBusinessModelConfigService\." boyo-knowledge/src/main/java/com/boyo/knowledge/service/impl/AiProxyServiceImpl.java | head -10
```

记下：
- 哪个方法调用了 `selectByBusinessCode` —— 这就是要改的路由点
- 它的方法名（可能叫 `routeModel` / `getConfig` / `resolveConfig` 等）

- [ ] **Step 2: 在路由方法入口加 alias 分支**

找到 `selectByBusinessCode(request.getBusinessCode())` 调用点（设当前文件中此调用对应方法名为 `M`），改成：

```java
    // M(...) 方法体修改示例：
    public AiBusinessModelConfig resolveModelConfig(AiProxyRequest request) {
        // alias 优先：用户明确指定了，直接锁定到此行，不走 priority fallback
        if (request.getAliasCode() != null && !request.getAliasCode().isEmpty()) {
            AiBusinessModelConfig byAlias = aiBusinessModelConfigService.selectByAliasCode(request.getAliasCode());
            if (byAlias != null && byAlias.getIsEnabled() != null && byAlias.getIsEnabled() == 1) {
                log.debug("路由按 alias 锁定: alias={}, provider={}, model={}",
                    request.getAliasCode(), byAlias.getProvider(), byAlias.getModel());
                return byAlias;
            }
            log.warn("alias_code={} 未找到或已禁用，回退到 business_code + priority", request.getAliasCode());
        }
        // 老逻辑：按 business_code + priority 选 active 行（保持向后兼容）
        return aiBusinessModelConfigService.selectByBusinessCode(request.getBusinessCode());
    }
```

如果当前文件路由逻辑是 inline 在 `forwardRequest`/`forwardStreamRequest` 等方法里、不是单独 `resolveModelConfig` 方法，**先抽出来**成独立方法，然后改入口；或者在 inline 位置加 alias 优先分支。**保留原 businessCode 分支作 fallback**。

- [ ] **Step 3: 验证编译通过**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-knowledge -am compile -q
```

Expected: 编译通过。

- [ ] **Step 4: Commit**

```bash
git add boyo-knowledge/src/main/java/com/boyo/knowledge/service/impl/AiProxyServiceImpl.java
git commit -m "feat(service): AiProxyService routeModel 加 alias 优先分支，绕过 priority fallback (#multi-model-selector)"
```

---

## Task 10: 初始化 SQL — 给现有 business_code 行打 alias

**Files:**
- Create: `sql/V_multi_model_alias_init.sql`

- [ ] **Step 1: 先查现有 ai_business_model_config 行**

```bash
mysql -h <test-db-host> -u <user> -p<password> qdport_ai \
  -e "SELECT id, business_code, business_name, provider, model, priority FROM ai_business_model_config WHERE is_enabled = 1 ORDER BY business_code, priority"
```

记下结果（哪些行需要 alias_code）。**典型情况**：
- IDE_CHAT_CODE 有 1 行（claude / claude-sonnet-4-5）→ 标记为 sonnet45-code
- IDE_CHAT_ASK 有 1 行（claude / claude-sonnet-4-5）→ 标记为 sonnet45-ask
- 其他 business_code 的行如果不打算暴露给用户，保持 is_public=0 + alias_code=NULL，仅作 fallback

- [ ] **Step 2: 写初始化 SQL 文件**

根据 Step 1 实际查出的行，写 UPDATE 语句。**示例模板**（按实际业务名调整 alias_code 和 display_name）：

```sql
-- 多模型选择功能 v0.2.25 数据初始化
-- 来源: docs/specs/2026-05-27-multi-model-selector.md §3.1

-- IDE Code 模式默认模型
UPDATE ai_business_model_config
SET alias_code = 'sonnet45-code',
    display_name = 'Claude Sonnet 4.5',
    context_window = 200000,
    supports_vision = 1,
    is_public = 1,
    sort_no = 10
WHERE business_code = 'IDE_CHAT_CODE'
  AND provider = 'claude'
  AND alias_code IS NULL
LIMIT 1;

-- IDE Ask 模式默认模型
UPDATE ai_business_model_config
SET alias_code = 'sonnet45-ask',
    display_name = 'Claude Sonnet 4.5 (Ask)',
    context_window = 200000,
    supports_vision = 1,
    is_public = 1,
    sort_no = 20
WHERE business_code = 'IDE_CHAT_ASK'
  AND provider = 'claude'
  AND alias_code IS NULL
LIMIT 1;

-- 验证：返回应该 ≥ 2
SELECT alias_code, business_code, display_name, context_window, supports_vision, is_public, sort_no
FROM ai_business_model_config
WHERE is_public = 1
ORDER BY sort_no;
```

如果用户业务上还想给同一 business_code 挂 deepseek / qwen 等其他模型作可选项，按上面 pattern 复制 + 改 provider/model/alias_code 即可。

- [ ] **Step 3: 在测试库执行**

```bash
mysql -h <test-db-host> -u <user> -p<password> qdport_ai < sql/V_multi_model_alias_init.sql
```

Expected: 每条 UPDATE 返回 `Query OK, 1 row affected`；最后 SELECT 至少 2 行。

- [ ] **Step 4: Commit**

```bash
git add sql/V_multi_model_alias_init.sql
git commit -m "feat(data): 初始化 SQL — 给 IDE_CHAT_CODE / IDE_CHAT_ASK 行打 alias_code + 元数据 (#multi-model-selector)"
```

---

## Task 11: 集成验证（端到端）

**Files:** 无新代码，仅手动验证。

- [ ] **Step 1: 启动应用**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-admin spring-boot:run
```

Expected: 应用启动到 `Started <App> in N.NN seconds`，看到 `/ai/proxy/available-models` 路由 mapped。

如有 MyBatis XML / Entity 字段不匹配的错误，回 Task 3/Task 2 检查 resultMap。

- [ ] **Step 2: 登录拿 token**

按现有项目登录流程拿到 Authorization token：

```bash
# 假设登录接口
curl -X POST http://localhost:<port>/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}'
# 记下返回的 token
export TOKEN=<token>
```

- [ ] **Step 3: 调用 /available-models endpoint**

```bash
curl -X GET http://localhost:<port>/ai/proxy/available-models \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

Expected: 200 OK，response body 形如：

```json
{
  "code": 200,
  "msg": "success",
  "data": [
    {
      "aliasCode": "sonnet45-code",
      "businessCode": "IDE_CHAT_CODE",
      "displayName": "Claude Sonnet 4.5",
      "provider": "claude",
      "contextWindow": 200000,
      "supportsVision": true,
      "sortNo": 10
    },
    {
      "aliasCode": "sonnet45-ask",
      "businessCode": "IDE_CHAT_ASK",
      "displayName": "Claude Sonnet 4.5 (Ask)",
      "provider": "claude",
      "contextWindow": 200000,
      "supportsVision": true,
      "sortNo": 20
    }
  ]
}
```

- [ ] **Step 4: 用 aliasCode 调一次 chat/completions 验证路由**

```bash
curl -X POST http://localhost:<port>/ai/proxy/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessCode": "IDE_CHAT_CODE",
    "aliasCode": "sonnet45-code",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Expected:
- HTTP 200
- 服务端日志看到 `路由按 alias 锁定: alias=sonnet45-code, provider=claude, model=claude-sonnet-4-5`（Task 9 加的 log）
- response 来自 claude，不是其他 provider

- [ ] **Step 5: 验证向后兼容（不传 aliasCode）**

```bash
curl -X POST http://localhost:<port>/ai/proxy/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessCode": "IDE_CHAT_CODE",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Expected:
- HTTP 200
- 服务端日志**没有** `路由按 alias 锁定` 行（因为没传 alias）
- 走原 priority 路径，response 正常返回

- [ ] **Step 6: 验证未知 alias 回退**

```bash
curl -X POST http://localhost:<port>/ai/proxy/chat/completions \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "businessCode": "IDE_CHAT_CODE",
    "aliasCode": "non-existent-alias",
    "messages": [{"role":"user","content":"hi"}]
  }'
```

Expected:
- HTTP 200
- 服务端日志看到 `alias_code=non-existent-alias 未找到或已禁用，回退到 business_code + priority`
- response 正常（走 fallback）

- [ ] **Step 7: Commit（无代码改动，仅文档）**

如果验证过程中发现任何 bug，回相应 Task 修复后重 commit。验证全过则不 commit。

---

## Task 12: 协议文档更新

**Files:**
- Modify: 如果 qdport-ai-api 有 API 文档目录（如 docs/ / docs/api/ / *.md）

- [ ] **Step 1: 找 API 文档位置**

```bash
ls /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api/docs/ 2>/dev/null
find /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api -maxdepth 3 -name "*api*.md" 2>/dev/null | head -5
```

- [ ] **Step 2: 加新 endpoint 文档**

按现有文档 pattern 追加 `GET /ai/proxy/available-models` 的入参/返回字段说明 + `POST /ai/proxy/chat/completions` 加 `aliasCode` body 字段（可选）。

如果项目没集中 API 文档：跳过本 Task。Swagger UI 通过 `@Operation` annotation 自动生成。

- [ ] **Step 3: Commit（如有改动）**

```bash
git add docs/<api-doc-path>
git commit -m "docs(api): 补 /ai/proxy/available-models + chat/completions aliasCode 字段 (#multi-model-selector)"
```

---

## 收尾

- [ ] **Step 1: 复查 commit 列表**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
git log --oneline -15
```

Expected: 至少 11 个 #multi-model-selector commit（每个 Task 一个）。

- [ ] **Step 2: 让 Plan B 可以开始**

- 通知 sidecar 开发者：endpoint `GET /ai/proxy/available-models` 已上线（测试环境），可以开始 Plan B 实施
- 在 maxian 仓 spec 文档加一行 "Plan A1 已完成 → endpoint 已可用" 注记（可选）

- [ ] **Step 3: 部署测试环境 + 通知 QA**

按 qdport-ai-api 既有部署流程发到测试环境。QA 验证 4 个场景（同 Task 11）。

- [ ] **Step 4: 准备生产部署窗口**

- DBA 准备执行 V_multi_model_alias_code.sql + V_multi_model_alias_init.sql
- 应用滚动升级
- 监控应用 startup log 看有无 MyBatis resultMap 错误

---

## 自验收清单

- [ ] DDL 在测试库执行成功，6 字段 + 2 索引就位
- [ ] 应用启动无 MyBatis 错误
- [ ] `GET /ai/proxy/available-models` 返回 ≥ 2 条公开模型
- [ ] `POST /ai/proxy/chat/completions` 带 aliasCode → 服务端日志确认按 alias 路由
- [ ] `POST /ai/proxy/chat/completions` 不带 aliasCode → 走原 priority 行为
- [ ] 未知 aliasCode → 自动 fallback 不报错
- [ ] 11 个 commit 都 #multi-model-selector tag，可独立 cherry-pick

---

## Notes

- **本 plan 不在 maxian worktree 内执行**——所有步骤的 `cd` 都在 `/Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api`
- 项目当前测试 infra 弱（仅 demo unit test），不写 JUnit，改用集成验证 + 日志确认
- 后续 Plan A2（admin Vue 表单）依赖本 plan 的 schema；Plan B (sidecar) 依赖本 plan 的 endpoint
- 协议层增量是 minor（新 endpoint + 新可选 body 字段），向后完全兼容
