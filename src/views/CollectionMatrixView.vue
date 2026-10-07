<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import { ErrorTriangleIcon } from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import type { MatrixCell, Platform } from '@/models/domain'
import {
  configuredCells,
  dependencyConsumption,
  PLATFORM_LABELS,
  PLATFORM_ORDER,
  resolveEventMatrix,
  synonymCoverageForCell,
} from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()

const selectedEventId = ref(store.data.events[0]?.id ?? '')
const selectedEvent = computed(
  () => store.data.events.find((event) => event.id === selectedEventId.value) ?? null,
)

const rows = computed(() =>
  store.data.events.map((event) => ({
    event,
    cells: resolveEventMatrix(store.data, event.id),
  })),
)

const summary = computed(() => {
  const cells = rows.value.flatMap((row) => configuredCells(row.cells))
  return {
    total: cells.length,
    collecting: cells.filter((cell) => cell.state === 'collecting').length,
    stopped: cells.filter((cell) => cell.state === 'stopped').length,
    drafts: store.data.matrixDrafts.length,
    partial: store.data.dependencies.filter(
      (dependency) => dependencyConsumption(store.data, dependency).mode === 'partial',
    ).length,
  }
})

const selectedDependencies = computed(() =>
  store.data.dependencies
    .filter((dependency) => dependency.eventIds.includes(selectedEventId.value))
    .map((dependency) => ({
      dependency,
      consumption: dependencyConsumption(store.data, dependency),
    })),
)

const stoppedPlatforms = computed(() =>
  selectedEvent.value
    ? resolveEventMatrix(store.data, selectedEvent.value.id)
        .filter((cell) => cell.state === 'stopped')
        .map((cell) => cell.platform)
    : [],
)

const coverageFor = (platform: Platform) =>
  synonymCoverageForCell(store.data, selectedEventId.value, platform)

const eventLabel = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}

const formatDateTime = (value: string): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

const editorVisible = ref(false)
const submitting = ref(false)
const currentCell = ref<MatrixCell | null>(null)
const editorForm = reactive({
  eventId: '',
  platform: 'web' as Platform,
  state: 'stopped' as 'collecting' | 'stopped',
  basis: '',
  effectiveAt: '',
  actor: '当前用户',
  baseRevision: 0,
})

const openCell = async (eventId: string, cell: MatrixCell): Promise<void> => {
  if (cell.source === 'none') {
    await MessagePlugin.warning('该平台未配置采集规则，请先在事件契约中添加平台规则')
    return
  }
  selectedEventId.value = eventId
  currentCell.value = cell
  editorForm.eventId = eventId
  editorForm.platform = cell.platform
  editorForm.state = cell.state === 'collecting' ? 'collecting' : 'stopped'
  editorForm.basis = cell.source === 'override' ? cell.basis : ''
  editorForm.effectiveAt =
    cell.source === 'override' && cell.effectiveAt
      ? cell.effectiveAt.slice(0, 16)
      : new Date().toISOString().slice(0, 16)
  editorForm.actor = cell.actor || '当前用户'
  editorForm.baseRevision = cell.revision
  editorVisible.value = true
}

/** 变更预览：该端启停变化将使多少确认与审批立即失效。 */
const invalidationPreview = computed(() => {
  const cell = currentCell.value
  if (!cell || cell.state === editorForm.state) return null
  const releases = store.data.releases.filter(
    (release) =>
      ['reviewing', 'approved'].includes(release.status) &&
      release.eventIds.includes(editorForm.eventId),
  )
  const dependencyIds = store.data.dependencies
    .filter((dependency) => dependency.eventIds.includes(editorForm.eventId))
    .map((dependency) => dependency.id)
  let confirmations = 0
  let approvals = 0
  releases.forEach((release) => {
    confirmations += release.migrationConfirmations.filter(
      (item) => item.status === 'confirmed' && dependencyIds.includes(item.dependencyId),
    ).length
    approvals += release.approvals.filter((item) => item.status === 'approved').length
  })
  return { releases: releases.length, confirmations, approvals }
})

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['events'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
  await queryClient.invalidateQueries({ queryKey: ['validations'] })
}

