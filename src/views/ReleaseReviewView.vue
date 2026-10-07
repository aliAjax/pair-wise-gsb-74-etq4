<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useQueryClient } from '@tanstack/vue-query'
import {
  AddIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  CloseCircleIcon,
  DownloadIcon,
  StopCircleIcon,
} from 'tdesign-icons-vue-next'
import { MessagePlugin } from 'tdesign-vue-next'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useReleaseQuery, useReleasesQuery } from '@/composables/useGovernanceQueries'
import type { Platform, PlatformReleaseAck, ReleaseApproval } from '@/models/domain'
import { PLATFORM_LABELS } from '@/models/domain'
import {
  dependencyModeLabel,
  releaseAckPlatforms,
  releaseCollectionImpacts,
} from '@/services/matrix'
import { releaseReadiness } from '@/services/selectors'
import { useGovernanceStore } from '@/stores/governance'

const store = useGovernanceStore()
const queryClient = useQueryClient()
const releasesQuery = useReleasesQuery()
const releaseId = ref(
  store.data.releases.find((release) => release.status === 'reviewing')?.id ??
    store.data.releases[0]?.id ??
    '',
)
const releaseQuery = useReleaseQuery(releaseId)
const release = computed(
  () =>
    releaseQuery.data.value ??
    store.data.releases.find((item) => item.id === releaseId.value) ??
    null,
)
const releases = computed(() => releasesQuery.data.value ?? store.data.releases)
const readiness = computed(() => (release.value ? releaseReadiness(release.value, store.issues) : 0))

const createVisible = ref(false)
const migrationVisible = ref(false)
const approvalVisible = ref(false)
const platformAckVisible = ref(false)
const createForm = reactive({
  version: '',
  title: '',
  eventIds: [] as string[],
})
const migrationForm = reactive({
  confirmationId: '',
  reviewer: '',
  note: '',
})
const selectedApprovalIds = ref<string[]>([])
const approvalComment = ref('')
const singleApproval = ref<ReleaseApproval | null>(null)
const activeAck = ref<PlatformReleaseAck | null>(null)
const ackComment = ref('')

const eventName = (eventId: string): string => {
  const event = store.data.events.find((item) => item.id === eventId)
  return event ? `${event.displayName} (${event.key})` : eventId
}
const eventKey = (eventId: string): string =>
  store.data.events.find((item) => item.id === eventId)?.key ?? eventId
const dependencyName = (dependencyId: string): string =>
  store.data.dependencies.find((dependency) => dependency.id === dependencyId)?.name ?? dependencyId
const roleLabel = (role: ReleaseApproval['role']): string =>
  ({ data: '数据负责人', product: '产品负责人', client: '客户端负责人', qa: '测试负责人' })[role]

const collectionImpacts = computed(() =>
  release.value ? releaseCollectionImpacts(store.data, release.value) : [],
)
const stoppedImpacts = computed(() =>
  collectionImpacts.value.filter((impact) => impact.state === 'stopped'),
)
const ackPlatforms = computed(() =>
  release.value ? releaseAckPlatforms(store.data.collectionMatrix, release.value.eventIds) : [],
)
const ackOf = (platform: Platform): PlatformReleaseAck | undefined =>
  release.value?.platformAcks.find((ack) => ack.platform === platform)

const formatTime = (value?: string): string =>
  value ? new Date(value).toLocaleString('zh-CN') : '-'

const invalidate = async (): Promise<void> => {
  await queryClient.invalidateQueries({ queryKey: ['release'] })
  await queryClient.invalidateQueries({ queryKey: ['releases'] })
  await queryClient.invalidateQueries({ queryKey: ['dashboard'] })
  await queryClient.invalidateQueries({ queryKey: ['lineage'] })
  await queryClient.invalidateQueries({ queryKey: ['collection-matrix'] })
}

const openCreate = (): void => {
  createForm.version = `2026.${String(Number(store.data.currentVersion.split('.')[1] ?? 10) + 1).padStart(2, '0')}.0`
  createForm.title = ''
  createForm.eventIds = []
  createVisible.value = true
}

