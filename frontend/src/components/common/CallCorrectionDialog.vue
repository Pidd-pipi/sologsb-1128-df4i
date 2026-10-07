<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import { usePortStore } from '../../stores/portStore';
import { useVesselStore } from '../../stores/vesselStore';
import {
  CALL_TYPES,
  VISA_STATUSES,
  emptyCallDraft,
  type CallDraft,
  type PortCall,
} from '../../types/call';
import { formatDateTime, formatNumber, toPlain } from '../../utils/format';

const props = defineProps<{ modelValue: boolean; call: PortCall | null }>();
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
  (e: 'corrected', call: PortCall): void;
}>();

const portStore = usePortStore();
const vesselStore = useVesselStore();

const formRef = ref<FormInstance>();
const submitting = ref(false);

const form = ref<CallDraft & { reason: string }>({
  ...emptyCallDraft(),
  reason: '',
});

/** 更正时允许选任何非维修泊位（重写历史，不受当前占用状态限制） */
const berthOptions = computed(() =>
  portStore.berths
    .filter((b) => b.status !== '维修')
    .map((b) => ({
      value: `${b.portId}|${b.berthNo}`,
      label: `${portStore.portById(b.portId)?.name ?? b.portId} · ${b.berthNo}`,
    }))
    .sort((a, b) => a.label.localeCompare(b.label)),
);

const berthKey = computed({
  get: () => (form.value.portId && form.value.berthNo ? `${form.value.portId}|${form.value.berthNo}` : ''),
  set: (key: string) => {
    const [portId, berthNo] = String(key).split('|');
    form.value.portId = portId ?? '';
    form.value.berthNo = berthNo ?? '';
  },
});

const selectedVessel = computed(() => vesselStore.vesselById(form.value.vesselId));
const wasVisaed = computed(() => props.call?.visaStatus === '已签证');
const revisions = computed(() => props.call?.revisions ?? []);

const rules: FormRules = {
  vesselId: [{ required: true, message: '请选择渔船', trigger: 'change' }],
  portId: [{ required: true, message: '请选择泊位', trigger: 'change' }],
  time: [{ required: true, message: '请选择进出港时间', trigger: 'change' }],
  reason: [{ required: true, message: '请填写更正原因（已签证流水需留底）', trigger: 'blur' }],
};

watch(
  () => props.call,
  (call) => {
    if (!call) return;
    form.value = {
      vesselId: call.vesselId,
      type: call.type,
      // ISO → datetime-local 值
      time: toLocalInput(call.time),
      portId: call.portId,
      berthNo: call.berthNo,
      iceKg: call.iceKg,
      fuelL: call.fuelL,
      unloadKg: call.unloadKg,
      visaStatus: call.visaStatus,
      reason: '',
    };
  },
  { immediate: true },
);

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function close(): void {
  emit('update:modelValue', false);
}

