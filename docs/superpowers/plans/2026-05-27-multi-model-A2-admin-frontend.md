# Plan A2: 多模型选择 — qdport/ai/ui Vue admin 表单

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 qdport/ai/ui 的 `aiBusinessModel/index.vue` 页面加 6 个新字段（alias_code / display_name / context_window / supports_vision / is_public / sort_no）的表单输入 + 列表显示 + 必填/唯一性校验，让管理员能可视化维护用户面模型清单。

**Architecture:** 直接扩展现有 boyo-flowable-plus admin CRUD 页面，沿用 Element UI 组件。alias_code 唯一性通过提交时调后端 API 验证（不在前端做全表扫描）。

**Tech Stack:** Vue 2 + Element UI + boyo-flowable-plus + vue-cli

**Spec 来源:** `docs/specs/2026-05-27-multi-model-selector.md` §3.4

**Repo cwd:** `/Users/caizhongrui/Documents/workspace/qdport/ai/ui`

**Plan 依赖:** Plan A1 已完成（后端 schema + Entity 字段就绪，否则编辑保存会失败）

---

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `src/views/system/aiBusinessModel/index.vue` | Modify | 加表单字段 + 表格列 + 校验 |
| `src/api/system/aiBusinessModel.js` | Modify（如有） | 若需新增 `checkAliasUnique` API，加 |

---

## Task 1: 现状速读 + 备份

- [ ] **Step 1: 复制现有页面备份**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/ui
cp src/views/system/aiBusinessModel/index.vue src/views/system/aiBusinessModel/index.vue.bak
```

(后续 commit 前删 .bak)

- [ ] **Step 2: 找现有 dataform 和 table 区**

```bash
grep -n "el-table\|el-table-column\|el-form-item.*businessCode\|el-form-item.*provider\|el-dialog\|form:\s*{" src/views/system/aiBusinessModel/index.vue | head -25
```

记下：
- `<el-dialog>` 表单的 ref 名（通常 `form` 或 `dataForm`）
- `<el-table>` columns 在哪几行
- `data().form` 初始值结构
- `rules` 校验规则在哪

---

## Task 2: 表格列加 6 列

**Files:** `src/views/system/aiBusinessModel/index.vue`

- [ ] **Step 1: 在 `<el-table>` 内加新列**

在现有 `<el-table-column prop="businessCode">` 之后追加（按顺序）：

```html
        <el-table-column
          label="用户面 ID"
          align="center"
          prop="aliasCode"
          width="150"
        >
          <template slot-scope="scope">
            <el-tag v-if="scope.row.aliasCode" size="mini" type="primary">{{ scope.row.aliasCode }}</el-tag>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column
          label="显示名称"
          align="center"
          prop="displayName"
          width="180"
          show-overflow-tooltip
        />
        <el-table-column
          label="上下文窗口"
          align="center"
          prop="contextWindow"
          width="110"
        >
          <template slot-scope="scope">
            <span v-if="scope.row.contextWindow">{{ (scope.row.contextWindow / 1000).toFixed(0) }}K</span>
            <span v-else class="text-muted">—</span>
          </template>
        </el-table-column>
        <el-table-column
          label="视觉"
          align="center"
          prop="supportsVision"
          width="60"
        >
          <template slot-scope="scope">
            <i v-if="scope.row.supportsVision === 1" class="el-icon-picture-outline" style="color:#67C23A"></i>
            <i v-else class="el-icon-minus" style="color:#909399"></i>
          </template>
        </el-table-column>
        <el-table-column
          label="公开"
          align="center"
          prop="isPublic"
          width="60"
        >
          <template slot-scope="scope">
            <el-tag v-if="scope.row.isPublic === 1" type="success" size="mini">公开</el-tag>
            <el-tag v-else type="info" size="mini">内部</el-tag>
          </template>
        </el-table-column>
        <el-table-column
          label="排序"
          align="center"
          prop="sortNo"
          width="70"
        />
```

- [ ] **Step 2: 在搜索区 `<el-form-item>` 加 is_public 筛选**

在现有 `el-form-item label="状态"` 之后追加：

```html
        <el-form-item label="是否公开" prop="isPublic">
          <el-select
            v-model="queryParams.isPublic"
            style="width: 200px"
            placeholder="请选择是否公开"
            clearable
          >
            <el-option label="公开" :value="1" />
            <el-option label="内部" :value="0" />
          </el-select>
        </el-form-item>
        <el-form-item label="Alias 代码" prop="aliasCode">
          <el-input
            v-model="queryParams.aliasCode"
            placeholder="请输入 alias 代码"
            clearable
            style="width: 200px"
            @keyup.enter.native="handleQuery"
          />
        </el-form-item>