const submit = async (): Promise<void> => {
  if (submitting.value) return
  if (!editorForm.basis.trim() || !editorForm.effectiveAt) {
    await MessagePlugin.error('停采/恢复依据和生效时间不能为空')
    return
  }
  submitting.value = true
  const result = store.saveCollectionRecord(
    {
      eventId: editorForm.eventId,
      platform: editorForm.platform,
      state: editorForm.state,
      basis: editorForm.basis.trim(),
      effectiveAt: new Date(editorForm.effectiveAt).toISOString(),
      actor: editorForm.actor.trim() || '当前用户',
    },
    editorForm.baseRevision,
  )
  submitting.value = false
  if (result.ok) {
    editorVisible.value = false
    await invalidate()
    await MessagePlugin.success(
      result.unchanged ? '矩阵未发生变化，重复提交已忽略' : '采集矩阵已更新，相关确认与审批已同步失效',
    )
    return
  }
  if (result.reason === 'conflict') {
    editorVisible.value = false
    await invalidate()
    await MessagePlugin.error('该端采集状态已被其他窗口更新，你的修改已保留为冲突草稿')
    return
  }
  await MessagePlugin.error(result.message)
}

const applyDraft = async (draftId: string): Promise<void> => {
  if (!store.applyMatrixDraft(draftId)) {
    await MessagePlugin.error('草稿应用失败，已从完整矩阵恢复')
    return
  }
  await invalidate()
  await MessagePlugin.success('冲突草稿已覆盖应用')
}

