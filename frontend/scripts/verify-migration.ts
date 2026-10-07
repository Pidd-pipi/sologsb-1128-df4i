// 模拟旧版本（v3）数据库 → 用当前 db 打开触发 v4 升级
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { SEED_PORTS, SEED_VESSELS, SEED_CALLS } from '../src/db/seed';
import { buildBerthRecords } from '../src/db/berth';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function iso(h: number): string {
  return new Date(Date.now() - h * 3600e3).toISOString();
}

// —— 1) 造一个 v3 结构的旧库：ports/vessels/calls/berths ——
const old = new Dexie('gbfishport-db');
old.version(1).stores({
  ports: 'id, name, level, shelterLevel',
  vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
});
old.version(2).stores({ calls: 'id, vesselId, type, time' });
old.version(3).stores({ berths: 'id, portId, berthNo, status, vesselId' });

await old.table('ports').bulkPut([
  { id: 'p1', name: '甲港', level: '一级渔港', longitude: 121, latitude: 29, berthCount: 3, berthDepth: 4, wharfLength: 100, shelterLevel: 10, supply: {}, manager: '站', createdAt: iso(240) },
]);
await old.table('vessels').bulkPut([
  { id: 's1', name: '甲船', vesselNo: 'A1', homePort: '甲', length: 20, beam: 5, grossTonnage: 50, enginePower: 100, operationType: '拖网', hullMaterial: '钢质', owner: '甲', certificateExpiry: '2028-01-01', createdAt: iso(100) },
  { id: 's2', name: '乙船', vesselNo: 'B2', homePort: '甲', length: 20, beam: 5, grossTonnage: 50, enginePower: 100, operationType: '拖网', hullMaterial: '钢质', owner: '乙', certificateExpiry: '2028-01-01', createdAt: iso(100) },
]);
// 旧流水：缺 portId 字段（v3 模型）；含一条造成冲突的进港
await old.table('calls').bulkPut([
  { id: 'c1', vesselId: 's1', vesselName: '甲船', type: '进港', time: iso(5), berthNo: 'B01', iceKg: 1, fuelL: 2, unloadKg: 3, visaStatus: '已签证', createdAt: iso(5) },
  { id: 'c2', vesselId: 's2', vesselName: '乙船', type: '进港', time: iso(2), berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '待签证', createdAt: iso(2) },
  { id: 'c3', vesselId: 's1', vesselName: '甲船', type: '出港', time: iso(200), berthNo: 'B02', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证', createdAt: iso(200) },
]);
// 旧泊位：B01 只挂了甲船（与两条在港流水冲突），B02 有个幽灵占用，B03 空闲
await old.table('berths').bulkPut([
  { id: 'p1-B01', portId: 'p1', berthNo: 'B01', vesselId: 's1', vesselName: '甲船', berthAt: iso(5), leaveAt: null, status: '占用', designDepth: 4 },
  { id: 'p1-B02', portId: 'p1', berthNo: 'B02', vesselId: 's2', vesselName: '乙船', berthAt: iso(9), leaveAt: null, status: '占用', designDepth: 4 },
  { id: 'p1-B03', portId: 'p1', berthNo: 'B03', vesselId: null, vesselName: null, berthAt: null, leaveAt: null, status: '空闲', designDepth: 4 },
]);
await old.close();

// —— 2) 用当前 schema 打开，触发 v4 upgrade ——
const { db } = await import('../src/db');
const calls = await db.calls.toArray();
const berths = await db.berths.toArray();
const reviews = await db.reviews.toArray();

console.log('v4 升级结果：');
check('reviews 表已建立', Array.isArray(reviews));
check('旧流水补齐 portId（同船唯一港口推断 p1）', calls.every((c) => c.portId === 'p1'), calls.map((c) => `${c.id}:${c.portId}`).join(','));
check('旧流水补齐 revisions 数组', calls.every((c) => Array.isArray(c.revisions)));

const b01 = berths.find((b) => b.id === 'p1-B01')!;
check('冲突泊位 B01 → 待核对', b01.status === '待核对', b01.status);
check('B01 候选两船', b01.candidateVesselIds?.length === 2);

const conflict = reviews.find((r) => r.kind === 'berth-conflict' && r.berthId === 'p1-B01');
check('冲突列 berth-conflict（source=migration）', conflict?.status === '待核对' && conflict.source === 'migration');

const b02 = berths.find((b) => b.id === 'p1-B02')!;
check('幽灵占用 B02 → 已按流水重算为空闲', b02.status === '空闲', b02.status);
const mismatch = reviews.find((r) => r.kind === 'occupancy-mismatch' && r.berthId === 'p1-B02');
check('幽灵占用列 occupancy-mismatch', mismatch?.status === '待核对' && mismatch.previousVesselName === '乙船');

await db.close();

// —— 3) 仿真演示数据：多港、泊位号重复（B01/B02）、旧流水全部缺 portId ——
{
  const IDB = (globalThis as { indexedDB?: IDBFactory }).indexedDB!;
  await new Promise<void>((resolve, reject) => {
    const req = IDB.deleteDatabase('gbfishport-db');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked'));
  });
  const old2 = new Dexie('gbfishport-db');
  old2.version(1).stores({
    ports: 'id, name, level, shelterLevel',
    vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
  });
  old2.version(2).stores({ calls: 'id, vesselId, type, time' });
  old2.version(3).stores({ berths: 'id, portId, berthNo, status, vesselId' });

  await old2.table('ports').bulkPut([
    { id: 'pa', name: '甲港', level: '一级渔港', longitude: 121, latitude: 29, berthCount: 2, berthDepth: 4, wharfLength: 100, shelterLevel: 10, supply: {}, manager: '站', createdAt: iso(240) },
    { id: 'pb', name: '乙港', level: '二级渔港', longitude: 122, latitude: 30, berthCount: 2, berthDepth: 4, wharfLength: 100, shelterLevel: 9, supply: {}, manager: '站', createdAt: iso(240) },
  ]);
  await old2.table('vessels').bulkPut([
    { id: 'sa', name: '甲港甲船', vesselNo: 'A', homePort: '甲', length: 20, beam: 5, grossTonnage: 50, enginePower: 100, operationType: '拖网', hullMaterial: '钢', owner: 'a', certificateExpiry: '2028-01-01', createdAt: iso(100) },
    { id: 'sb', name: '乙港乙船', vesselNo: 'B', homePort: '乙', length: 20, beam: 5, grossTonnage: 50, enginePower: 100, operationType: '拖网', hullMaterial: '钢', owner: 'b', certificateExpiry: '2028-01-01', createdAt: iso(100) },
  ]);
  // 两港都有 B01/B02；流水全部无 portId（真实 v3 演示数据形态）
  await old2.table('calls').bulkPut([
    { id: 'ca1', vesselId: 'sa', vesselName: '甲港甲船', type: '进港', time: iso(5), berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证', createdAt: iso(5) },
    { id: 'ca2', vesselId: 'sa', vesselName: '甲港甲船', type: '出港', time: iso(200), berthNo: 'B02', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '已签证', createdAt: iso(200) },
    { id: 'cb1', vesselId: 'sb', vesselName: '乙港乙船', type: '进港', time: iso(3), berthNo: 'B01', iceKg: 0, fuelL: 0, unloadKg: 0, visaStatus: '待签证', createdAt: iso(3) },
  ]);
  await old2.table('berths').bulkPut([
    { id: 'pa-B01', portId: 'pa', berthNo: 'B01', vesselId: 'sa', vesselName: '甲港甲船', berthAt: iso(5), leaveAt: null, status: '占用', designDepth: 4 },
    { id: 'pa-B02', portId: 'pa', berthNo: 'B02', vesselId: null, vesselName: null, berthAt: null, leaveAt: iso(200), status: '空闲', designDepth: 4 },
    { id: 'pb-B01', portId: 'pb', berthNo: 'B01', vesselId: 'sb', vesselName: '乙港乙船', berthAt: iso(3), leaveAt: null, status: '占用', designDepth: 4 },
    { id: 'pb-B02', portId: 'pb', berthNo: 'B02', vesselId: null, vesselName: null, berthAt: null, leaveAt: null, status: '空闲', designDepth: 4 },
  ]);
  await old2.close();

  // 单例 db 已 close 过；删除旧库后重新 open 触发升级
  await db.open();
  const c = await db.calls.toArray();
  const rv2 = await db.reviews.toArray();
  const map = Object.fromEntries(c.map((x) => [x.id, x.portId]));
  console.log('多港演示形态升级：');
  check('甲港流水推断为 pa（同船唯一港）', map.ca1 === 'pa' && map.ca2 === 'pa', JSON.stringify(map));
  check('乙港流水推断为 pb', map.cb1 === 'pb', JSON.stringify(map));
  check('与旧占用一致，无 occupancy-mismatch', !rv2.some((r) => r.kind === 'occupancy-mismatch'), rv2.map((r) => r.kind).join(','));
  check('无冲突待核对', !rv2.some((r) => r.status === '待核对'), rv2.map((r) => `${r.kind}:${r.status}`).join(','));
  await db.close();
}

// —— 4) 真实演示数据（4 港 8 条流水，v3 形态，无 portId）——
{
  const IDB = (globalThis as { indexedDB?: IDBFactory }).indexedDB!;
  await new Promise<void>((resolve) => {
    const req = IDB.deleteDatabase('gbfishport-db');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
  });
  const old3 = new Dexie('gbfishport-db');
  old3.version(1).stores({
    ports: 'id, name, level, shelterLevel',
    vessels: 'id, vesselNo, homePort, operationType, enginePower, grossTonnage',
  });
  old3.version(2).stores({ calls: 'id, vesselId, type, time' });
  old3.version(3).stores({ berths: 'id, portId, berthNo, status, vesselId' });
  await old3.table('ports').bulkPut(SEED_PORTS);
  await old3.table('vessels').bulkPut(SEED_VESSELS);
  // 剥掉 portId / 新字段，模拟 v3 流水
  await old3.table('calls').bulkPut(
    SEED_CALLS.map(({ portId: _p, revisions: _r, correctedAt: _c, excludedFromOccupancy: _e, ...rest }) => rest),
  );
  await old3.table('berths').bulkPut(SEED_PORTS.flatMap((p) => buildBerthRecords(p)));
  await old3.close();

  await db.open();
  const c = await db.calls.toArray();
  const rv3 = await db.reviews.toArray();
  const expected: Record<string, string> = {
    'c-3001': 'p-1001', 'c-3002': 'p-1001', 'c-3003': 'p-1002', 'c-3004': 'p-1003',
    // c-3005 为 v-2004 唯一一条流水（出港，无在港记录），按船籍港「石塘」兜底到 p-1004
    'c-3005': 'p-1004', 'c-3006': 'p-1002', 'c-3007': 'p-1001', 'c-3008': 'p-1002',
  };
  console.log('真实演示数据升级：');
  const portMap = Object.fromEntries(c.map((x) => [x.id, x.portId]));
  const bad = Object.entries(expected).filter(([id, want]) => portMap[id] !== want);
  check('8 条流水的渔港全部推断正确', bad.length === 0, bad.map(([id]) => `${id}=${portMap[id]}`).join(','));
  check('无 port-unknown 待核对', !rv3.some((r) => r.kind === 'port-unknown'), rv3.map((r) => r.kind).join(','));
  check('无任何待核对（演示数据自洽）', rv3.filter((r) => r.status === '待核对').length === 0,
    rv3.map((r) => `${r.kind}@${r.berthId}`).join(';'));
  await db.close();
}

process.exit(failures ? 1 : 0);
