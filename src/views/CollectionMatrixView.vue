<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  CheckCircleIcon,
  ErrorTriangleIcon,
  RefreshIcon,
  StopCircleIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useCollectionMatrixQuery } from '@/composables/useGovernanceQueries'
import type { CollectionState, Platform } from '@/models/domain'
import { PLATFORMS, PLATFORM_LABELS } from '@/models/domain'
import { createId } from '@/services/repository'
import {
  collectionMatrixExport,
  dependencyModeLabel,
  downstreamConsumers,
} from '@/services/matrix'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
onMounted(() => store.subscribeExternalChanges())

const matrixQuery = useCollectionMatrixQuery()
const keyword = ref('')
const ledgerEventId = ref('')

const editorVisible = ref(false)
const conflictVisible = ref(false)
const editor = reactive({
  eventId: '',
  platform: 'web' as Platform,
  state: 'stopped' as CollectionState,
  basis: '',
  effectiveAt: new Date().toISOString().slice(0, 16),
  baseRevision: 0,
  requestId: '',
})
const lastConflict = ref<{
  winning: { revision: number; state: CollectionState; basis: string }
  draftRequestId: string
} | null>(null)

const filteredEvents = computed(() => {
  const word = keyword.value.trim().toLowerCase()
  return store.data.events.filter(
    (event) =>
      !word ||
      event.key.toLowerCase().includes(word) ||
      event.displayName.toLowerCase().includes(word) ||
      event.owner.toLowerCase().includes(word),
  )
})

const cellOf = (eventId: string, platform: Platform) =>
  store.data.collectionMatrix.find((cell) => cell.eventId === eventId && cell.platform === platform)

const draftOf = (eventId: string, platform: Platform) =>
  store.data.collectionDrafts.find(
    (draft) => draft.eventId === eventId && draft.platform === platform,
  )

const ruleOf = (eventId: string, platform: Platform) =>
  store.data.events
    .find((event) => event.id === eventId)
    ?.platformRules.find((rule) => rule.platform === platform)

const consumersOf = (eventId: string, platform: Platform) =>
  downstreamConsumers(store.data, eventId, platform)

const stoppedCount = computed(
  () => store.data.collectionMatrix.filter((cell) => cell.state === 'stopped').length,
)

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['collection-matrix'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['events'] })
  await queryClient.invalidateQueries({ queryKey: ['validations'] })
}

const formatTime = (value: string): string => {
  if (!value) return '-'
  return value.length <= 10 ? value : new Date(value).toLocaleString('zh-CN')
}

const openEditor = (eventId: string, platform: Platform): void => {
  const cell = cellOf(eventId, platform)
  editor.eventId = eventId
  editor.platform = platform
  editor.state = cell ? (cell.state === 'stopped' ? 'collecting' : 'stopped') : 'stopped'
  editor.basis = ''
  editor.effectiveAt = new Date().toISOString().slice(0, 16)
  editor.baseRevision = cell?.revision ?? 0
  editor.requestId = createId('req')
  editorVisible.value = true
}

const currentEvent = computed(() =>
  store.data.events.find((event) => event.id === editor.eventId),
)
const currentCell = computed(() => cellOf(editor.eventId, editor.platform))

const submit = async (): Promise<void> => {
  if (!editor.basis.trim() || !editor.effectiveAt) {
    await MessagePlugin.error('停采/恢复依据与生效时间不能为空')
    return
  }
  try {
    const result = store.commitCollectionChange({
      eventId: editor.eventId,
      platform: editor.platform,
      state: editor.state,
      basis: editor.basis.trim(),
      effectiveAt: new Date(editor.effectiveAt).toISOString(),
      baseRevision: editor.baseRevision,
      requestId: editor.requestId,
    })
    await invalidate()
    if (result.status === 'conflict') {
      lastConflict.value = {
        winning: {
          revision: result.cell.revision,
          state: result.cell.state,
          basis: result.cell.basis,
        },
        draftRequestId: result.draft.requestId,
      }
      editorVisible.value = false
      conflictVisible.value = true
      await MessagePlugin.error('该端已被另一窗口修改，你的提交已保存为冲突草稿')
      return
    }
    editorVisible.value = false
    await MessagePlugin.success(
      result.noop
        ? '重复提交已忽略：未新增台账与审批'
        : `${PLATFORM_LABELS[editor.platform]} 端已${
            editor.state === 'stopped' ? '停采' : '恢复采集'
          }，该端确认与审批已失效`,
    )
  } catch (error) {
    await invalidate()
    await MessagePlugin.error((error as Error).message)
  }
}

