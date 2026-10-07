import 'fake-indexeddb/auto';
import { usePortStore } from '../src/stores/portStore';
import { useVesselStore } from '../src/stores/vesselStore';
import { createPinia, setActivePinia } from 'pinia';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

setActivePinia(createPinia());
const store = usePortStore();
const vesselStore = useVesselStore();

// 直接写一组最小数据（绕过播种）
await store.loadAll();
// 若已有播种数据（ensureSeedData 未在 store 层执行，这里库是空的），自建
check('初始为空库', store.ports.length === 0, `ports=${store.ports.length}`);

const port = await store.createPort({
  name: '测试港', level: '一级渔港', longitude: 121, latitude: 29,
  berthCount: 2, berthDepth: 4, wharfLength: 100, shelterLevel: 10,
  supply: { fuel: true, ice: false, water: false }, manager: '测试站',
});
await vesselStore.loadAll();

// 手工塞两条渔船到库
const { db } = await import('../src/db');
await db.vessels.bulkPut([
  { id: 'va', name: '测试甲船', vesselNo: 'TA', homePort: '测试', length: 20, beam: 5, grossTonnage: 50, enginePower: 100, operationType: '拖网', hullMaterial: '钢质', owner: '甲', certificateExpiry: '2028-01-01', createdAt: new Date().toISOString() },
  { id: 'vb', name: '测试乙船', vesselNo: 'TB', homePort: '测试', length: 20, beam: 5, grossTonnage: 50, enginePower: 100, operationType: '拖网', hullMaterial: '钢质', owner: '乙', certificateExpiry: '2028-01-01', createdAt: new Date().toISOString() },
]);
await vesselStore.loadAll();

function draft(vesselId: string, type: '进港' | '出港', berthNo: string, hoursAgo: number, extra: Record<string, unknown> = {}) {
  return {
    vesselId,
    type,
    time: new Date(Date.now() - hoursAgo * 3600e3).toISOString(),
    portId: port.id,
    berthNo,
    iceKg: 0,
    fuelL: 0,
    unloadKg: 0,
    visaStatus: '待签证' as const,
    ...extra,
  };
}

// 1) 甲船进 B01
const c1 = await store.registerCall(draft('va', '进港', 'B01', 5, { visaStatus: '已签证' }), '测试甲船', port.id);
{
  const b = store.berths.find((x) => x.berthNo === 'B01')!;
  check('登记进港后 B01 占用甲船', b.status === '占用' && b.vesselId === 'va');
}

// 2) 更正：点错船，改成乙船进 B01（已签证）
await store.correctCall(c1.id, { ...draft('va', '进港', 'B01', 5, { visaStatus: '已签证' }), vesselId: 'vb', reason: '点错船' });
{
  const b = store.berths.find((x) => x.berthNo === 'B01')!;
  const call = store.callById(c1.id)!;
  check('更正后 B01 改挂乙船', b.status === '占用' && b.vesselId === 'vb', JSON.stringify({ s: b.status, v: b.vesselId }));
  check('流水船名同步为乙船', call.vesselName === '测试乙船');
  check('已签证更正留有原样快照', (call.revisions?.length ?? 0) === 1 && call.revisions![0].vesselId === 'va' && call.revisions![0].visaStatus === '已签证');
  check('记录更正时间', Boolean(call.correctedAt));
}

// 3) 再补一条甲船进 B01（2 小时前）→ 冲突，列待核对
await store.registerCall(draft('va', '进港', 'B01', 2, { visaStatus: '已签证' }), '测试甲船', port.id);
{
  const b = store.berths.find((x) => x.berthNo === 'B01')!;
  check('冲突出现后 B01 待核对', b.status === '待核对');
  check('待核对单 1 条 berth-conflict', store.pendingReviews.length === 1 && store.pendingReviews[0].kind === 'berth-conflict');
}

// 4) 值班员保留甲船
const review = store.pendingReviews[0];
await store.resolveBerthConflictKeep(review.id, review.callIds.find((id) => store.callById(id)?.vesselId === 'va')!);
{
  const b = store.berths.find((x) => x.berthNo === 'B01')!;
  check('保留后 B01 占用甲船', b.status === '占用' && b.vesselId === 'va', JSON.stringify(b));
  check('乙船流水标记不参与占用', store.calls.some((c) => c.vesselId === 'vb' && c.excludedFromOccupancy));
  check('待核对已清零', store.pendingReviews.length === 0, String(store.pendingReviews.length));
}

// 5) 把乙船那条更正到 B02 → 自动重新参与占用，B02 占用乙船
const excluded = store.calls.find((c) => c.vesselId === 'vb')!;
await store.correctCall(excluded.id, { ...draft('vb', '进港', 'B02', 5), reason: '实际靠 B02' });
{
  const b02 = store.berths.find((x) => x.berthNo === 'B02')!;
  const b01 = store.berths.find((x) => x.berthNo === 'B01')!;
  check('更正到 B02 后乙船占用 B02', b02.status === '占用' && b02.vesselId === 'vb', JSON.stringify(b02));
  check('B01 仍为甲船', b01.status === '占用' && b01.vesselId === 'va');
  check('无待核对', store.pendingReviews.length === 0);
  check('乙船重新参与占用（excluded 复位）', !store.callById(excluded.id)?.excludedFromOccupancy);
}

// 6) 重新载入页面（重新读库），状态一致
setActivePinia(createPinia());
const fresh = usePortStore();
await fresh.loadAll();
{
  const b01 = fresh.berths.find((x) => x.berthNo === 'B01')!;
  const b02 = fresh.berths.find((x) => x.berthNo === 'B02')!;
  check('重载后 B01 甲船', b01.status === '占用' && b01.vesselId === 'va');
  check('重载后 B02 乙船', b02.status === '占用' && b02.vesselId === 'vb');
  check('留底快照持久化', fresh.calls.some((c) => (c.revisions?.length ?? 0) > 0));
}

process.exit(failures ? 1 : 0);