async function submit(): Promise<void> {
  if (!props.call || !formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;
  if (!selectedVessel.value) {
    ElMessage.warning('请选择有效的渔船');
    return;
  }
  submitting.value = true;
  try {
    const next = await portStore.correctCall(props.call.id, {
      vesselId: form.value.vesselId,
      type: form.value.type,
      time: form.value.time,
      portId: form.value.portId,
      berthNo: form.value.berthNo,
      iceKg: Number(form.value.iceKg) || 0,
      fuelL: Number(form.value.fuelL) || 0,
      unloadKg: Number(form.value.unloadKg) || 0,
      visaStatus: form.value.visaStatus,
      reason: form.value.reason,
    });
    if (next) {
      ElMessage.success(`已更正 ${next.vesselName} 的流水，泊位占用已重算`);
      emit('corrected', toPlain(next));
      close();
    }
  } catch (error) {
    ElMessage.error(`更正失败：${(error as Error).message}`);
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="更正进出港流水"
    width="640px"
    data-testid="call-correct-dialog"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      v-if="wasVisaed"
      type="warning"
      show-icon
      :closable="false"
      class="visa-alert"
      title="该流水已签证"
      data-testid="visa-correct-alert"
    >
      更正后当前记录更新为新内容，更正前的原样会完整保留在下方留底中，可随时核对。
    </el-alert>

    <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
      <el-form-item label="渔船" prop="vesselId">
        <el-select v-model="form.vesselId" placeholder="点错船时在此改选" filterable style="width: 100%" data-testid="correct-vessel">
          <el-option
            v-for="v in vesselStore.vessels"
            :key="v.id"
            :label="`${v.name}（${v.homePort}）`"
            :value="v.id"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="进出港类型" prop="type">
        <el-radio-group v-model="form.type" data-testid="correct-type">
          <el-radio-button v-for="t in CALL_TYPES" :key="t" :value="t">{{ t }}</el-radio-button>
        </el-radio-group>
      </el-form-item>

      <el-form-item label="时间" prop="time">
        <el-date-picker
          v-model="form.time"
          type="datetime"
          value-format="YYYY-MM-DDTHH:mm"
          placeholder="选择时间"
          style="width: 100%"
          data-testid="correct-time"
        />
      </el-form-item>

      <el-form-item label="泊位" prop="portId">
        <el-select
          v-model="berthKey"
          placeholder="点错泊位时在此改选（不可选维修泊位）"
          filterable
          style="width: 100%"
          data-testid="correct-berth"
        >
          <el-option v-for="opt in berthOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
        </el-select>
      </el-form-item>

      <el-row :gutter="12">
        <el-col :span="8">
          <el-form-item label="加冰 kg" prop="iceKg">
            <el-input-number v-model="form.iceKg" :min="0" :max="20000" :step="50" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="加油 L" prop="fuelL">
            <el-input-number v-model="form.fuelL" :min="0" :max="20000" :step="50" style="width: 100%" />
          </el-form-item>
        </el-col>
        <el-col :span="8">
          <el-form-item label="卸货 kg" prop="unloadKg">
            <el-input-number v-model="form.unloadKg" :min="0" :max="200000" :step="100" style="width: 100%" />
          </el-form-item>
        </el-col>
      </el-row>

      <el-form-item label="签证状态" prop="visaStatus">
        <el-select v-model="form.visaStatus" style="width: 100%" data-testid="correct-visa">
          <el-option v-for="s in VISA_STATUSES" :key="s" :label="s" :value="s" />
        </el-select>
      </el-form-item>

      <el-form-item label="更正原因" prop="reason">
        <el-input
          v-model="form.reason"
          type="textarea"
          :rows="2"
          placeholder="如：登记时点错泊位，实际靠 B03"
          data-testid="correct-reason"
        />
      </el-form-item>
    </el-form>

    <div v-if="revisions.length" class="revision-box" data-testid="revision-list">
      <p class="revision-box__title">更正留底（原样保留 {{ revisions.length }} 次）</p>
      <el-timeline>
        <el-timeline-item v-for="(rev, idx) in revisions" :key="idx" :timestamp="formatDateTime(rev.at)" placement="top" type="info">
          <div class="revision-row">
            <el-tag size="small">{{ rev.type }}</el-tag>
            <span>{{ rev.vesselName }}</span>
            <span>{{ portStore.portById(rev.portId)?.name ?? rev.portId }} · {{ rev.berthNo }}</span>
            <span>{{ formatDateTime(rev.time) }}</span>
            <el-tag size="small" type="info" effect="plain">{{ rev.visaStatus }}</el-tag>
          </div>
          <p class="revision-row__reason">更正原因：{{ rev.reason }}（{{ rev.by }}）</p>
          <p class="revision-row__cargo">
            加冰 {{ formatNumber(rev.iceKg, 0) }}kg · 加油 {{ formatNumber(rev.fuelL, 0) }}L · 卸货 {{ formatNumber(rev.unloadKg, 0) }}kg
          </p>
        </el-timeline-item>
      </el-timeline>
    </div>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :loading="submitting" data-testid="submit-correction" @click="submit">
        保存更正并重算泊位
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.visa-alert {
  margin-bottom: 14px;
}
.revision-box {
  margin-top: 8px;
  border: 1px dashed #dcdfe6;
  border-radius: 8px;
  padding: 10px 14px 0;
  background: #fafbfc;
  max-height: 220px;
  overflow-y: auto;
}
.revision-box__title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: #6b7c8c;
}
.revision-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #4b5c6d;
}
.revision-row__reason {
  margin: 4px 0 0;
  font-size: 12px;
  color: #8592a0;
}
.revision-row__cargo {
  margin: 2px 0 0;
  font-size: 12px;
  color: #8592a0;
}
</style>