const createRelease = async (): Promise<void> => {
  if (!createForm.version.trim() || !createForm.title.trim() || createForm.eventIds.length === 0) {
    await MessagePlugin.error('版本号、标题和事件范围不能为空')
    return
  }
  const created = store.createRelease(createForm.version, createForm.title, createForm.eventIds)
  releaseId.value = created.id
  createVisible.value = false
  await invalidate()
  await MessagePlugin.success('发布候选已创建，已生成下游迁移清单')
}

const openMigration = (confirmationId: string): void => {
  const confirmation = release.value?.migrationConfirmations.find(
    (item) => item.id === confirmationId,
  )
  if (!confirmation) return
  migrationForm.confirmationId = confirmationId
  migrationForm.reviewer = confirmation.reviewer
  migrationForm.note = confirmation.note
  migrationVisible.value = true
}

const confirmMigration = async (): Promise<void> => {
  if (!release.value || !migrationForm.reviewer.trim() || !migrationForm.note.trim()) {
    await MessagePlugin.error('确认人和迁移说明不能为空')
    return
  }
  store.confirmPlatformMigration(
    release.value.id,
    migrationForm.confirmationId,
    migrationForm.reviewer,
    migrationForm.note,
  )
  migrationVisible.value = false
  await invalidate()
  await MessagePlugin.success('下游按端迁移已确认')
}

const openPlatformAck = (platform: Platform): void => {
  const ack = ackOf(platform)
  if (!ack) return
  activeAck.value = ack
  ackComment.value = ack.invalidated ? '' : ack.comment
  platformAckVisible.value = true
}

const submitPlatformAck = async (
  status: 'confirmed' | 'approved' | 'rejected',
): Promise<void> => {
  if (!release.value || !activeAck.value || !ackComment.value.trim()) {
    await MessagePlugin.error('该端确认或审批意见不能为空')
    return
  }
  store.updatePlatformAck(
    release.value.id,
    activeAck.value.platform,
    status,
    ackComment.value,
  )
  platformAckVisible.value = false
  await invalidate()
  await MessagePlugin.success(
    status === 'approved'
      ? `${PLATFORM_LABELS[activeAck.value.platform]} 端审批已通过`
      : status === 'rejected'
        ? `${PLATFORM_LABELS[activeAck.value.platform]} 端审批已驳回`
        : `${PLATFORM_LABELS[activeAck.value.platform]} 端已确认`,
  )
}

const openApproval = (approval: ReleaseApproval): void => {
  singleApproval.value = approval
  approvalComment.value = approval.comment
  approvalVisible.value = true
}

const submitApproval = async (status: ReleaseApproval['status']): Promise<void> => {
  if (!release.value || !singleApproval.value || !approvalComment.value.trim()) {
    await MessagePlugin.error('审批意见不能为空')
    return
  }
  store.updateApproval(
    release.value.id,
    singleApproval.value.role,
    status,
    singleApproval.value.actor,
    approvalComment.value,
  )
  approvalVisible.value = false
  await invalidate()
  await MessagePlugin.success(status === 'approved' ? '审批已通过' : '审批已驳回')
}

const batchApprove = async (): Promise<void> => {
  if (!release.value) return
  if (selectedApprovalIds.value.length === 0 || !approvalComment.value.trim()) {
    await MessagePlugin.error('请选择审批项并填写批量审批意见')
    return
  }
  selectedApprovalIds.value.forEach((id) => {
    const approval = release.value?.approvals.find((item) => item.id === id)
    if (approval) {
      store.updateApproval(
        release.value!.id,
        approval.role,
        'approved',
        approval.actor,
        approvalComment.value,
      )
    }
  })
  selectedApprovalIds.value = []
  approvalComment.value = ''
  await invalidate()
  await MessagePlugin.success('批量审批已提交')
}