/** 同一请求号重复提交，用于演示“重复提交不新增审批” */
const resubmit = async (): Promise<void> => {
  try {
    const result = store.commitCollectionChange({
      eventId: editor.eventId,
      platform: editor.platform,
      state: editor.state,
      basis: editor.basis.trim() || '重复提交',
      effectiveAt: new Date(editor.effectiveAt).toISOString(),
      baseRevision: editor.baseRevision,
      requestId: editor.requestId,
    })
    await invalidate()
    if (result.status === 'conflict') {
      await MessagePlugin.warning('原请求遇到新版本，已转为冲突草稿')
      return
    }
    await MessagePlugin.success('重复提交幂等返回，没有新增台账和审批记录')
  } catch (error) {
    await MessagePlugin.error((error as Error).message)
  }
}

/** 模拟另一个窗口先提交同一端 */
const simulatePeer = (): void => {
  const cell = currentCell.value
  store.simulateExternalCommit({
    eventId: editor.eventId,
    platform: editor.platform,
    state: cell ? (cell.state === 'stopped' ? 'collecting' : 'stopped') : 'stopped',
    basis: '另一窗口先行登记的变更',
    effectiveAt: new Date().toISOString(),
    baseRevision: editor.baseRevision,
    requestId: createId('req-peer'),
  })
  void MessagePlugin.info('已模拟另一窗口先提交，请直接点击本窗口提交以产生冲突草稿')
}

const armFailure = (): void => {
  store.armWriteFailure()
  void MessagePlugin.warning('下一次提交将写入失败，用于验证从完整矩阵恢复')
}

const applyDraft = async (eventId: string, platform: Platform): Promise<void> => {
  store.resolveCollectionDraft(eventId, platform, true)
  await invalidate()
  await MessagePlugin.success('冲突草稿已按最新版本覆盖提交')
}

const discardDraft = async (eventId: string, platform: Platform): Promise<void> => {
  store.resolveCollectionDraft(eventId, platform, false)
  await invalidate()
  await MessagePlugin.info('冲突草稿已放弃')
}

const resolveConflictApply = async (): Promise<void> => {
  if (!lastConflict.value) return
  const { eventId, platform } = editor
  conflictVisible.value = false
  await applyDraft(eventId, platform)
}

const resolveConflictDiscard = async (): Promise<void> => {
  if (!lastConflict.value) return
  conflictVisible.value = false
  const draft = draftOf(editor.eventId, editor.platform)
  if (draft) await discardDraft(editor.eventId, editor.platform)
}

const exportRows = computed(() => collectionMatrixExport(store.data))
const exportMatrixJson = computed(() =>
  JSON.stringify(
    {
      version: store.data.currentVersion,
      matrixRevision: store.data.matrixRevision,
      generatedAt: new Date().toISOString(),
      rows: exportRows.value,
    },
    null,
    2,
  ),
)

