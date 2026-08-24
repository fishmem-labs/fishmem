# Mem0 的 Organization / Project / Members 模型

> 调研日期：2026-08-22
> 范围：Mem0 Platform 官方文档、官方 API Reference、官方定价与条款、官方 GitHub SDK 源码。
> 不包含：对 Mem0 闭源 Dashboard 或后端数据库的逆向猜测。

## 结论

Mem0 公开出来的模型不是 `User → Project`，也不是把 Organization 仅作为一个 UI 分组；它是明确的两层租户与两层成员关系：

```text
Account / human user
  └─ Organization
       ├─ Organization Members (READER / OWNER)
       └─ Project
            ├─ Project Members (READER / OWNER)
            ├─ Project-specific API Keys
            ├─ Memories / Entities / Events
            ├─ Webhooks
            └─ Extraction / categories / graph / decay settings
```

最硬的边界是 **Project**：

- Organization 是团队、所有权和付费计划的上层容器；Project 必须在某个 Organization 内创建。[Create Organization](https://docs.mem0.ai/api-reference/organization/create-org)、[Create Project](https://docs.mem0.ai/api-reference/project/create-project)
- Project 是 memory 数据、配置和 API 运行时的隔离边界。官方直接把创建 Project 描述为“within an organization … to isolate memory resources”，删除 Project 会删除其 memories、messages 和关联数据。[Organizations & Projects](https://docs.mem0.ai/api-reference/organizations-projects)、[Delete Project](https://docs.mem0.ai/api-reference/project/delete-project)
- Mem0 同时提供 Organization member 与 Project member API；移除 Organization member 会撤销其对该组织 projects/resources 的访问，移除 Project member 只撤销其对该 Project 的 memories/configuration/resources 的访问。[Remove Organization Member](https://docs.mem0.ai/api-reference/organization/remove-org-member)、[Remove Project Member](https://docs.mem0.ai/api-reference/project/remove-project-member)
- 数据面不依赖 Dashboard 当前选中了什么。当前 SDK 只接收 API key，启动时用 `/v1/ping/` 从 key 解析 `org_id + project_id`；官方要求使用 **project-specific API key** 来指向另一个项目。[Organizations & Projects](https://docs.mem0.ai/api-reference/organizations-projects)、[官方 Python SDK 源码（2026-08-21 commit）](https://github.com/mem0ai/mem0/blob/feb12852c0789a1f1182b05ee0dbc386037b012f/mem0/client/main.py#L95-L173)

因此，FishMem 当前问题不能靠“把顶部 Select project 的 fallback 修好”解决。正确借鉴点是：**Organization 负责团队与计费，Project 负责数据隔离；Members 必须明确是组织成员还是项目成员；API key 永远显式归属一个 Project。**

## 证据等级

| 标签 | 含义 |
| --- | --- |
| **公开事实** | 当前官方 API、文档、定价或 SHA 固定的官方 SDK 源码明确说明 |
| **强推断** | 多项公开字段和行为一致支持，但 Mem0 未公开后端实现 |
| **未知** | 闭源 Dashboard、数据库或计费系统未公开，不能当成事实 |

## 1. 实体层级与租户隔离

### Organization

**公开事实：** Organization 用来管理 projects、members 和 memory resources。创建 Organization 的接口只返回 `org_id`，不会在响应中返回新 Project，因此“新建任意 Organization 一定自动创建默认 Project”不能从这个 API 得出。[Create Organization](https://docs.mem0.ai/api-reference/organization/create-org)

Organization 返回模型包含：

- `members`
- `invitations`
- `is_default`
- `is_owner`
- 当前调用者的 `user_role`
- `owner_pricing_plan`
- Organization 级 `byok_enabled`

来源：[Get Organization](https://docs.mem0.ai/api-reference/organization/get-org)、[Get Organizations](https://docs.mem0.ai/api-reference/organization/get-orgs)

这说明 Organization 不只是一个名称分组：它承载默认选择、所有者、成员、待处理邀请、计划信息与 BYOK 能力。

### Project

**公开事实：** Project 必须通过嵌套路径创建：

```text
POST /api/v1/orgs/organizations/{org_id}/projects/
```

项目列表返回 `is_default`、`user_role`、members，以及项目级记忆配置，包括 `custom_instructions`、`custom_categories`、graph、multilingual、decay 等。[Get Projects](https://docs.mem0.ai/api-reference/project/get-projects)、[Update Project](https://docs.mem0.ai/api-reference/project/update-project)

这意味着：

1. Organization 是父容器；Project 不是与 Organization 平级的“另一个 workspace”。
2. memory extraction、category、graph、decay 等产品设置属于 Project，而不是用户 Profile 或 Organization 全局设置。
3. Project 既是配置边界，也是销毁数据的生命周期边界。

### Memory end user 不是团队 Member

Mem0 还有 `user_id / agent_id / app_id / run_id` 等 memory entity scope。它们是 Project 内的数据命名空间，不是能登录 Dashboard、管理成员或持有角色的团队账号。[Entity-Scoped Memory](https://docs.mem0.ai/platform/features/entity-scoped-memory)

这也解释了定价页为什么一边写 “Unlimited end users”，另一边仍有 Organization/Project Members：`end user` 是客户应用里的 memory subject，`member` 是 Mem0 控制面的协作者。[Mem0 Pricing](https://mem0.ai/pricing)

FishMem 必须保留这条语义边界：

```text
OrganizationMember / ProjectMember != Memory user_id
```

## 2. Members：Mem0 是两套成员关系

### Organization Members

官方提供独立的 Organization member 接口：list、add、update role、remove。当前 API 文档只定义两种角色：

| 角色 | 官方语义 |
| --- | --- |
| `READER` | 查看 Organization resources |
| `OWNER` | 完整管理 Organization 及其 resources |

来源：[Add Organization Member](https://docs.mem0.ai/api-reference/organization/add-org-member)、[Update Organization Member](https://docs.mem0.ai/api-reference/organization/update-org-member)

移除 Organization member 的官方描述是撤销其对 Organization 的 **projects and resources** 的访问。[Remove Organization Member](https://docs.mem0.ai/api-reference/organization/remove-org-member)

### Project Members

Project 也有独立的 list、add、update role、remove 接口，角色同样是 `READER / OWNER`：

| 角色 | 官方语义 |
| --- | --- |
| `READER` | 查看和搜索 memories，不能修改 Project 设置或管理成员 |
| `OWNER` | 修改 Project、管理 Project members，并拥有 Reader 权限 |

来源：[Organizations & Projects](https://docs.mem0.ai/api-reference/organizations-projects)、[Add Project Member](https://docs.mem0.ai/api-reference/project/add-project-member)。官方 SDK 也在客户端校验角色只能是 `READER` 或 `OWNER`，并调用 Project 嵌套 member endpoint：[project.py](https://github.com/mem0ai/mem0/blob/feb12852c0789a1f1182b05ee0dbc386037b012f/mem0/client/project.py#L492-L620)。

### 公开资料没有回答的继承规则

以下不能从当前公开文档确认：

- Organization `READER` 是否自动成为所有 Project 的 `READER`。
- Organization `OWNER` 是否在所有 Project 中自动拥有 OWNER 权限，还是后端仅作 super-admin bypass。
- 向 Project 添加尚未属于 Organization 的邮箱时，是自动加入 Organization、创建 invitation，还是拒绝。
- Project membership 是独立记录，还是 Organization membership 上的一组 project grants。

官方只明确说访问由 Organization **and** Project membership 控制，并提供两套独立 API。[Organizations & Projects](https://docs.mem0.ai/api-reference/organizations-projects)

因此不能把 Mem0 描述成“所有 Organization members 自动看到所有 Projects”，也不能描述成“必须同时存在两条 membership 才能访问”；精确继承逻辑是闭源部分。

### Invitations

**公开事实：** Organization 响应包含 `invitations`，文档将其定义为 pending invitations；文档索引把 Add Organization Member 描述为邀请成员。[Get Organization](https://docs.mem0.ai/api-reference/organization/get-org)、[Documentation index](https://docs.mem0.ai/llms.txt)

**未知：** 当前公开 API Reference 没有列出 accept / reject / resend / revoke invitation endpoints，也没有公开 invitation 状态机、有效期和“已有账号/未注册邮箱”分支。Add Member endpoint 的成功消息仅为 “User added”。因此 FishMem 不应假设 Mem0 的邀请流程已从公开协议中完整可复刻。

### 文档中的角色不一致

旧的 OSS → Platform migration 示例曾使用 `role="admin"`，但当前 Organization/Project API 文档和当前官方 SDK 都只接受 `READER / OWNER`。[Migration example](https://docs.mem0.ai/migration/oss-to-platform)、[current SDK](https://github.com/mem0ai/mem0/blob/feb12852c0789a1f1182b05ee0dbc386037b012f/mem0/client/project.py#L519-L588)

本报告以当前 API Reference 与当前 SDK 为准；`admin` 示例应视为陈旧或简化示例，而不是稳定公开角色。

## 3. 当前 Organization / Project 是怎么选择的

需要区分 Dashboard 控制面与 SDK 数据面。

### Dashboard 控制面

Organization 和 Project 返回对象都有 `is_default`；它们也返回当前用户在各层的 `user_role`。[Get Organization](https://docs.mem0.ai/api-reference/organization/get-org)、[Get Projects](https://docs.mem0.ai/api-reference/project/get-projects)

这证明 Mem0 后端至少存有“默认 Organization / 默认 Project”的概念。但当前公开 API 索引没有 `set active organization` 或 `set active project` endpoint；闭源 Dashboard 如何更新默认值、是否存 session/local storage、切换时如何更换 API key，都没有公开。

### SDK / REST 数据面

当前官方文档明确说：

> Organization and project are resolved automatically from your API key via `/v1/ping/`; use a project-specific API key to target a particular project.

SDK 源码与文档一致：`MemoryClient` 构造参数没有 `org_id/project_id`，只接受 key；初始化时调用 `/v1/ping/`，再保存返回的 org/project IDs，所有 project management 请求使用这对 ID。[Organizations & Projects](https://docs.mem0.ai/api-reference/organizations-projects)、[MemoryClient source](https://github.com/mem0ai/mem0/blob/feb12852c0789a1f1182b05ee0dbc386037b012f/mem0/client/main.py#L95-L173)

这带来一个很重要的安全性质：

```text
Dashboard 当前 Project             = 人类操作上下文
API key 所绑定的 Organization/Project = 服务端数据授权上下文
```

即使 Dashboard UI 的当前选择发生加载闪烁，也不应该让一个已有 key 突然访问另一个 Project。

## 4. API key 的作用域

**公开事实：**

- Mem0 要求使用 project-specific API key 指向具体 Project。[Organizations & Projects](https://docs.mem0.ai/api-reference/organizations-projects)
- `/v1/ping/` 会为该 key 返回 `org_id`、`project_id` 与 `user_email`；SDK 用它们初始化 project manager。[MemoryClient source](https://github.com/mem0ai/mem0/blob/feb12852c0789a1f1182b05ee0dbc386037b012f/mem0/client/main.py#L147-L173)
- 官方 Agent Mode 创建的是原子 `(Organization, Project, APIKey)` trio，每个 key 只能读写自己 scoped project，隔离由 membership checks 执行。[Mem0 Agent Mode, 2026-07-31](https://mem0.ai/blog/introducing-agentmode-mem0-signup-without-a-human-in-the-loop)
- 服务条款允许一个 account provision multiple API keys。[Mem0 Terms §2.2](https://mem0.ai/terms)

**未知：** Platform 没有公开 API key CRUD / rotate / revoke / key role 的完整 API Reference，Dashboard 后端也是闭源。因此无法确认：

- 一个 Project 可创建多少 key。
- key 是否继承创建者角色，还是拥有固定 project-level data-plane 权限。
- Organization owner 被移除、Project member 降权后，既有 key 如何失效。
- key 能否只读、限制 endpoint 或附加环境标签。

## 5. Billing 属于哪里

当前公开证据更支持“订阅/权益由 Organization owner 决定，Project 只是消耗与配额下的资源”，但不能声称已看见 Mem0 内部 Stripe 模型。

### 可以确认

- Organization 返回 `owner_pricing_plan`，官方解释为 “Pricing plan of the organization owner”；同时返回 `is_owner`。[Get Organization](https://docs.mem0.ai/api-reference/organization/get-org)
- 定价按 account subscription 展示，并把 Project 数作为计划权益：Hobby/Starter 1 个 Project，Pro/Enterprise unlimited Projects。[Mem0 Pricing](https://mem0.ai/pricing)
- 服务条款把 Fees 定义为 Customer/self-serve subscription，并允许同一 account 多 API keys。[Mem0 Terms §§1.9, 2.2, 4.1](https://mem0.ai/terms)

### 强推断

Organization 的可用套餐能力由 owner 的计划决定，而不是每个 Project 分别购买一个套餐。Project 的 requests/events 可以因为 project-specific key 被归因到具体 Project，但最终额度如何在多个 Organization / Project 间汇总并未公开。

### 仍然未知

- 一个 owner 拥有多个 Organizations 时，是共享一份 plan/quota，还是每个 Organization 单独订阅。
- Organization owner 更换后，计划归属如何迁移。
- Project-level usage 是共享池、硬分桶，还是只做分析归因。
- Project member 自己的计划是否影响其访问 owner Project。

因此 FishMem 可以借鉴“Organization 作为商业所有权边界”，但不能引用 Mem0 来证明某一种跨 Organization credits pooling 规则。

## 6. Mem0 的创建与空状态

Mem0 有两种可确认的创建行为：

1. 普通 Organization API 只创建 Organization，并返回 `org_id`；Project 需另调 nested endpoint 创建。理论上这个公开流程允许 Organization 暂时没有 Project。[Create Organization](https://docs.mem0.ai/api-reference/organization/create-org)、[Create Project](https://docs.mem0.ai/api-reference/project/create-project)
2. Agent Mode signup 原子创建 `(Organization, Project, APIKey)` trio，所以新 agent 拿到 key 时一定有可用 Project，不会落入 `Select project`。[Mem0 Agent Mode](https://mem0.ai/blog/introducing-agentmode-mem0-signup-without-a-human-in-the-loop)

这不是矛盾：底层管理 API 允许分步资源管理，而高层 onboarding 可以事务化 provision 默认 Project 和 key。

FishMem 应该采用相同原则：底层模型允许显式 zero-project Organization，但用户完成注册/创建 Workspace 后的产品路径必须返回完整可用上下文，不能把半完成资源图直接留给 Dashboard。

## 7. 对 FishMem 的直接借鉴

### 应该借鉴

1. **停止把 Organization 叫 Workspace、同时又把 Project 存在 `workspaces` 表。** 对外只保留 Organization 与 Project 两个稳定名词。
2. **所有 Project 都必须有 Organization。** 个人空间应是单成员的 personal Organization，而不是 `organization_id = null` 的特殊 Project。
3. **API key 强绑定 Project。** Dashboard 的 active selection 不能参与 API 数据授权，也不能靠 localStorage 改变 key scope。
4. **拆开 OrganizationMember 与 ProjectMember。** Organization member 用于团队管理；Project member 用于具体 memory namespace 的访问。
5. **Project settings 归 Project。** Instructions、categories、retention、webhooks、API keys、memory data 都不应该挂在 Profile 或全局 Organization 设置里。
6. **Billing 归 Organization/owner，usage 按 Project 归因。** 这样套餐、成员和项目数权益才有一个稳定商业主体。
7. **高层 onboarding 原子 provision。** signup / New Organization 成功后，要么返回 `{ organization, defaultProject, apiKey }`，要么进入明确的 Create first project 页面，不能显示空白详情和细加载条。

### 不建议照搬

1. `READER / OWNER` 对成熟团队太粗。FishMem 至少应预留 `OWNER / ADMIN / MEMBER / VIEWER`，并把组织管理权与数据写权限分开。
2. 不要复制文档未公开的 membership inheritance。FishMem 应明确写出自己的规则并用测试锁定。
3. 不要让每次 Dashboard 切 Project 自动泄露或替换 secret key；UI selection 和 key lifecycle 应分离。
4. 不要把 invitation 当作“POST member 成功”就完成。必须有 pending、accept/expire/revoke、审计和幂等。

## 8. 建议 FishMem 固定的权限不变量

下面是对 FishMem 的建议，不是对 Mem0 闭源实现的断言：

```text
Project.organization_id is NOT NULL
ApiKey.project_id is NOT NULL
Memory.project_id is NOT NULL

Organization OWNER/ADMIN:
  - 管理组织、套餐、members、projects
  - 是否默认读取所有 project data 必须成为显式产品决策

Project access:
  - 来自 ProjectMembership
  - 或由 Organization OWNER/ADMIN 的显式 super-admin policy 派生

Active dashboard context:
  organization_id + project_id + effective_role
  且 project.organization_id == organization_id

Data-plane context:
  只由 authenticated ApiKey.project_id / service credential scope 决定
```

推荐先采用简单但明确的规则：Organization OWNER/ADMIN 可管理所有 Projects；普通 Organization MEMBER 必须另有 ProjectMembership 才能读写 Project 数据。这样既能保留团队管理，又不会默认把所有客户记忆暴露给组织里的每个人。

## 9. 公开与闭源边界

| 问题 | 结论 |
| --- | --- |
| Organization → Project 层级 | **公开确认** |
| 两层 Members API | **公开确认** |
| READER / OWNER 角色 | **公开确认** |
| Project 是 memory/config 生命周期边界 | **公开确认** |
| API key 绑定具体 org/project | **公开确认** |
| 默认 org/project 字段 | **公开确认** |
| Dashboard 切换的 session/local state | **闭源未知** |
| Org/Project membership 的精确继承 | **闭源未知** |
| Invitation accept/reject 状态机 | **公开不完整** |
| API key rotate/revoke/role 细节 | **公开不完整** |
| Stripe customer/subscription 数据模型 | **闭源未知** |
| 多 Organization 的 quota pooling | **闭源未知** |

## 最终判断

Mem0 最值得 FishMem 借鉴的不是左侧导航长什么样，而是它把三个经常混淆的概念拆开了：

- Organization：谁共同拥有和付费；
- Project：哪一组 memory/config/API 构成隔离环境；
- Members：在 Organization 和 Project 两层分别拥有什么权限。

而且 Mem0 把服务端数据边界压在 project-specific API key 上，避免 Dashboard 当前选择成为安全边界。FishMem 应优先修这一层模型和授权，再修 selector、settings tabs 和 empty state；否则 UI 变稳定了，跨成员项目共享与隔离仍然会是错的。

## 第一方来源清单

- [Mem0 Organizations & Projects](https://docs.mem0.ai/api-reference/organizations-projects)，访问于 2026-08-22。
- [Mem0 Organization API](https://docs.mem0.ai/api-reference/organization/get-org)，访问于 2026-08-22。
- [Mem0 Project API](https://docs.mem0.ai/api-reference/project/get-projects)，访问于 2026-08-22。
- [Mem0 Project Members API](https://docs.mem0.ai/api-reference/project/add-project-member)，访问于 2026-08-22。
- [Mem0 Entity-Scoped Memory](https://docs.mem0.ai/platform/features/entity-scoped-memory)，访问于 2026-08-22。
- [Mem0 Pricing](https://mem0.ai/pricing)，访问于 2026-08-22。
- [Mem0 Platform Access and Usage Agreement](https://mem0.ai/terms)，页面更新于 2026-08，访问于 2026-08-22。
- [Mem0 Agent Mode](https://mem0.ai/blog/introducing-agentmode-mem0-signup-without-a-human-in-the-loop)，发布于 2026-07-31。
- [mem0ai/mem0 SDK, commit `feb12852`](https://github.com/mem0ai/mem0/tree/feb12852c0789a1f1182b05ee0dbc386037b012f)，commit 时间 2026-08-21。