const publish = async (): Promise<void> => {
  if (!release.value) return
  if (!store.publishRelease(release.value.id)) {
    await MessagePlugin.error('迁移确认或四角色审批尚未完成，当前不可发布')
    return
  }
  await invalidate()
  await MessagePlugin.success('事件契约版本已发布')
}

const downloadDiff = (): void => {
  if (!release.value) return
  const content = JSON.stringify(
    {
      release: release.value.version,
      events: release.value.eventIds.map(eventName),
      differences: release.value.differences,
      affectedDependencies: release.value.affectedDependencyIds.map(dependencyName),
      collectionMatrix: releaseCollectionImpacts(store.data, release.value).map((impact) => ({
        event: eventKey(impact.eventId),
        platform: PLATFORM_LABELS[impact.platform],
        state: impact.state,
        basis: impact.basis,
        effectiveAt: impact.effectiveAt,
        downstream: impact.dependencies.map((dependency) => dependency.name),
      })),
      migrationConfirmations: release.value.migrationConfirmations,
      platformAcks: release.value.platformAcks,
    },
    null,
    2,
  )
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${release.value.version}-contract-diff.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

const setApprovalChecked = (approvalId: string, checked: unknown): void => {
  selectedApprovalIds.value = checked
    ? [...selectedApprovalIds.value, approvalId]
    : selectedApprovalIds.value.filter((id) => id !== approvalId)
}
</script>

<template>
  <div class="page">
    <PageHeader
      eyebrow="发布门禁"
      title="版本差异与发布评审"
      description="比较发布候选契约，生成受影响依赖，要求迁移确认并完成数据、产品、客户端和测试四角色审批。"
    />

    <section class="panel filter-panel">
      <div class="toolbar-row">
        <div class="toolbar-field release-field">
          <span>发布候选</span>
          <t-select
            v-model="releaseId"
            :options="releases.map((item) => ({ label: `${item.version} ${item.title}`, value: item.id }))"
          />
        </div>
        <div class="filter-actions">
          <t-button variant="outline" :disabled="!release" @click="downloadDiff">
            <template #icon><DownloadIcon /></template>
            导出差异
          </t-button>
          <t-button theme="primary" @click="openCreate">
            <template #icon><AddIcon /></template>
            创建发布候选
          </t-button>
        </div>
      </div>
    </section>

    <template v-if="release">
      <section class="release-overview">
        <div>
          <span>版本</span>
          <strong>{{ release.version }}</strong>
          <StatusTag :value="release.status" />
        </div>
        <div>
          <span>标题</span>
          <strong>{{ release.title }}</strong>
        </div>
        <div>
          <span>事件范围</span>
          <strong>{{ release.eventIds.length }} 个</strong>
        </div>
        <div>
          <span>发布就绪度</span>
          <strong>{{ readiness }}%</strong>
        </div>
        <t-button
          theme="primary"
          :disabled="release.status === 'published' || release.status === 'rolled_back'"
          @click="publish"
        >
          发布契约
          <template #suffix><ChevronRightIcon /></template>
        </t-button>
      </section>

      <section class="panel collection-panel">
        <div class="panel-header">
          <h2 class="panel-title">发布范围内按端采集状态</h2>
          <span class="muted">
            {{ stoppedImpacts.length }} 个端已停采，发布候选继续放行，下游按其消费范围对账
          </span>
        </div>
        <div class="impact-table-wrap">
          <table class="impact-table">
            <thead>
              <tr>
                <th>事件</th>
                <th>平台</th>
                <th>采集状态</th>
                <th>依据</th>
                <th>生效时间</th>
                <th>仍消费的下游</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="impact in collectionImpacts"
                :key="`${impact.eventId}-${impact.platform}`"
                :class="{ stopped: impact.state === 'stopped' }"
              >
                <td><code>{{ eventKey(impact.eventId) }}</code></td>
                <td>{{ PLATFORM_LABELS[impact.platform] }}</td>
                <td>
                  <span class="state-inline">
                    <StopCircleIcon v-if="impact.state === 'stopped'" class="stop-icon" />
                    <StatusTag :value="impact.state" />
                  </span>
                </td>
                <td class="basis-cell" :title="impact.basis">{{ impact.basis }}</td>
                <td>{{ formatTime(impact.effectiveAt) }}</td>
                <td>
                  <span v-if="impact.dependencies.length" class="dep-tags">
                    <t-tag
                      v-for="dependency in impact.dependencies"
                      :key="dependency.id"
                      size="small"
                      :theme="impact.state === 'stopped' ? 'warning' : 'default'"
                      variant="light"
                    >
                      {{ dependency.name }}（{{ dependencyModeLabel(dependency) }}）
                    </t-tag>
                  </span>
                  <span v-else class="muted">无</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <div class="release-grid">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">契约差异</h2>
            <span class="muted">{{ release.differences.length }} 个事件发生变化</span>
          </div>
          <div class="diff-list">
            <article v-for="difference in release.differences" :key="difference.eventId" class="diff-event">
              <div class="diff-event-head">
                <strong>{{ difference.eventKey }}</strong>
                <span>{{ eventName(difference.eventId) }}</span>
              </div>
              <div class="diff-columns">
                <div class="diff-block">
                  <h4>新增与删除</h4>
                  <ul>
                    <li v-for="item in difference.addedProperties" :key="`add-${item}`">
                      新增属性 {{ item }}
                    </li>
                    <li v-for="item in difference.removedProperties" :key="`remove-${item}`">
                      删除属性 {{ item }}
                    </li>
                  </ul>
                  <span
                    v-if="
                      difference.addedProperties.length === 0 &&
                      difference.removedProperties.length === 0
                    "
                    class="muted"
                  >
                    无属性增删
                  </span>
                </div>
                <div class="diff-block">
                  <h4>兼容性变化</h4>
                  <ul>
                    <li v-for="item in difference.requiredChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.typeChanges" :key="item">{{ item }}</li>
                    <li v-for="item in difference.enumChanges" :key="item">{{ item }}</li>
                  </ul>
                  <span
                    v-if="
                      difference.requiredChanges.length === 0 &&
                      difference.typeChanges.length === 0 &&
                      difference.enumChanges.length === 0
                    "
                    class="muted"
                  >
                    无破坏性变化
                  </span>
                </div>
              </div>
            </article>
            <div v-if="release.differences.length === 0" class="empty-state">该版本没有契约差异。</div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">发布门禁</h2>
          </div>
          <div class="gate-list">
            <div class="gate-row">
              <CheckCircleIcon />
              <div>
                <strong>契约差异已生成</strong>
                <span>{{ release.differences.length }} 个事件参与比较</span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: release.migrationConfirmations.some(
                    (item) => item.status !== 'confirmed' || item.invalidated,
                  ),
                }"
              />
              <div>
                <strong>下游按端迁移确认</strong>
                <span>
                  {{
                    release.migrationConfirmations.filter(
                      (item) => item.status === 'confirmed' && !item.invalidated,
                    ).length
                  }}/{{ release.migrationConfirmations.length }} 已确认（按消费端逐端确认）
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{
                  pending: ackPlatforms.some(
                    (platform) =>
                      ackOf(platform)?.status !== 'approved' || ackOf(platform)?.invalidated,
                  ),
                }"
              />
              <div>
                <strong>各平台确认与审批</strong>
                <span>
                  {{
                    ackPlatforms.filter(
                      (platform) =>
                        ackOf(platform)?.status === 'approved' && !ackOf(platform)?.invalidated,
                    ).length
                  }}/{{ ackPlatforms.length }} 端已审批；该端启停变化后立即失效
                </span>
              </div>
            </div>
            <div class="gate-row">
              <CheckCircleIcon
                :class="{ pending: release.approvals.some((item) => item.status !== 'approved') }"
              />
              <div>
                <strong>四角色批量审批</strong>
                <span>
                  {{ release.approvals.filter((item) => item.status === 'approved').length }}/{{
                    release.approvals.length
                  }}
                  已通过
                </span>
              </div>
            </div>
            <div class="readiness">
              <span>综合就绪度</span>
              <strong>{{ readiness }}%</strong>
              <t-progress :percentage="readiness" :label="false" />
            </div>
          </div>
        </section>
      </div>

      <div class="review-columns">
        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">下游迁移确认</h2>
          </div>
          <div class="migration-list">
            <article
              v-for="confirmation in release.migrationConfirmations"
              :key="confirmation.id"
              class="migration-card"
              :class="{ invalid: confirmation.invalidated }"
            >
              <div>
                <strong>
                  {{ dependencyName(confirmation.dependencyId) }}
                  <t-tag size="small" theme="primary" variant="light">
                    {{ confirmation.platform ? PLATFORM_LABELS[confirmation.platform] : '全量口径' }}
                  </t-tag>
                </strong>
                <span>{{ confirmation.reviewer || '未指定确认人' }}</span>
              </div>
              <StatusTag :value="confirmation.invalidated ? 'pending' : confirmation.status" />
              <p v-if="confirmation.invalidated" class="invalid-reason">
                {{ confirmation.invalidReason }}
              </p>
              <p v-else>{{ confirmation.note || '尚未填写该端迁移确认说明。' }}</p>
              <t-button
                variant="outline"
                size="small"
                :disabled="confirmation.status === 'confirmed' && !confirmation.invalidated"
                @click="openMigration(confirmation.id)"
              >
                {{ confirmation.invalidated ? '重新确认迁移' : '确认迁移' }}
              </t-button>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <h2 class="panel-title">各平台确认与审批</h2>
            <span class="muted">该端采集状态变化后需重新确认</span>
          </div>
          <div class="ack-list">
            <article
              v-for="platform in ackPlatforms"
              :key="platform"
              class="ack-card"
              :class="{ invalid: ackOf(platform)?.invalidated }"
            >
              <div class="ack-head">
                <strong>{{ PLATFORM_LABELS[platform] }}</strong>
                <StatusTag
                  :value="
                    ackOf(platform)?.invalidated
                      ? 'pending'
                      : (ackOf(platform)?.status ?? 'pending')
                  "
                />
              </div>
              <span class="ack-owner">{{ ackOf(platform)?.owner ?? '平台负责人' }}</span>
              <p v-if="ackOf(platform)?.invalidated" class="invalid-reason">
                {{ ackOf(platform)?.invalidReason }}
              </p>
              <p v-else>{{ ackOf(platform)?.comment || '该端尚未完成确认与审批。' }}</p>
              <div class="ack-meta">
                <span>基于矩阵 r{{ ackOf(platform)?.matrixRevision ?? 0 }}</span>
                <span>{{ formatTime(ackOf(platform)?.createdAt) }}</span>
              </div>
              <t-button
                size="small"
                variant="outline"
                :disabled="!ackOf(platform)"
                @click="openPlatformAck(platform)"
              >
                {{ ackOf(platform)?.invalidated ? '重新确认/审批' : '确认与审批' }}
              </t-button>
            </article>
          </div>
        </section>
      </div>

      <div class="review-columns single-row">
        <section class="panel four-role-panel">
          <div class="panel-header">
            <h2 class="panel-title">四角色审批</h2>
          </div>
          <div class="approval-list">
            <label v-for="approval in release.approvals" :key="approval.id" class="approval-row">
              <t-checkbox
                :value="selectedApprovalIds.includes(approval.id)"
                :disabled="approval.status === 'approved'"
                @change="setApprovalChecked(approval.id, $event)"
              />
              <div>
                <strong>{{ roleLabel(approval.role) }}</strong>
                <span>{{ approval.actor }} · {{ approval.comment || '待填写意见' }}</span>
              </div>
              <StatusTag :value="approval.status" />
              <t-button variant="text" size="small" @click.prevent="openApproval(approval)">
                审批
              </t-button>
            </label>
          </div>
          <div class="batch-bar">
            <t-input v-model="approvalComment" placeholder="批量审批意见" />
            <t-button theme="primary" @click="batchApprove">批量通过</t-button>
          </div>
        </section>
      </div>
    </template>

    <div v-else class="panel empty-state">暂无发布候选。</div>

    <t-dialog v-model:visible="createVisible" header="创建发布候选" width="720px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>版本号</label>
          <t-input v-model="createForm.version" />
        </div>
        <div class="field">
          <label>发布标题</label>
          <t-input v-model="createForm.title" />
        </div>
        <div class="field field-wide">
          <label>参与发布的事件</label>
          <t-select
            v-model="createForm.eventIds"
            :options="
              store.data.events
                .filter((event) => event.status !== 'retired')
                .map((event) => ({
                  label: `${event.displayName} (${event.key})`,
                  value: event.id,
                }))
            "
            multiple
            filterable
          />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="createVisible = false">取消</t-button>
        <t-button theme="primary" @click="createRelease">创建并比较</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="migrationVisible" header="确认下游迁移" width="620px" :footer="false">
      <div class="editor-form">
        <div class="field">
          <label>确认人</label>
          <t-input v-model="migrationForm.reviewer" />
        </div>
        <div class="field field-wide">
          <label>迁移说明</label>
          <t-textarea v-model="migrationForm.note" :autosize="{ minRows: 5, maxRows: 8 }" />
        </div>
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="migrationVisible = false">取消</t-button>
        <t-button theme="primary" @click="confirmMigration">确认迁移</t-button>
      </div>
    </t-dialog>

    <t-dialog v-model:visible="approvalVisible" header="提交审批" width="620px" :footer="false">
      <div v-if="singleApproval" class="selected-approval">
        <strong>{{ roleLabel(singleApproval.role) }}</strong>
        <span>{{ singleApproval.actor }}</span>
      </div>
      <div class="field">
        <label>审批意见</label>
        <t-textarea v-model="approvalComment" :autosize="{ minRows: 5, maxRows: 8 }" />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="approvalVisible = false">取消</t-button>
        <t-button theme="danger" @click="submitApproval('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitApproval('approved')">
          <template #icon><CheckCircleIcon /></template>
          通过
        </t-button>
      </div>
    </t-dialog>
    <t-dialog
      v-if="activeAck"
      v-model:visible="platformAckVisible"
      :header="`${PLATFORM_LABELS[activeAck.platform]} 端确认与审批`"
      width="620px"
      :footer="false"
    >
      <div class="selected-approval">
        <strong>{{ PLATFORM_LABELS[activeAck.platform] }} · {{ activeAck.owner }}</strong>
        <span>当前基于矩阵 r{{ activeAck.matrixRevision }}</span>
      </div>
      <div v-if="activeAck.invalidated" class="invalid-banner">
        {{ activeAck.invalidReason }}
      </div>
      <div class="field">
        <label>该端确认 / 审批意见</label>
        <t-textarea
          v-model="ackComment"
          :autosize="{ minRows: 5, maxRows: 8 }"
          placeholder="确认该端当前采集或停采状态及下游消费口径"
        />
      </div>
      <div class="dialog-footer">
        <t-button variant="outline" @click="platformAckVisible = false">取消</t-button>
        <t-button variant="outline" @click="submitPlatformAck('confirmed')">仅确认</t-button>
        <t-button theme="danger" @click="submitPlatformAck('rejected')">
          <template #icon><CloseCircleIcon /></template>
          驳回
        </t-button>
        <t-button theme="primary" @click="submitPlatformAck('approved')">
          <template #icon><CheckCircleIcon /></template>
          审批通过
        </t-button>
      </div>
    </t-dialog>
  </div>