const downloadMatrix = (): void => {
  const blob = new Blob([exportMatrixJson.value], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `collection-matrix-r${store.data.matrixRevision}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const changes = computed(() => {
  const list = [...store.data.collectionChanges].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return ledgerEventId.value
    ? list.filter((item) => item.eventId === ledgerEventId.value)
    : list
})
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="按端治理"
      title="按端采集矩阵"
      description="事件契约 × 平台规则 × 同义属性 × 下游依赖接成采集矩阵：各端分别登记停采或恢复、依据和生效时间；该端启停变化后，该平台的迁移确认与审批立即失效。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="summary-chips">
          <span class="chip">
            <strong>{{ store.data.collectionMatrix.length }}</strong> 个采集单元
          </span>
          <span class="chip danger">
            <StopCircleIcon /> <strong>{{ stoppedCount }}</strong> 端已停采
          </span>
          <span class="chip warning">
            <ErrorTriangleIcon />
            <strong>{{ store.data.collectionDrafts.length }}</strong> 个冲突草稿
          </span>
          <span class="chip">矩阵版本 <strong>r{{ store.data.matrixRevision }}</strong></span>
          <span v-if="store.lastExternalSyncAt" class="chip success">
            <RefreshIcon /> 跨窗口同步 {{ new Date(store.lastExternalSyncAt).toLocaleTimeString('zh-CN') }}
          </span>
        </div>
        <div class="filter-actions">
          <t-input
            v-model="keyword"
            placeholder="搜索事件 key / 中文名 / 负责人"
            style="width: 280px"
          />
          <t-button variant="outline" @click="matrixQuery.refetch()">
            <template #icon><RefreshIcon /></template>
            从完整矩阵恢复
          </t-button>
          <t-button theme="primary" @click="downloadMatrix">导出矩阵 JSON</t-button>
        </div>
      </div>
    </section>

    <section class="panel matrix-panel">
      <div class="matrix-scroll">
        <table class="matrix-table">
          <thead>
            <tr>
              <th class="event-col">事件契约 / 同义属性 / 下游</th>
              <th v-for="platform in PLATFORMS" :key="platform" class="platform-col">
                {{ PLATFORM_LABELS[platform] }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in filteredEvents" :key="event.id" class="event-row">
              <td class="event-cell">
                <div class="event-title">
                  <code>{{ event.key }}</code>
                  <StatusTag :value="event.status" />
                </div>
                <strong>{{ event.displayName }}</strong>
                <small>{{ event.owner }} · 契约 {{ event.version }}</small>
                <p class="synonyms">
                  同义属性：
                  <span v-if="event.properties.filter((p) => !p.deletedAt && p.synonyms.length).length">
                    {{ event.properties
                      .filter((p) => !p.deletedAt && p.synonyms.length)
                      .map((p) => `${p.name}(${p.synonyms.join('/')})`)
                      .join('、') }}
                  </span>
                  <span v-else class="muted">无</span>
                </p>
              </td>
              <td v-for="platform in PLATFORMS" :key="platform" class="platform-cell-td">
                <div
                  class="matrix-cell"
                  :class="{
                    stopped: cellOf(event.id, platform)?.state === 'stopped',
                    empty: !cellOf(event.id, platform),
                    'has-draft': Boolean(draftOf(event.id, platform)),
                  }"
                >
                  <template v-if="cellOf(event.id, platform)">
                    <div class="cell-head">
                      <StatusTag :value="cellOf(event.id, platform)!.state" />
                      <span class="revision">r{{ cellOf(event.id, platform)!.revision }}</span>
                    </div>
                    <p :title="cellOf(event.id, platform)!.basis" class="cell-basis">
                      {{ cellOf(event.id, platform)!.basis }}
                    </p>
                    <div class="cell-meta">
                      <span>{{ formatTime(cellOf(event.id, platform)!.effectiveAt) }}</span>
                      <span>{{ cellOf(event.id, platform)!.actor }}</span>
                    </div>
                    <div v-if="consumersOf(event.id, platform).length" class="cell-downstream">
                      <StopCircleIcon
                        v-if="cellOf(event.id, platform)!.state === 'stopped'"
                        class="risk-icon"
                      />
                      <span v-for="dependency in consumersOf(event.id, platform)" :key="dependency.id">
                        {{ dependency.name }}（{{ dependencyModeLabel(dependency) }}）
                      </span>
                    </div>
                    <div v-else class="cell-downstream muted">无下游消费</div>
                    <t-button
                      size="small"
                      variant="outline"
                      :theme="cellOf(event.id, platform)!.state === 'stopped' ? 'success' : 'danger'"
                      @click="openEditor(event.id, platform)"
                    >
                      {{ cellOf(event.id, platform)!.state === 'stopped' ? '恢复采集' : '停采' }}
                    </t-button>
                  </template>
                  <template v-else>
                    <span class="muted">未接入采集</span>
                    <t-button size="small" variant="text" @click="openEditor(event.id, platform)">
                      登记
                    </t-button>
                  </template>
                  <div
                    v-if="draftOf(event.id, platform)"
                    class="draft-box"
                  >
                    <StatusTag value="conflict" />
                    <p>
                      后到草稿：{{ draftOf(event.id, platform)!.state === 'stopped' ? '停采' : '恢复' }}
                      （基于 r{{ draftOf(event.id, platform)!.baseRevision }}，当前
                      r{{ draftOf(event.id, platform)!.conflictRevision }}）
                    </p>
                    <div class="draft-actions">
                      <t-button size="small" theme="primary" @click="applyDraft(event.id, platform)">
                        采用
                      </t-button>
                      <t-button size="small" variant="outline" @click="discardDraft(event.id, platform)">
                        放弃
                      </t-button>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="panel-header">
        <h2 class="panel-title">停采 / 恢复台账</h2>
        <t-select
          v-model="ledgerEventId"
          clearable
          placeholder="全部事件"
          :options="
            store.data.events.map((event) => ({ label: `${event.displayName} (${event.key})`, value: event.id }))
          "
          style="width: 280px"
        />
      </div>
      <t-table
        row-key="id"
        :data="changes"
        size="small"
        stripe
        :columns="[
          { colKey: 'eventKey', title: '事件', width: 200 },
          { colKey: 'platform', title: '平台', width: 100 },
          { colKey: 'change', title: '变化', width: 130 },
          { colKey: 'basis', title: '依据', minWidth: 280 },
          { colKey: 'effectiveAt', title: '生效时间', width: 170 },
          { colKey: 'actor', title: '操作人', width: 120 },
          { colKey: 'requestId', title: '请求号', width: 170 },
        ]"
      >
        <template #eventKey="{ row }">
          <code>{{
            store.data.events.find((event) => event.id === row.eventId)?.key ?? row.eventId
          }}</code>
        </template>
        <template #platform="{ row }">{{ PLATFORM_LABELS[row.platform as Platform] }}</template>
        <template #change="{ row }">
          <span :class="row.next === 'stopped' ? 'change-stop' : 'change-resume'">
            {{ row.previous === 'stopped' ? '已停采' : '采集中' }} →
            {{ row.next === 'stopped' ? '已停采' : '采集中' }}
          </span>
        </template>
        <template #effectiveAt="{ row }">{{ formatTime(row.effectiveAt) }}</template>
        <template #requestId="{ row }"><span class="mono">{{ row.requestId }}</span></template>
      </t-table>
    </section>

    <t-dialog
      v-model:visible="editorVisible"
      :header="`${currentEvent?.displayName ?? ''} · ${PLATFORM_LABELS[editor.platform]} 端采集登记`"
      width="640px"
      :footer="false"
    >
      <div class="editor-form single-column">
        <div class="current-cell">
          <div>
            <span>当前状态</span>
            <StatusTag v-if="currentCell" :value="currentCell.state" />
            <t-tag v-else theme="default" variant="light">未接入</t-tag>
          </div>
          <div>
            <span>当前版本</span>
            <strong>r{{ currentCell?.revision ?? 0 }}</strong>
          </div>
          <div v-if="ruleOf(editor.eventId, editor.platform)">
            <span>平台规则</span>
            <strong>{{ ruleOf(editor.eventId, editor.platform)?.owner }}</strong>
          </div>
        </div>
        <div class="field">
          <label>本次操作</label>
          <t-radio-group v-model="editor.state">
            <t-radio value="stopped">停止该端采集</t-radio>
            <t-radio value="collecting">恢复该端采集</t-radio>
          </t-radio-group>
        </div>
        <div class="field">
          <label>依据（故障单 / 改造说明 / 审批编号）</label>
          <t-textarea
            v-model="editor.basis"
            :autosize="{ minRows: 3, maxRows: 5 }"
            placeholder="例如 INCIDENT-WEB-3320：支付弹窗改造期间重复上报"
          />
        </div>
        <div class="field">
          <label>生效时间</label>
          <t-input v-model="editor.effectiveAt" type="datetime-local" />
        </div>
        <div v-if="consumersOf(editor.eventId, editor.platform).length" class="impact-note">
          <ErrorTriangleIcon />
          <div>
            <strong>{{ consumersOf(editor.eventId, editor.platform).length }} 个下游仍消费该端</strong>
            <p>
              {{
                consumersOf(editor.eventId, editor.platform)
                  .map((dependency) => `${dependency.name}（${dependencyModeLabel(dependency)}）`)
                  .join('、')
              }}
            </p>
            <p class="muted">提交后该平台在评审中候选里的迁移确认与审批立即失效，需要重新确认。</p>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="armFailure">模拟写入失败</t-button>
        <t-button variant="outline" @click="simulatePeer">模拟另一窗口先提交</t-button>
        <t-button variant="outline" @click="editorVisible = false">取消</t-button>
        <t-button variant="outline" @click="resubmit">重复提交（幂等）</t-button>
        <t-button
          :theme="editor.state === 'stopped' ? 'danger' : 'success'"
          @click="submit"
        >
          {{ editor.state === 'stopped' ? '确认停采' : '确认恢复' }}
        </t-button>
      </div>
    </t-dialog>

    <t-dialog
      v-model:visible="conflictVisible"
      header="该端已被另一窗口修改"
      width="560px"
      :footer="false"
    >
      <div v-if="lastConflict" class="conflict-panel">
        <div class="conflict-winning">
          <CheckCircleIcon class="applied" />
          <div>
            <strong>已落地的变更 r{{ lastConflict.winning.revision }}</strong>
            <p>
              状态：{{ lastConflict.winning.state === 'stopped' ? '已停采' : '采集中' }} ·
              {{ lastConflict.winning.basis }}
            </p>
          </div>
        </div>
        <div class="conflict-draft">
          <ErrorTriangleIcon class="draft-icon" />
          <div>
            <strong>你的后到提交已保留为草稿</strong>
            <p>草稿请求号：<span class="mono">{{ lastConflict.draftRequestId }}</span></p>
            <p class="muted">采用草稿将基于最新版本覆盖提交；放弃则仅保留已落地的变更。</p>
          </div>
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="resolveConflictDiscard">放弃草稿</t-button>
        <t-button theme="primary" @click="resolveConflictApply">采用草稿覆盖提交</t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.summary-chips {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 11px;
  border: 1px solid #dfe3e8;
  border-radius: 999px;
  color: #5b6678;
  background: #fafbfc;
  font-size: 12px;
}

.chip strong {
  color: #1f2a3d;
}

.chip.danger {
  color: #b42318;
  border-color: #f2c4c0;
  background: #fff5f4;
}

.chip.warning {
  color: #9a5a00;
  border-color: #f2d6a8;
  background: #fffaf0;
}

.chip.success {
  color: #0c7354;
  border-color: #bfe6d8;
  background: #f1fbf6;
}

.matrix-panel {
  overflow: hidden;
}

.matrix-scroll {
  overflow-x: auto;
}

.matrix-table {
  width: 100%;
  border-collapse: collapse;
}

.matrix-table th,
.matrix-table td {
  border-right: 1px solid #e8ebef;
  border-bottom: 1px solid #e8ebef;
  vertical-align: top;
}

.matrix-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 12px;
  background: #f4f6f9;
  color: #4b5669;
  font-size: 12px;
  text-align: left;
}

.event-col {
  min-width: 260px;
  position: sticky;
  left: 0;
  z-index: 3;
  background: #f4f6f9 !important;
}

.platform-col {
  min-width: 230px;
}

.event-cell {
  display: grid;
  gap: 6px;
  padding: 14px;
  background: #fff;
  position: sticky;
  left: 0;
  z-index: 1;
}

.event-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.event-title code {
  color: #1264c5;
  font-size: 11px;
}

.event-cell strong {
  font-size: 14px;
}

.event-cell small {
  color: #7a8494;
  font-size: 11px;
}

.synonyms {
  margin: 0;
  color: #66728a;
  font-size: 11px;
  line-height: 1.5;
}

.platform-cell-td {
  background: #fff;
}

.matrix-cell {
  display: grid;
  gap: 8px;
  min-height: 100%;
  padding: 12px;
  background: #fbfdfc;
}

.matrix-cell.stopped {
  background: #fff6f5;
}

.matrix-cell.empty {
  background: #fafbfc;
  align-content: center;
  justify-items: start;
  gap: 6px;
}

.matrix-cell.has-draft {
  outline: 2px solid #e8a93d;
  outline-offset: -2px;
}

.cell-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.revision {
  color: #8893a5;
  font-size: 10px;
}

.cell-basis {
  margin: 0;
  display: -webkit-box;
  overflow: hidden;
  color: #46526a;
  font-size: 11px;
  line-height: 1.5;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.cell-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: #8893a5;
  font-size: 10px;
}

.cell-downstream {
  display: grid;
  gap: 3px;
  padding: 8px;
  border-left: 3px solid #c9d4e2;
  background: #f5f8fb;
  color: #5a667a;
  font-size: 10px;
  line-height: 1.4;
}

.cell-downstream .risk-icon {
  color: #c7362c;
}

.cell-downstream.muted {
  border-left-color: #dde2e8;
  color: #9aa3b2;
}

.draft-box {
  display: grid;
  gap: 6px;
  padding: 8px;
  border: 1px dashed #d98e2b;
  border-radius: 5px;
  background: #fff8ec;
}

.draft-box p {
  margin: 0;
  color: #8a5a12;
  font-size: 10px;
}

.draft-actions {
  display: flex;
  gap: 6px;
}

.change-stop {
  color: #b42318;
  font-weight: 600;
}

.change-resume {
  color: #0c7354;
  font-weight: 600;
}

.single-column {
  grid-template-columns: minmax(0, 1fr);
}

.current-cell {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid #e3e7ec;
  border-radius: 6px;
  background: #e3e7ec;
}

.current-cell > div {
  display: grid;
  gap: 6px;
  padding: 12px;
  background: #fff;
}

.current-cell span {
  color: #7d8898;
  font-size: 11px;
}

.impact-note {
  display: grid;
  grid-template-columns: 20px 1fr;
  gap: 10px;
  padding: 12px;
  border: 1px solid #f0d8ae;
  border-radius: 6px;
  background: #fffaf0;
}

.impact-note > svg {
  color: #c46a00;
}

.impact-note p {
  margin: 4px 0 0;
  color: #6f6353;
  font-size: 11px;
  line-height: 1.5;
}

.conflict-panel {
  display: grid;
  gap: 12px;
}

.conflict-winning,
.conflict-draft {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: 10px;
  padding: 13px;
  border-radius: 6px;
}

.conflict-winning {
  background: #eff9f4;
  border: 1px solid #bfe6d4;
}

.conflict-winning .applied {
  color: #0f8a62;
}

.conflict-draft {
  background: #fff8ec;
  border: 1px solid #f0d8ae;
}

.conflict-draft .draft-icon {
  color: #c46a00;
}

.conflict-panel p {
  margin: 5px 0 0;
  color: #596579;
  font-size: 12px;
  line-height: 1.6;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 10px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid #e8ebef;
  flex-wrap: wrap;
}
</style>