```

- [ ] **Step 3: 在 `data().queryParams` 初始值里加 2 个字段**

找 `data()` 返回值的 `queryParams: { ... }`，在末尾追加：

```js
        isPublic: undefined,
        aliasCode: undefined,
```

- [ ] **Step 4: 验证 dev 启动 + 列表渲染正常**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/ui
NODE_OPTIONS='--openssl-legacy-provider' npm run dev
```

浏览器访问 `http://localhost:<port>/system/aiBusinessModel`：列表表头多了 6 列（Alias/显示名称/上下文/视觉/公开/排序）；搜索区多了 2 个筛选项。

- [ ] **Step 5: Commit**

```bash
git add src/views/system/aiBusinessModel/index.vue
git commit -m "feat(admin): aiBusinessModel 列表表头加 6 列 + 搜索区加 is_public/alias_code 筛选 (#multi-model-selector)"
```

---

## Task 3: 编辑/新增表单加 6 个字段输入

**Files:** `src/views/system/aiBusinessModel/index.vue`

- [ ] **Step 1: 找 `<el-dialog>` 表单**

```bash
grep -n "<el-dialog\|<el-form\s*ref" src/views/system/aiBusinessModel/index.vue
```

记下 `<el-dialog>` 的 visible / ref / title 属性。

- [ ] **Step 2: 在表单适当位置加 6 个 form-item**

找到 dialog 内的 `<el-form ref="form">`，在现有最后一个 `el-form-item`（通常是 description）后追加：

```html
        <el-divider content-position="left">用户面元数据（多模型选择）</el-divider>

        <el-form-item label="用户面 ID" prop="aliasCode">
          <el-input
            v-model="form.aliasCode"
            placeholder="如 sonnet45 / deepseek-v4；留空则此行仅作 priority fallback"
            clearable
            style="width: 350px"
            maxlength="64"
            show-word-limit
          />
          <div class="form-item-hint">全表唯一；如勾选"对用户公开"则必填</div>
        </el-form-item>

        <el-form-item label="显示名称" prop="displayName">
          <el-input
            v-model="form.displayName"
            placeholder="如 Claude Sonnet 4.5（用户面看到的文案）"
            clearable
            style="width: 350px"
            maxlength="128"
          />
        </el-form-item>

        <el-form-item label="上下文窗口" prop="contextWindow">
          <el-input-number
            v-model="form.contextWindow"
            :min="0"
            :step="10000"
            placeholder="如 200000 表示 200k tokens"
            style="width: 200px"
          />
          <span class="form-item-hint" style="margin-left:10px">单位：tokens（不是 1000）</span>
        </el-form-item>

        <el-form-item label="支持视觉" prop="supportsVision">
          <el-switch
            v-model="form.supportsVision"
            :active-value="1"
            :inactive-value="0"
            active-text="支持图片输入"
            inactive-text="仅文本"
          />
        </el-form-item>

        <el-form-item label="对用户公开" prop="isPublic">
          <el-switch
            v-model="form.isPublic"
            :active-value="1"
            :inactive-value="0"
            active-text="用户端可选"
            inactive-text="仅内部 fallback"
          />
          <div class="form-item-hint">勾选后必须填了"用户面 ID"才能保存</div>
        </el-form-item>

        <el-form-item label="排序" prop="sortNo">
          <el-input-number
            v-model="form.sortNo"
            :min="0"
            :step="10"
            placeholder="升序"
            style="width: 200px"
          />
          <span class="form-item-hint" style="margin-left:10px">数字越小越靠前</span>
        </el-form-item>
```

- [ ] **Step 3: 在 `data().form` 初始值里加 6 个字段**

找 `form: { ... }` 初始值（通常在 `data()` 或 `reset()` 里），在末尾追加：

```js
        aliasCode: undefined,
        displayName: undefined,
        contextWindow: undefined,
        supportsVision: 0,
        isPublic: 0,
        sortNo: 0,
```

- [ ] **Step 4: 在 `data().rules` 加校验规则**

找 `rules: { ... }`，追加：

```js
        aliasCode: [
          { max: 64, message: '不超过 64 字符', trigger: 'blur' },
          {
            pattern: /^[a-zA-Z0-9_-]*$/,
            message: '只允许字母/数字/下划线/短横',
            trigger: 'blur'
          },
          // is_public=1 时必填，是 dynamic rule，在 submitForm 里另查
        ],
        displayName: [
          { max: 128, message: '不超过 128 字符', trigger: 'blur' },
        ],
```

- [ ] **Step 5: 在 `submitForm` 方法加 is_public 必填 + alias 唯一校验**

找 `submitForm` 方法（通常 ref="form" 的 validate 回调），在 `this.$refs.form.validate((valid) => { if (valid) { ... } })` 入口加：