</template>

<style scoped>
.filter-panel {
  padding: 14px 16px;
}

.release-field {
  min-width: 390px;
}

.collection-panel .impact-table-wrap {
  overflow-x: auto;
}

.impact-table {
  width: 100%;
  border-collapse: collapse;
}

.impact-table th,
.impact-table td {
  padding: 10px 12px;
  border-bottom: 1px solid #edf0f3;
  text-align: left;
  font-size: 12px;
  vertical-align: top;
}

.impact-table thead th {
  color: #6a7588;
  background: #f7f9fb;
}

.impact-table tr.stopped {
  background: #fff8f7;
}

.impact-table .basis-cell {
  max-width: 300px;
  color: #596579;
}

.state-inline {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.stop-icon {
  color: #c7362c;
}

.dep-tags {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 5px;
}

.invalid-reason {
  color: #a8352a !important;
}

.ack-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.ack-card {
  display: grid;
  gap: 7px;
  padding: 14px 16px;
  background: #fff;
}

.ack-card.invalid {
  background: #fff7f6;
}

.ack-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ack-owner,
.ack-meta {
  color: #7d8898;
  font-size: 11px;
}

.ack-meta {
  display: flex;
  justify-content: space-between;
}

.ack-card p {
  margin: 0;
  color: #5c687a;
  font-size: 11px;
  line-height: 1.5;
}

.ack-card :deep(.t-button) {
  justify-self: start;
}

.invalid-banner {
  margin-bottom: 14px;
  padding: 10px 12px;
  border: 1px solid #f2c4c0;
  border-radius: 6px;
  color: #a8352a;
  background: #fff5f4;
  font-size: 12px;
  line-height: 1.6;
}

.migration-card.invalid {
  background: #fff7f6;
}

.review-columns.single-row {
  grid-template-columns: minmax(0, 1fr);
}

.release-overview {
  display: grid;
  grid-template-columns: 180px minmax(260px, 1fr) 130px 140px auto;
  align-items: center;
  gap: 1px;
  overflow: hidden;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #dfe3e8;
}

.release-overview > div,
.release-overview > button {
  align-self: stretch;
}

.release-overview > div {
  display: grid;
  gap: 6px;
  padding: 14px 16px;
  background: #fff;
}

.release-overview span {
  color: #717c8e;
  font-size: 11px;
}

.release-overview > button {
  border-radius: 0;
}

.release-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(340px, 0.55fr);
  gap: 16px;
  align-items: start;
}

