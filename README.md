# 渔港与渔船档案地图（sologsb-1128 / gbfishport）

面向渔港管理站、渔业合作社与船东的**纯前端单页应用**：把渔港泊位条件、渔船技术档案与进出港动态集中到一张图上核对。
支持登记泊位与补给能力、建立含主机功率与吨位的渔船档案、记录进出港与泊位占用。

## 一键启动（Docker Compose）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21828>

停止：

```bash
docker compose down
```

## 技术栈

| 分类 | 选型 |
| --- | --- |
| 框架 | Vue 3（`<script setup>` + TypeScript） |
| 构建 | Vite 5 |
| UI | Element Plus 2 |
| 状态 | Pinia |
| 路由 | Vue Router 4（history 模式，nginx `try_files` 兜底） |
| 本地存储 | IndexedDB（Dexie 4，库名 `gbfishport-db`）+ localStorage（表单草稿） |
| 地图 | 高德地图 JS API（`VITE_AMAP_KEY`），未配置 key 时降级为本地 SVG 网格视图 |
| 托管 | nginx:alpine（gzip + 前端路由回退） |

## 目录结构

```
sologsb-1128/
├── docker-compose.yml          # 无 version 字段；顶层 name: gbfishport
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT / VITE_AMAP_KEY
├── frontend/
│   ├── Dockerfile              # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf              # try_files $uri $uri/ /index.html + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/              # port.ts / vessel.ts / call.ts / berth.ts / review.ts（5 个数据模型）
│       ├── stores/             # portStore.ts / vesselStore.ts / uiStore.ts
│       ├── db/                 # index.ts（Dexie v1→v4 迁移）/ berth.ts / reconcile.ts（占用重算）/ seed.ts
│       ├── components/common/  # PortCard / BerthGrid / VesselSpecTable / MapPanel / EmptyState / OccupancyReviewPanel / CallCorrectionDialog
│       ├── hooks/              # useAmapLoader / useBerthStatus / useLocalDraft
│       ├── pages/              # PortList / PortDetail / VesselList / VesselDetail / CallBoard / MapView
│       ├── router/index.ts
│       └── utils/              # tonnage.ts / geo.ts / format.ts
└── README.md
```

## 页面与路由

| 路由 | 说明 | 消费模型 |
| --- | --- | --- |
| `/` | 渔港一览：卡片展示等级、泊位数、在港船数与占用率，支持按等级与避风能力筛选 | FishingPort、Berth、PortCall |
| `/ports/:id` | 渔港详情：基本信息与补给能力、SVG 泊位网格（点击查看占用船舶）、在港船舶与近日流水 | 四个模型 |
| `/vessels` | 渔船检索：按作业类型、主机功率区间、总吨位与船籍港组合查询 | FishingVessel |
| `/vessels/:id` | 渔船档案详情：主尺度、主机功率、作业类型、证书有效期与进出港时间线 | FishingVessel、PortCall |
| `/calls` | 进出港登记：选择渔船与类型，填写泊位号、加冰量、加油量、卸货量并同步泊位状态；已登记流水可直接更正，提交后泊位占用整体重算；冲突与升级旧数据在此列待核对 | PortCall、Berth、FishingVessel、OccupancyReview |
| `/map` | 渔港与在港渔船分布：高德 JS API 标记，未配置 key 时为 SVG 网格视图，点选弹出泊位占用摘要 | FishingPort、Berth |

## 数据存储说明

- **业务数据走 IndexedDB（Dexie）**，库名 `gbfishport-db`，含版本号与升级迁移：
  - `v1`：建 `ports`、`vessels` 表
  - `v2`：新增 `calls` 表与 `vesselId` 索引
  - `v3`：新增 `berths` 表，并按每个渔港登记的泊位数生成初始泊位记录
  - `v4`：流水锚定到 `portId + berthNo`、新增 `reviews`（待核对）表；泊位占用改为**以进出港流水为唯一事实源统一重算**，旧流水自动补港口信息，旧泊位占用与重算结果对不上时列成待核对
- **表单草稿走 localStorage**（键前缀 `gbfishport:draft:`），例如进出港登记草稿 `gbfishport:draft:call-board`，提交成功后自动清空。
- 首次打开会自动写入一组演示数据（4 座渔港、6 艘渔船、8 条进出港流水与对应泊位），便于直接查看各页面效果。
- 容器无状态：不使用数据库服务、不挂载命名卷，清空浏览器站点数据即可重置。

## 流水更正与泊位占用重算

值班员点错船或泊位时不再需要「另补一条冲抵」，直接在进出港登记页（或渔船档案时间线）点「更正」：

1. **以流水为唯一事实源**：同一条靠泊在泊位与流水两处都有记录，流水一新增或更正，`db/reconcile.ts` 就按全部流水时间序回放（进港占用 / 出港释放），整体重算泊位占用，泊位上不再保留会过期的旧值。
2. **冲突先列待核对**：重算后同一泊位出现两条（及以上）冲突的在港记录时，泊位置为红色「待核对」，并在登记页顶部生成核对单；值班员逐条勾选实际靠泊的一条「保留」，其余流水仍保留可查，但标记为不参与占用；也可以两条都不留、泊位置空。后续若补登了出港流水，冲突消失时待核对单会自动核销。
3. **已签证留底**：每次更正都会在流水的 `revisions` 中留下更正前原样（船、类型、时间、泊位、物资量、签证状态、更正原因、操作人），更正弹窗内可直接查看；已签证流水更正时会额外提示。
4. **旧数据升级核对**：v4 升级时为旧流水推断并回填 `portId`（泊位占用记录 → 同船流水 → 船籍港逐级兜底），随后按流水重算；旧泊位占用与重算结果对不上（如幽灵占用）、流水指向不存在的泊位、或港口信息推断不出的，分别列成 `occupancy-mismatch` / `berth-missing` / `port-unknown` 待核对，由值班员在登记页处理。核对结论持久化在 `reviews` 表，重算不会覆盖人工结论。

## 高德地图 Key（可选）

`VITE_AMAP_KEY` 留空时**不会**请求任何外部地图服务，`useAmapLoader()` 立即返回降级标记，页面渲染本地 SVG 网格视图（可点选查看泊位占用）。需要真实底图时，在 `.env` 中填入 key 后重新构建：

```bash
VITE_AMAP_KEY=your-key docker compose up -d --build
```

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev
```

构建校验（类型检查 + 打包）：`npm run build`（等价于 `vue-tsc -b && vite build`）。