```js
        // 多模型选择: is_public=1 时 alias_code 必填
        if (this.form.isPublic === 1 && (!this.form.aliasCode || !this.form.aliasCode.trim())) {
          this.$message.error('对用户公开的模型必须填"用户面 ID（alias_code）"');
          return;
        }
        // alias_code 唯一性：依赖后端 unique index 兜底（提交时若冲突会 5xx，
        // 这里不预先调 check API，避免额外 round-trip）
```

如果发现现有 submitForm 不在 dialog 提交时调用，调整位置：搜索 `aiBusinessModelApi.add\|aiBusinessModelApi.update` 找到 API 调用点，在它前面 insert 上面这段校验。

- [ ] **Step 6: 处理 unique 冲突错误提示**

找 `add / update` API 调用的 `.catch` 分支，改成识别 1062 错误（MySQL 唯一索引冲突）给中文提示：

```js
        .catch(err => {
          const msg = err?.response?.data?.msg || err?.message || '保存失败';
          if (msg.includes('uniq_aibmc_alias') || msg.includes('Duplicate entry')) {
            this.$message.error('用户面 ID 已被其他行占用，请换一个');
          } else {
            this.$message.error('保存失败: ' + msg);
          }
        });
```

- [ ] **Step 7: 加 .form-item-hint CSS**

在 `<style>` 末尾追加：

```css
.form-item-hint {
  font-size: 12px;
  color: #909399;
  line-height: 1.6;
}
```

- [ ] **Step 8: 验证 dev 启动 + 表单弹窗正常**

刷新浏览器，点"新增"按钮：弹窗有原字段 + 6 个新字段 + 切换 is_public switch hint 显示正确。

测：
- alias_code 填非法字符（如 `abc$`）→ 校验失败提示
- is_public=1 + alias_code 空 → 提交失败弹"必须填用户面 ID"
- alias_code 跟现有冲突 → 后端 5xx → 弹"用户面 ID 已被占用"
- 全字段填正确 → 保存成功，列表立刻看到新行

- [ ] **Step 9: Commit**

```bash
git add src/views/system/aiBusinessModel/index.vue
git commit -m "feat(admin): aiBusinessModel 表单加 6 字段输入 + alias 校验/唯一冲突提示 (#multi-model-selector)"
```

---

## Task 4: 删备份 + 验证 build 通过

- [ ] **Step 1: 删 .bak**

```bash
rm src/views/system/aiBusinessModel/index.vue.bak
```

- [ ] **Step 2: 生产构建**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/ui
NODE_OPTIONS='--openssl-legacy-provider' npm run build:prod
```

Expected: 编译成功，dist/ 产物完整。

- [ ] **Step 3: Commit（如有产物 / lint 改动）**

如果生产构建过程改了某些 lint 文件，一起 commit：

```bash
git add -u
git commit -m "chore(admin): build:prod 后 lint 修复 (#multi-model-selector)" 2>/dev/null || echo "nothing to commit"
```

---

## Task 5: 端到端验证

- [ ] **Step 1: 启动后端（要 Plan A1 已完成）**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/qdport-ai-api
mvn -pl boyo-admin spring-boot:run
```

- [ ] **Step 2: 启动 admin 前端**

```bash
cd /Users/caizhongrui/Documents/workspace/qdport/ai/ui
NODE_OPTIONS='--openssl-legacy-provider' npm run dev
```

- [ ] **Step 3: 浏览器登录 + 进 aiBusinessModel 页面**

- 看列表能否正确显示新 6 列（已经被 Plan A1 Task 10 初始化的行应该 alias 有值）
- 编辑某行 → 表单已勾选 is_public、填了 alias_code → 保存
- 新建一行 → 填全字段 → 保存
- 故意 alias_code 重名 → 报错"已被占用"
- 搜索框输入 alias_code 子串 → 列表正确过滤

- [ ] **Step 4: 复查 /ai/proxy/available-models 输出**

```bash
curl -X GET http://localhost:<port>/ai/proxy/available-models \
  -H "Authorization: Bearer $TOKEN"
```

新加的行应该出现在 response.data 里（如果 is_public=1）。

---

## 自验收清单

- [ ] 列表表头 6 个新列正确显示
- [ ] 搜索区 alias_code / is_public 筛选生效
- [ ] 新增/编辑弹窗 6 个新字段输入正常
- [ ] is_public + 空 alias → 阻止提交
- [ ] alias 重复 → 后端冲突提示翻译为中文
- [ ] dev / build:prod 都通过
- [ ] 2 个 commit（表头 + 表单）都 tag #multi-model-selector

---

## Notes

- 本 plan 跟 Plan A1 共享同一个 qdport 仓库 git history
- 严格不依赖 Plan B / C（admin 后台是独立闭环）
- alias_code 唯一性走"后端 unique 索引兜底 + 前端识别 1062 翻译"路径，不写 check API，简化实现
- 现有 Element UI 1.x 组件足够覆盖，不引入新依赖