.diff-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.diff-event {
  padding: 16px;
  background: #fff;
}

.diff-event-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 12px;
}

.diff-event-head strong {
  font-family: monospace;
  font-size: 12px;
}

.diff-event-head span {
  color: #737e90;
  font-size: 11px;
}

.gate-list {
  padding: 10px 16px 18px;
}

.gate-row {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 10px;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
}

.gate-row svg {
  color: #0f8a62;
}

.gate-row svg.pending {
  color: #c46a00;
}

.gate-row > div {
  display: grid;
  gap: 4px;
}

.gate-row strong {
  font-size: 12px;
}

.gate-row span,
.readiness span {
  color: #727d8f;
  font-size: 11px;
}

.readiness {
  display: grid;
  gap: 7px;
  padding-top: 16px;
}

.readiness strong {
  font-size: 24px;
}

.review-columns {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}

.migration-list {
  display: grid;
  gap: 1px;
  background: #e8ebef;
}

.migration-card {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 9px;
  padding: 15px 16px;
  background: #fff;
}

.migration-card > div {
  display: grid;
  gap: 4px;
}

.migration-card span,
.migration-card p {
  color: #6d788b;
  font-size: 11px;
}

.migration-card p {
  grid-column: 1 / -1;
  margin: 0;
  line-height: 1.5;
}

.migration-card :deep(.t-button) {
  grid-column: 1 / -1;
  justify-self: start;
}

.approval-list {
  display: grid;
  padding: 6px 16px;
}

.approval-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid #edf0f3;
  cursor: pointer;
}

.approval-row > div {
  display: grid;
  gap: 4px;
}

.approval-row span {
  color: #717c8e;
  font-size: 11px;
}

.batch-bar {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8ebef;
}

.selected-approval {
  display: flex;
  justify-content: space-between;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px solid #dfe3e8;
  border-radius: 6px;
  background: #fafbfc;
}

.selected-approval span {
  color: #717c8e;
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
