# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站测验与资料整编人员的纯前端单页应用：把每次测流的测站、断面测次、垂线测深、流速测点逐层落档；**站上**负责洪水后的水尺接测（每接一次记零点高程与接测人，记录只追加），**资料室**按各点据测流当时生效的零点把水尺读数折到统一基面后再做幂函数定线与比测判定，定案报出版本冻结留档、重算失败可独立重试。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22811**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22811），如需换端口改这一个变量即可。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `stationStore` / `sectionStore` / `ratingStore` |
| 路由 | Vue Router 4（history 模式） | 路径与提示词逐字一致，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbhydrogaug`） | 结构版本 v3 + upgrade 迁移 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 测站台账 | Station、Section、Rating | 新建/编辑/删除测站，按河名与集水面积分档筛选，卡片回显测次数、最新水位与比测合格率 |
| `/stations/:id/sections` | 断面测次列表与测法标记 | Section、Station | 新增测次（测次号、起点距、水位、流速仪/浮标/ADCP），水位筛选，回显当前水位与水位变幅 |
| `/sections/:id/verticals` | 垂线布设与测深 | Vertical、Section | 起点距排序校验（重复即时告警）、按测点数自动生成测点行、部分面积法断面流量成果 |
| `/verticals/:id/points` | 流速测点录入 | Point、Vertical | 逐点录入相对水深与流速、批量粘贴导入、批量改写流速、权重归一、垂线流速分布图 |
| `/ratings` | 水位流量关系点据 | Rating、Compare、GaugeSurvey | 水尺读数 / 统一基面水位分列、超限点挂红、关系曲线、待认点提示 |
| `/surveys` | 水尺接测（站上） | GaugeSurvey、Rating | 每接一次记零点高程 / 时间 / 接测人（只追加）、回填零点标注、对不上时间的点据交站上认 |
| `/datum-room` | 基面折算定线室（资料室） | Rating、RatingLineState、RatingVersion、RecalcJob | 按测流当时零点折基面重算、失败任务重试、定案报出与报出版本原样查阅、新开版本 |
| `/export` | 比测偏差分析与导出 | 全部模型 | 按测站出检测结论、比测偏差分析清单、全量 JSON 导入导出（旧备份自动回填迁移）、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1011/
├── README.md
├── docker-compose.yml          # name: gbhydrogaug，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # station / section / vertical / point / rating / compare
        │                        # gaugeSurvey（站上接测）/ ratingVersion（定案版本）/ recalc（重算任务）/ filter
        ├── stores/             # stationStore / sectionStore / ratingStore
        │                        # surveyStore（站上）/ datumStore（资料室）
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / SectionList / VerticalBoard / PointEntry
        │                        # SurveyBoard（站上接测）/ RatingChart / DatumRoom（资料室定线）/ ExportView
        ├── router/index.ts     # 路由表（路径与提示词逐字一致）
        ├── styles/main.css
        └── utils/              # flow.ts（流量计算）/ db.ts（Dexie 封装与播种）
                                 # datum.ts（基面折算纯函数）/ recalc.ts（资料室重算定案）/ export.ts（导入导出）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run verify     # fake-indexeddb 端到端验证（升级回填 / 重试隔离 / 定案留档）
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbhydrogaug`，当前结构版本 `v3`。页面侧由 `frontend/src/utils/db.ts` 统一封装，页面组件不直接触碰 Dexie 实例。
- **数据表（十张，站上 / 资料室分账）**：基础六表 `stations`（测站）、`sections`（断面测次）、`verticals`（垂线）、`points`（流速测点）、`ratings`（关系点据，`stageM` 为站上水尺读数、`datumStageM` 为资料室折算基面水位、`datumStatus` 标记对不上时间待认）、`compares`（比测记录）；
  站上侧 `gaugeSurveys`（水尺接测：零点高程、接测时间、接测人，只追加）；
  资料室侧 `ratingLineStates`（定线状态 draft/finalized）、`ratingVersions`（定案报出只读快照，含当时逐点比测结论）、`recalcJobs`（基面重算任务，失败可重试）。
- **零点与基面规则**：统一基面水位 H′ = 水尺读数 + 测流当时最近一次已生效接测的零点高程；定线与比测一律使用 H′，站上原始读数不改。对不上时间（无任何不晚于测流时间的接测）的点据标 `unmatched` 挑出，在 `/surveys` 交站上确认。
- **职责隔离**：站上 `/surveys` 只登记接测与认点；资料室 `/datum-room` 负责折算重算、失败重试、定案报出、版本查阅。重算事务只写资料室侧四张表，`gaugeSurveys` 仅事务外只读，因此**重算失败不会改动任何站上接测记录**。
- **零点改动处理**：新接测登记后，受影响测站的**未定案**定线自动挂重算任务；已定案报出版本冻结不动（同线可「新开版本」，历史版本原样可查）。
- **升级迁移**：`db.version(3)` 的 `upgrade` 与旧备份导入共用同一套规则（`utils/datum.ts`）——旧数据无零点记录时按本站「最近一次测流」回填一条 `backfilled` 接测（零点暂取 0 待校核），能对上时间的点据折基面，对不上的挑出交站上认，并为未定案定线挂重算任务。
- **首屏播种**：`initDatabase()` 在 `stations` 表为空时执行幂等播种，演示洪水后零点下沉（A 线 8 月点据按新零点折算）、已报出 A-V1/B-V1 版本、待重算 A 线任务与时间对不上待认点据。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，store 里的列表自动刷新，无需手动处理刷新时机。
- **备份与恢复**：`/export` 页可导出包含十张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id）」两种模式；v2 及更早的六表旧备份导入时自动执行回填迁移；备份时间写入 `localStorage`。
- **逻辑验证**：`npm run verify`（fake-indexeddb + esbuild）端到端验证升级回填、失败重试隔离、认点折算、定案冻结与新开版本流程。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器 / 清空站点数据后数据不会跟随，需通过 JSON 备份迁移。
