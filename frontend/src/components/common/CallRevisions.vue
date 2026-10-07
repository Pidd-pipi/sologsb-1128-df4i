<script setup lang="ts">
import { computed } from 'vue';
import type { PortCall, CallRevision } from '../../types/call';
import { usePortStore } from '../../stores/portStore';
import { formatDateTime } from '../../utils/format';

const props = defineProps<{ call: PortCall }>();

const portStore = usePortStore();

/** 留痕字段的中文展示 */
const FIELD_LABELS: Record<string, string> = {
  vesselName: '船名',
  vesselId: '渔船',
  type: '类型',
  time: '时间',
  portId: '渔港',
  berthNo: '泊位号',
  iceKg: '加冰 kg',
  fuelL: '加油 L',
  unloadKg: '卸货 kg',
  visaStatus: '签证状态',
  voided: '作废状态',
};

interface ChangedRow {
  label: string;
  before: string;
}

function displayValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'time') return formatDateTime(String(value));
  if (field === 'portId') return portStore.portById(String(value))?.name ?? String(value);
  if (field === 'voided') return value ? '已作废' : '有效';
  return String(value);
}

const rows = computed(() =>
  props.call.revisions.map((rev, index): { index: number; rev: CallRevision; changes: ChangedRow[] } => ({
    index,
    rev,
    changes: Object.entries(rev.snapshot).map(([field, value]) => ({
      label: FIELD_LABELS[field] ?? field,
      before: displayValue(field, value),
    })),
  })),
);
</script>

<template>
  <el-popover placement="top" :width="340" trigger="hover">
    <template #reference>
      <el-tag size="small" type="danger" effect="dark" class="rev-tag" data-testid="revised-tag">
        已更正<template v-if="call.revisions.length > 1"> ×{{ call.revisions.length }}</template>
      </el-tag>
    </template>
    <div class="rev-pop">
      <p class="rev-pop__tip">已签证流水，更正前的原样留痕：</p>
      <div v-for="item in rows" :key="item.index" class="rev-pop__block">
        <p class="rev-pop__meta">
          第 {{ item.index + 1 }} 次 · {{ formatDateTime(item.rev.at) }} · {{ item.rev.reason }}
        </p>
        <div v-for="chg in item.changes" :key="chg.label" class="rev-pop__row">
          <span class="rev-pop__label">{{ chg.label }}</span>
          <span class="rev-pop__before">{{ chg.before }}</span>
        </div>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
.rev-tag {
  margin-left: 6px;
}
.rev-pop__tip {
  margin: 0 0 8px;
  font-size: 12px;
  color: #5b6b7b;
}
.rev-pop__block {
  margin-bottom: 10px;
  padding-bottom: 8px;
  border-bottom: 1px dashed #e4eaf0;
}
.rev-pop__block:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}
.rev-pop__meta {
  margin: 0 0 4px;
  font-size: 12px;
  color: #17324d;
  font-weight: 600;
}
.rev-pop__row {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 20px;
}
.rev-pop__label {
  color: #8592a0;
  flex: 0 0 72px;
}
.rev-pop__before {
  color: #b54848;
  text-decoration: line-through;
  word-break: break-all;
}
</style>
