<script setup lang="ts">
import { reactive } from 'vue';
import { ElMessage } from 'element-plus';
import { usePortStore } from '../../stores/portStore';
import { REVIEW_KIND_LABELS, type OccupancyReview } from '../../types/review';
import { formatDateTime } from '../../utils/format';

const emit = defineEmits<{ (e: 'correct', callId: string): void }>();

const portStore = usePortStore();

/** 每个泊位冲突核对单里当前选中要保留的流水 id */
const keptCallId = reactive<Record<string, string>>({});

function candidateCalls(review: OccupancyReview) {
  return review.callIds
    .map((id) => portStore.callById(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));
}

function pickCall(review: OccupancyReview, callId: string): void {
  keptCallId[review.id] = callId;
}

async function keepPicked(review: OccupancyReview): Promise<void> {
  const kept = keptCallId[review.id];
  if (!kept) {
    ElMessage.warning('请先勾选实际靠泊的一条记录');
    return;
  }
  await portStore.resolveBerthConflictKeep(review.id, kept);
  ElMessage.success('已保留所选记录，泊位占用已重算');
}

async function keepEmpty(review: OccupancyReview): Promise<void> {
  await portStore.resolveBerthConflictEmpty(review.id);
  ElMessage.success('该泊位已置为空闲，相关流水不再参与占用');
}

async function acceptFlow(review: OccupancyReview): Promise<void> {
  await portStore.resolveReviewAcceptFlow(review.id);
  ElMessage.success('已核对，泊位以流水重算结果为准');
}

function correctFirstCall(review: OccupancyReview): void {
  const id = review.callIds[0];
  if (id) emit('correct', id);
}
</script>

<template>
  <el-card shadow="never" class="review-card" data-testid="review-panel">
    <template #header>
      <span class="review-card__title">
        待核对（{{ portStore.pendingReviews.length }}）
        <el-tag type="danger" size="small" effect="dark">需值班员处理</el-tag>
      </span>
    </template>

    <el-alert
      v-for="review in portStore.pendingReviews"
      :key="review.id"
      class="review-item"
      type="error"
      :closable="false"
      show-icon
      :data-testid="`review-${review.id}`"
    >
      <div class="review-item__body">
        <div class="review-item__head">
          <el-tag type="danger" size="small">{{ REVIEW_KIND_LABELS[review.kind] }}</el-tag>
          <span v-if="review.portId" class="review-item__loc">
            {{ portStore.portById(review.portId)?.name ?? review.portId }} · {{ review.berthNo }}
          </span>
          <span class="review-item__time">发现于 {{ formatDateTime(review.createdAt) }}</span>
        </div>
        <p class="review-item__detail">{{ review.detail }}</p>

        <!-- 同一泊位两条冲突在港记录：逐条列出，值班员挑一条保留 -->
        <div v-if="review.kind === 'berth-conflict'" class="review-cands">
          <label
            v-for="call in candidateCalls(review)"
            :key="call.id"
            class="review-cand"
            :class="{ 'review-cand--active': keptCallId[review.id] === call.id }"
            :data-testid="`review-cand-${call.id}`"
          >
            <input
              type="radio"
              :name="review.id"
              :checked="keptCallId[review.id] === call.id"
              @change="pickCall(review, call.id)"
            />
            <span class="review-cand__name">{{ call.vesselName }}</span>
            <span class="review-cand__meta">{{ formatDateTime(call.time) }} 进港 · 加冰 {{ call.iceKg }}kg</span>
            <el-tag size="small" :type="call.excludedFromOccupancy ? 'info' : 'warning'">
              {{ call.excludedFromOccupancy ? '此前已排除' : '参与占用' }}
            </el-tag>
          </label>
          <div class="review-item__actions">
            <el-button type="primary" size="small" data-testid="review-keep" @click="keepPicked(review)">
              保留选中记录
            </el-button>
            <el-button size="small" data-testid="review-empty" @click="keepEmpty(review)">两条都不留（泊位置空）</el-button>
          </div>
        </div>

        <!-- 其余核对单：可直接确认按流水为准，或打开流水更正 -->
        <div v-else class="review-item__actions">
          <el-button
            v-if="review.callIds.length"
            type="primary"
            size="small"
            data-testid="review-correct"
            @click="correctFirstCall(review)"
          >
            更正这条流水
          </el-button>
          <el-button size="small" data-testid="review-accept" @click="acceptFlow(review)">
            {{ review.kind === 'occupancy-mismatch' ? '按流水重算为准' : '已知悉，核销' }}
          </el-button>
        </div>
      </div>
    </el-alert>
  </el-card>
</template>

<style scoped>
.review-card {
  border: 1px solid #fbc4c4;
  border-radius: 10px;
}
.review-card__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #a8271f;
}
.review-item {
  margin-bottom: 12px;
}
.review-item:last-child {
  margin-bottom: 0;
}
.review-item__head {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.review-item__loc {
  font-weight: 600;
  color: #17324d;
  font-size: 13px;
}
.review-item__time {
  font-size: 12px;
  color: #8592a0;
}
.review-item__detail {
  margin: 8px 0 0;
  font-size: 13px;
  color: #4b5c6d;
}
.review-cands {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.review-cand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px;
  border: 1px solid #f0c2c0;
  border-radius: 8px;
  background: #fff7f7;
  cursor: pointer;
}
.review-cand--active {
  border-color: #f56c6c;
  box-shadow: 0 0 0 2px rgba(245, 108, 108, 0.15);
}
.review-cand__name {
  font-weight: 600;
  color: #17324d;
  min-width: 130px;
}
.review-cand__meta {
  font-size: 12px;
  color: #6b7c8c;
  flex: 1;
}
.review-item__actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
</style>
