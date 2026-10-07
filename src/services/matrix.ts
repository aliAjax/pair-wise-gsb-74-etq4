import type {
  CollectionMatrixCell,
  DownstreamDependency,
  GovernanceState,
  MatrixReconciliationItem,
  Platform,
  ReleaseCandidate,
  RollbackRecord,
} from '@/models/domain'
import { PLATFORMS } from '@/models/domain'

export const cellKey = (eventId: string, platform: Platform): string => `${eventId}:${platform}`

export const matrixCell = (
  state: GovernanceState,
  eventId: string,
  platform: Platform,
): CollectionMatrixCell | undefined =>
  state.collectionMatrix.find((cell) => cell.eventId === eventId && cell.platform === platform)

export const eventMatrixCells = (
  state: GovernanceState,
  eventId: string,
): CollectionMatrixCell[] =>
  state.collectionMatrix
    .filter((cell) => cell.eventId === eventId)
    .sort(
      (a, b) =>
        PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) ||
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )

export const stoppedPlatforms = (state: GovernanceState, eventId: string): Platform[] =>
  eventMatrixCells(state, eventId)
    .filter((cell) => cell.state === 'stopped')
    .map((cell) => cell.platform)

/** 下游消费范围：未声明即为全量消费 */
export const dependencyPlatforms = (dependency: DownstreamDependency): Platform[] =>
  dependency.consumptionPlatforms && dependency.consumptionPlatforms.length > 0
    ? dependency.consumptionPlatforms
    : [...PLATFORMS]

export const dependencyConsumes = (dependency: DownstreamDependency, platform: Platform): boolean =>
  dependencyPlatforms(dependency).includes(platform)

export const dependencyModeLabel = (dependency: DownstreamDependency): string =>
  dependency.consumptionPlatforms && dependency.consumptionPlatforms.length > 0
    ? dependency.consumptionPlatforms.join(' / ')
    : '全量消费'

/** 仍在消费某事件某端的下游依赖 */
export const downstreamConsumers = (
  state: GovernanceState,
  eventId: string,
  platform: Platform,
): DownstreamDependency[] =>
  state.dependencies.filter(
    (dependency) =>
      dependency.eventIds.includes(eventId) && dependencyConsumes(dependency, platform),
  )

export interface ReleasePlatformImpact {
  eventId: string
  platform: Platform
  state: CollectionMatrixCell['state']
  basis: string
  effectiveAt: string
  revision: number
  dependencies: DownstreamDependency[]
}

/** 发布候选范围内各端的采集状态及仍在消费的下游 */
export const releaseCollectionImpacts = (
  state: GovernanceState,
  release: ReleaseCandidate,
): ReleasePlatformImpact[] =>
  release.eventIds.flatMap((eventId) =>
    eventMatrixCells(state, eventId).map((cell) => ({
      eventId,
      platform: cell.platform,
      state: cell.state,
      basis: cell.basis,
      effectiveAt: cell.effectiveAt,
      revision: cell.revision,
      dependencies: downstreamConsumers(state, eventId, cell.platform),
    })),
  )

/** 候选中需要完成按端确认审批的平台 */
export const releaseAckPlatforms = (
  cells: CollectionMatrixCell[],
  eventIds: string[],
): Platform[] => {
  const platforms = new Set<Platform>()
  cells
    .filter((cell) => eventIds.includes(cell.eventId))
    .forEach((cell) => platforms.add(cell.platform))
  return [...platforms].sort((a, b) => PLATFORMS.indexOf(a) - PLATFORMS.indexOf(b))
}

/** 该端确认审批是否仍与矩阵一致 */
export const ackIsCurrent = (state: GovernanceState, ack: {
  platform: Platform
  matrixRevision: number
  invalidated?: boolean
}, release: ReleaseCandidate): boolean => {
  if (ack.invalidated) return false
  const stale = release.eventIds.some((eventId) => {
    const cell = matrixCell(state, eventId, ack.platform)
    return Boolean(cell && cell.revision > ack.matrixRevision)
  })
  return !stale
}

