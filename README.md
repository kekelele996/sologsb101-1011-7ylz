# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站测验与资料整编人员的纯前端单页应用：把每次测流的测站、断面测次、垂线测深、流速测点逐层落档，据此整理水位—流量关系点据完成幂函数定线，并开展比测偏差分析。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

> **两个限界分开管（洪水后水尺重新接测场景）**
> - **站上（`/gauges`）**：只管「水尺接测」——每接一次记下水尺零点高程、接测时间、接测人（`gaugeSurveys` 表），不碰任何点据与定线。
> - **资料室（`/ratings`、`/export`）**：按「测流当时那一次生效零点」把点据的水尺读数折到**同一基面**（`datumStageM = 水尺读数 + 当时零点高程`）后再定线，比测偏差与判定随基面重折一并重算。
> - 零点改动后还没重新定案的线会标记「待重算」，重新「报出版本」后冻结；**报出去的每一版连同当时比测结论只追加、不改写，照样可查**（`ratingVersions` 表）。
> - 资料室重算失败只从资料室这侧重试（幂等），站上的接测记录不受影响。
> - 旧数据没有零点记录：升级（v3）时按最近一次已生效接测**回填**（标记「回填零点」）；测流时间对不上任何接测的点据**挑出为「待站上认」**，不参与定线，交站上补接测。

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
| 持久化 | Dexie 4（IndexedDB，库名 `gbhydrogaug`） | 结构版本 v3 + upgrade 迁移（旧零点回填）+ liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 消费模型 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 测站台账 | Station、Section、Rating | 新建/编辑/删除测站，按河名与集水面积分档筛选，卡片回显测次数、最新水位与比测合格率 |
| `/gauges` | 水尺接测登记（站上限界） | GaugeSurvey、Station、Rating | 每接一次登记零点高程/接测时间/接测人，查看本站点据基面状态与「待站上认」清单，交资料室重折基面 |
| `/stations/:id/sections` | 断面测次列表与测法标记 | Section、Station | 新增测次（测次号、起点距、水位、流速仪/浮标/ADCP），水位筛选，回显当前水位与水位变幅 |
| `/sections/:id/verticals` | 垂线布设与测深 | Vertical、Section | 起点距排序校验（重复即时告警）、按测点数自动生成测点行、部分面积法断面流量成果 |
| `/verticals/:id/points` | 流速测点录入 | Point、Vertical | 逐点录入相对水深与流速、批量粘贴导入、批量改写流速、权重归一、垂线流速分布图 |
| `/ratings` | 水位流量关系点据与定线（资料室，统一基面） | Rating、Compare、GaugeSurvey、RatingVersion | 录入水尺读数→按当时零点折基面、幂函数定线、超限挂红、基面重算（可重试）、报出定线版本与历史版本留档 |
| `/export` | 比测偏差分析与导出 | 全部模型 | 按测站出检测结论、比测偏差分析清单、全量 JSON 导入导出、清空重建演示数据 |

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
        ├── App.vue             # 顶部导航（含站上 /gauges）+ 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # station / section / vertical / point / rating / compare / gaugeSurvey / filter
        ├── stores/             # stationStore / sectionStore / ratingStore / gaugeSurveyStore
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / GaugeBoard / SectionList / VerticalBoard / PointEntry / RatingChart / ExportView
        ├── router/index.ts     # 路由表（含站上限界 /gauges）
        ├── styles/main.css
        └── utils/              # flow.ts / db.ts（Dexie 封装）/ datum.ts（基面折算·重算·报版）/ export.ts（导入导出）
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbhydrogaug`，当前结构版本 `v3`。页面侧由 `frontend/src/utils/db.ts` 统一封装，页面组件不直接触碰 Dexie 实例。
- **数据表（8 张）**：`stations`（测站）、`sections`（断面测次）、`verticals`（垂线）、`points`（流速测点）、`ratings`（关系点据，含水尺读数 `stageM` 与统一基面水位 `datumStageM` 等基面字段）、`compares`（比测记录，按 `ratingVersionId` 区分工作版/报出版归档）、`gaugeSurveys`（**站上**水尺接测：零点高程 + 接测时间 + 接测人）、`ratingVersions`（**资料室**报出定线版本快照，只追加）。
- **升级迁移**：`db.version(1)` 初版 → `v2` 补索引与时间戳 → `db.version(3)` 新增接测/版本两表与点据基面字段。v3 的 `upgrade` 对旧点据执行基面回填：有已生效接测的按「最近一次接测」记为 `backfilled`；时间对不上的记为 `pending`（待站上认），旧比测补 `ratingVersionId = null`（工作版）。调整字段结构时递增 `DB_VERSION` 并在 `upgrade` 中补迁移。
- **基面折算与重算**：`utils/datum.ts` 的 `recalcRatingsDatum()` 幂等、可安全重试，只写资料室表（`ratings` / `compares`），不增改 `gaugeSurveys`；`publishRatingVersion()` 只追加新版本并归档当时比测结论。
- **首屏播种**：`initDatabase()` 在 `stations` 表为空时执行幂等播种（3 个测站 / 4 次水尺接测 / 4 个断面测次 / 8 条垂线 / 16 个流速测点 / 13 个关系点据）。龙门站 A 线演示「洪水后水尺下沉、8 月重新接测零点由 100.000→99.850」：a5 读数 7.18 折回统一基面 107.03，与汛中点据连续；A 线已报出 v1（a1~a4 冻结留档）、a5 尚未定案；青矶站 b1 测流早于最早接测，演示「待站上认」；C 线含 2 个超限点据。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，store 里的列表自动刷新，无需手动处理刷新时机。
- **备份与恢复**：`/export` 页可导出包含八张表的 JSON 快照，支持「覆盖导入」与「追加导入（重新分配 id，并保持接测/版本/点据引用一致）」两种模式；旧版（v2）备份缺新表时按空数组兼容；备份时间写入 `localStorage`。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器 / 清空站点数据后数据不会跟随，需通过 JSON 备份迁移。