const discardDraft = async (draftId: string): Promise<void> => {
  store.discardMatrixDraft(draftId)
  await MessagePlugin.success('冲突草稿已放弃')
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="采集治理"
      title="按端采集矩阵"
      description="事件契约 × 平台规则 × 同义属性 × 下游依赖的逐端采集视图：各端分别记录停采或恢复、依据和生效时间。"
    />

    <section class="matrix-summary">
      <div>
        <span>已配置端</span>
        <strong>{{ summary.total }}</strong>
      </div>
      <div>
        <span>采集中</span>
        <strong class="ok-text">{{ summary.collecting }}</strong>
      </div>
      <div>
        <span>已停采</span>
        <strong class="stop-text">{{ summary.stopped }}</strong>
      </div>
      <div>
        <span>部分消费下游</span>
        <strong class="warn-text">{{ summary.partial }}</strong>
      </div>
      <div>
        <span>冲突草稿</span>
        <strong class="warn-text">{{ summary.drafts }}</strong>
      </div>
      <div>
        <span>矩阵修订</span>
        <strong>r{{ store.data.matrixRevision }}</strong>
      </div>
    </section>

    <section v-if="store.data.matrixDrafts.length" class="panel draft-panel">
      <div class="panel-header">
        <h2 class="panel-title">冲突草稿</h2>
        <span class="muted">其他窗口已先行更新同一端，确认后可覆盖应用或放弃</span>
      </div>
      <article v-for="draft in store.data.matrixDrafts" :key="draft.id" class="draft-item">
        <div class="draft-main">
          <div>
            <strong>{{ eventLabel(draft.eventId) }}</strong>
            <StatusTag :value="draft.state" />
            <span class="draft-platform">{{ PLATFORM_LABELS[draft.platform] }}</span>
          </div>
          <p>依据：{{ draft.basis }} · 生效：{{ formatDateTime(draft.effectiveAt) }}</p>
          <span class="conflict-note">
            <ErrorTriangleIcon />
            基于 r{{ draft.baseRevision }} 提交，当前已为 r{{ draft.conflictRevision }}（{{ draft.actor }} ·
            {{ formatDateTime(draft.createdAt) }}）
          </span>
        </div>
        <div class="draft-actions">
          <t-button size="small" theme="primary" @click="applyDraft(draft.id)">覆盖应用</t-button>
          <t-button size="small" variant="outline" @click="discardDraft(draft.id)">放弃</t-button>
        </div>
      </article>
    </section>

    <section class="panel matrix-panel">
      <div class="panel-header">
        <h2 class="panel-title">事件 × 平台采集矩阵</h2>
        <span class="muted">点击单元格停采或恢复；修订号用于跨窗口冲突检测</span>
      </div>
      <div class="matrix-table">
        <div class="matrix-row matrix-head">
          <div class="matrix-event">事件契约</div>
          <div v-for="platform in PLATFORM_ORDER" :key="platform" class="matrix-cell-head">
            {{ PLATFORM_LABELS[platform] }}
          </div>
        </div>
        <div
          v-for="row in rows"
          :key="row.event.id"
          class="matrix-row"
          :class="{ selected: row.event.id === selectedEventId }"
        >
          <button class="matrix-event event-button" @click="selectedEventId = row.event.id">
            <code>{{ row.event.key }}</code>
            <span>{{ row.event.displayName }}</span>
            <StatusTag :value="row.event.status" />
          </button>
          <button
            v-for="cell in row.cells"
            :key="cell.platform"
            class="matrix-cell"
            :class="[cell.state, { editable: cell.source !== 'none' }]"
            :title="cell.basis"
            @click="openCell(row.event.id, cell)"
          >
            <StatusTag :value="cell.state" />
            <small v-if="cell.state === 'stopped' && cell.effectiveAt">
              {{ formatDateTime(cell.effectiveAt) }}
            </small>
            <small v-else-if="cell.source === 'override'">r{{ cell.revision }}</small>
            <small v-else-if="cell.source === 'none'">—</small>
          </button>
        </div>
      </div>
    </section>

    <div v-if="selectedEvent" class="matrix-detail">
      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">下游消费口径</h2>
          <span class="muted">{{ selectedEvent.key }} 被 {{ selectedDependencies.length }} 个下游引用</span>
        </div>
        <div class="consumption-list">
          <article
            v-for="item in selectedDependencies"
            :key="item.dependency.id"
            class="consumption-item"
          >
            <div class="consumption-head">
              <div>
                <strong>{{ item.dependency.name }}</strong>
                <span>{{ item.dependency.owner }} · {{ item.dependency.environment }}</span>
              </div>
              <StatusTag :value="item.consumption.mode" />
            </div>
            <p v-if="item.consumption.mode === 'full'">
              各端均在采集，按全量消费（{{ item.consumption.collectingCount }}/{{
                item.consumption.totalCount
              }}
              端）。
            </p>
            <p v-else-if="item.consumption.stoppedCells.length">
              停采端：{{ item.consumption.stoppedCells.map((cell) => `${cell.eventId === selectedEventId ? '本事件' : cell.eventId}/${PLATFORM_LABELS[cell.platform]}`).join('、') }}，实际消费
              {{ item.consumption.collectingCount }}/{{ item.consumption.totalCount }} 端。
            </p>
          </article>
          <div v-if="selectedDependencies.length === 0" class="empty-state">
            该事件暂无下游依赖。
          </div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2 class="panel-title">停采端同义属性覆盖</h2>
          <span class="muted">同端仍在采集的事件能否通过同义属性补齐口径</span>
        </div>
        <div class="coverage-list">
          <div v-for="platform in stoppedPlatforms" :key="platform" class="coverage-platform">
            <h3>{{ PLATFORM_LABELS[platform] }} 已停采</h3>
            <div v-for="entry in coverageFor(platform)" :key="entry.property.id" class="coverage-row">
              <code>{{ entry.property.name }}</code>
              <span v-if="entry.coveredBy.length" class="covered">
                可由 {{ entry.coveredBy.map((source) => `${source.eventKey}.${source.propertyName}`).join('、') }} 覆盖
              </span>
              <span v-else class="gap">该端无同义属性覆盖，停采后口径缺失</span>
            </div>
          </div>
          <div v-if="stoppedPlatforms.length === 0" class="empty-state">
            该事件当前没有停采端。
          </div>
        </div>
      </section>
    </div>

    <t-dialog
      v-model:visible="editorVisible"
      :header="`${eventLabel(editorForm.eventId)} · ${PLATFORM_LABELS[editorForm.platform]}`"
      width="680px"
      :footer="false"
    >
      <div v-if="currentCell" class="current-cell">
        <div>
          <span>当前状态</span>
          <StatusTag :value="currentCell.state" />
        </div>
        <div>
          <span>当前依据</span>
          <strong>{{ currentCell.basis || '—' }}</strong>
        </div>
        <div>
          <span>修订号</span>
          <strong>r{{ currentCell.revision }}（{{ currentCell.actor || '系统' }} ·
            {{ currentCell.source === 'override' ? formatDateTime(currentCell.effectiveAt) : '按平台规则' }}）</strong>
        </div>
      </div>
      <div v-if="invalidationPreview" class="invalid-preview">
        <ErrorTriangleIcon />
        <span>
          该端启停变化将影响 {{ invalidationPreview.releases }} 个在途发布：{{
            invalidationPreview.confirmations
          }}
          项迁移确认、{{ invalidationPreview.approvals }} 项审批将立即失效。
        </span>
      </div>
      <div class="editor-form">
        <div class="field">
          <label>目标状态</label>
          <t-radio-group v-model="editorForm.state">
            <t-radio value="collecting">恢复采集</t-radio>
            <t-radio value="stopped">停止采集</t-radio>
          </t-radio-group>
        </div>
        <div class="field">
          <label>操作人</label>
          <t-input v-model="editorForm.actor" />
        </div>
        <div class="field field-wide">
          <label>依据</label>
          <t-textarea
            v-model="editorForm.basis"
            :autosize="{ minRows: 3, maxRows: 5 }"
            placeholder="停采或恢复的依据，如需求单、废弃计划或故障单号"
          />
        </div>
        <div class="field field-wide">
          <label>生效时间</label>
          <t-input v-model="editorForm.effectiveAt" type="datetime-local" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="editorVisible = false">取消</t-button>
        <t-button theme="primary" :loading="submitting" @click="submit">写入矩阵</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.matrix-summary {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.matrix-summary > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  background: #fff;
}

.matrix-summary span {
  color: #717c8e;
  font-size: 11px;
}

.matrix-summary strong {
  font-size: 20px;
}

.ok-text {
  color: #0f8a62;
}

.stop-text {
  color: #b42318;
}

.warn-text {
  color: #c46a00;
}

.draft-panel {
  border-color: #e8b25a;
}

.draft-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 16px;
  border-bottom: 1px solid #f0e6d2;
  background: #fffaf0;
}