export interface MatrixExportRow {
  eventId: string
  eventKey: string
  displayName: string
  platform: Platform
  state: CollectionMatrixCell['state']
  basis: string
  effectiveAt: string
  actor: string
  revision: number
  downstream: Array<{ id: string; name: string; mode: string }>
}

export const collectionMatrixExport = (state: GovernanceState): MatrixExportRow[] =>
  state.events.flatMap((event) =>
    eventMatrixCells(state, event.id).map((cell) => ({
      eventId: event.id,
      eventKey: event.key,
      displayName: event.displayName,
      platform: cell.platform,
      state: cell.state,
      basis: cell.basis,
      effectiveAt: cell.effectiveAt,
      actor: cell.actor,
      revision: cell.revision,
      downstream: downstreamConsumers(state, event.id, cell.platform).map((dependency) => ({
        id: dependency.id,
        name: dependency.name,
        mode: dependencyModeLabel(dependency),
      })),
    })),
  )

/**
 * 回滚后按矩阵对账：
 * 1. 平台规则与矩阵启停不一致；
 * 2. 评审中发布的该端确认审批已失效；
 * 3. 已停采的端仍被未完成迁移的下游按全量或显式消费。
 */
export const reconcileRollback = (
  state: GovernanceState,
  record: RollbackRecord,
): MatrixReconciliationItem[] => {
  if (record.matrixSnapshot.length === 0) return []
  const snapshotEvents = [...new Set(record.matrixSnapshot.map((cell) => cell.eventId))]
  const items: MatrixReconciliationItem[] = []

  record.matrixSnapshot.forEach((snapshot) => {
    const current = matrixCell(state, snapshot.eventId, snapshot.platform)
    const event = state.events.find((item) => item.id === snapshot.eventId)
    const rule = event?.platformRules.find((item) => item.platform === snapshot.platform)

    if (rule && current && rule.enabled !== (current.state === 'collecting')) {
      items.push({
        kind: 'rule_mismatch',
        severity: 'critical',
        eventId: snapshot.eventId,
        platform: snapshot.platform,
        detail: `平台规则${rule.enabled ? '仍在采集' : '已关闭'}，与矩阵“${
          current.state === 'stopped' ? '已停采' : '采集中'
        }”不一致。`,
      })
    }
    if (current && current.state !== snapshot.state) {
      items.push({
        kind: 'rule_mismatch',
        severity: 'high',
        eventId: snapshot.eventId,
        platform: snapshot.platform,
        detail: `回滚时为“${snapshot.state === 'stopped' ? '已停采' : '采集中'}”，当前矩阵已变为“${
          current.state === 'stopped' ? '已停采' : '采集中'
        }”，需确认是否符合回滚预期。`,
      })
    }

    const consumers = downstreamConsumers(state, snapshot.eventId, snapshot.platform)
    const pending = consumers.filter((dependency) => dependency.status !== 'migrated')
    if (current?.state === 'stopped' && pending.length > 0) {
      items.push({
        kind: 'downstream_risk',
        severity: 'high',
        eventId: snapshot.eventId,
        platform: snapshot.platform,
        detail: `该端已停采，但 ${pending
          .map((dependency) => dependency.name)
          .join('、')} 仍在消费且未完成迁移确认。`,
      })
    }
  })

  state.releases
    .filter((release) => release.status === 'reviewing')
    .forEach((release) => {
      if (!release.eventIds.some((eventId) => snapshotEvents.includes(eventId))) return
      release.platformAcks.forEach((ack) => {
        const touches = release.eventIds.some((eventId) =>
          record.matrixSnapshot.some(
            (cell) => cell.eventId === eventId && cell.platform === ack.platform,
          ),
        )
        if (touches && !ackIsCurrent(state, ack, release)) {
          items.push({
            kind: 'stale_ack',
            severity: 'medium',
            eventId: release.eventIds.find((eventId) =>
              record.matrixSnapshot.some(
                (cell) => cell.eventId === eventId && cell.platform === ack.platform,
              ),
            ) ?? release.eventIds[0]!,
            platform: ack.platform,
            detail: `发布候选 ${release.version} 的 ${ack.platform} 端确认审批已失效，发布前必须重新确认。`,
          })
        }
      })
    })

  return items
}