.draft-item:last-child {
  border-bottom: 0;
}

.draft-main {
  display: grid;
  gap: 6px;
}

.draft-main > div {
  display: flex;
  align-items: center;
  gap: 10px;
}

.draft-platform {
  color: #596579;
  font-size: 12px;
}

.draft-main p {
  margin: 0;
  color: #657084;
  font-size: 12px;
}

.conflict-note {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: #b65300;
  font-size: 11px;
}

.draft-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.matrix-panel {
  overflow: hidden;
}

.matrix-table {
  display: grid;
  overflow-x: auto;
}

.matrix-row {
  display: grid;
  grid-template-columns: minmax(240px, 1.2fr) repeat(5, minmax(128px, 1fr));
  gap: 1px;
  background: #e8ebef;
  border-bottom: 1px solid #e8ebef;
}

.matrix-row:last-child {
  border-bottom: 0;
}

.matrix-row.selected .matrix-event,
.matrix-row.selected .matrix-cell {
  background: #f4f8fd;
}

.matrix-head {
  background: #eef1f5;
}

.matrix-cell-head {
  padding: 11px 12px;
  color: #596579;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
}

.matrix-event {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 4px 10px;
  padding: 12px 14px;
  border: 0;
  background: #fff;
  text-align: left;
}

.matrix-event code {
  color: #1264c5;
  font-size: 11px;
}

.matrix-event span {
  grid-column: 1;
  color: #3c475c;
  font-size: 12px;
}

.matrix-event :deep(.t-tag) {
  grid-column: 2;
  grid-row: 1 / span 2;
}

.event-button {
  cursor: pointer;
}

.matrix-cell {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 5px;
  padding: 10px 8px;
  border: 0;
  background: #fff;
}

.matrix-cell.editable {
  cursor: pointer;
}

.matrix-cell.editable:hover {
  background: #f0f5fb;
}

.matrix-cell.stopped {
  background: #fff6f5;
}

.matrix-cell.not_configured {
  background: #fafbfc;
  cursor: not-allowed;
}

.matrix-cell small {
  color: #8a94a5;
  font-size: 10px;
}

.matrix-detail {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}

.consumption-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.consumption-item {
  display: grid;
  gap: 8px;
  padding: 14px 16px;
  background: #fff;
}

.consumption-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.consumption-head > div {
  display: grid;
  gap: 4px;
}

.consumption-head span,
.consumption-item p {
  color: #6d788b;
  font-size: 11px;
}

.consumption-item p {
  margin: 0;
  line-height: 1.6;
}

.coverage-list {
  display: grid;
  gap: 14px;
  padding: 14px 16px;
}

.coverage-platform {
  display: grid;
  gap: 8px;
}

.coverage-platform h3 {
  margin: 0;
  color: #b42318;
  font-size: 12px;
}

.coverage-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr);
  gap: 10px;
  align-items: baseline;
  padding: 8px 10px;
  border: 1px solid #edf0f3;
  border-radius: 5px;
}

.coverage-row code {
  color: #1264c5;
  font-size: 11px;
}

.coverage-row span {
  font-size: 11px;
}

.coverage-row .covered {
  color: #0f8a62;
}

.coverage-row .gap {
  color: #b42318;
}

.current-cell {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 14px;
}

.current-cell > div {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid #e3e7ec;
  border-radius: 5px;
  background: #fafbfc;
}

.current-cell span {
  color: #778294;
  font-size: 10px;
}

.current-cell strong {
  font-size: 11px;
  line-height: 1.5;
}

.invalid-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid #f0c36d;
  border-radius: 5px;
  color: #9a5b00;
  background: #fff8ec;
  font-size: 12px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
}
</style>
