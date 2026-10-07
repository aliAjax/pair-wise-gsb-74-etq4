import type {
  CollectionMatrixCell,
  GovernanceState,
  Platform,
  PlatformReleaseAck,
} from '@/models/domain'
import { PLATFORMS } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v1'

/** 平台规则负责人兜底为矩阵确认人 */
const ruleOwner = (state: GovernanceState, eventId: string, platform: Platform): string =>
  state.events
    .find((event) => event.id === eventId)
    ?.platformRules.find((rule) => rule.platform === platform)?.owner ?? '平台负责人'

/** 由平台规则构建矩阵单元格，用于演示基线与历史本地状态恢复 */
export const buildMatrixFromRules = (state: GovernanceState): CollectionMatrixCell[] => {
  const existing = new Map(
    (state.collectionMatrix ?? []).map((cell) => [`${cell.eventId}:${cell.platform}`, cell]),
  )
  const cells: CollectionMatrixCell[] = []
  state.events.forEach((event) => {
    const covered = new Set<Platform>()
    event.platformRules.forEach((rule) => {
      covered.add(rule.platform)
      const key = `${event.id}:${rule.platform}`
      const previous = existing.get(key)
      const stopped = !rule.enabled
      cells.push(
        previous
          ? { ...previous }
          : {
              eventId: event.id,
              platform: rule.platform,
              state: stopped ? 'stopped' : 'collecting',
              basis: stopped
                ? `平台规则已关闭采集：${rule.note || event.key}`
                : '平台规则启用，持续采集',
              effectiveAt: event.updatedAt,
              updatedAt: event.updatedAt,
              actor: rule.owner,
              revision: 0,
              source: 'rule',
            },
      )
    })
  })
  // 保留没有平台规则但已在矩阵中登记的端
  ;(state.collectionMatrix ?? []).forEach((cell) => {
    if (!cells.some((item) => item.eventId === cell.eventId && item.platform === cell.platform)) {
      cells.push({ ...cell })
    }
  })
  return cells
}

/**
 * 从持久化数据恢复完整状态：
 * 写入失败后也以本地存储中的完整矩阵为准，而不是局部增量。
 */
export const normalizeState = (raw: Partial<GovernanceState>): GovernanceState => {
  const base: GovernanceState = {
    ...createSeedState(),
    ...raw,
  } as GovernanceState
  const state: GovernanceState = {
    ...base,
    events: base.events ?? [],
    scenarios: base.scenarios ?? [],
    dependencies: (base.dependencies ?? []).map((dependency) => ({
      consumptionPlatforms: [] as Platform[],
      ...dependency,
    })),
    baselines: base.baselines ?? [],
    releases: (base.releases ?? []).map((release) => ({ ...release })),
    deprecations: base.deprecations ?? [],
    rollbacks: base.rollbacks ?? [],
    audit: base.audit ?? [],
  }

  if (!Array.isArray(base.collectionMatrix) || base.collectionMatrix.length === 0) {
    state.collectionMatrix = buildMatrixFromRules(state)
  } else {
    state.collectionMatrix = base.collectionMatrix.map((cell) => ({ ...cell }))
  }
  state.collectionChanges = Array.isArray(base.collectionChanges) ? base.collectionChanges : []
  state.collectionDrafts = Array.isArray(base.collectionDrafts) ? base.collectionDrafts : []

  // 回填历史发布候选缺失的按端确认审批
  state.releases.forEach((release) => {
    if (!Array.isArray(release.platformAcks)) release.platformAcks = []
    if (release.status === 'reviewing') {
      const platforms = new Set<Platform>()
      release.eventIds.forEach((eventId) => {
        state.collectionMatrix
          .filter((cell) => cell.eventId === eventId)
          .forEach((cell) => platforms.add(cell.platform))
      })
      platforms.forEach((platform) => {
        const has = release.platformAcks.some((ack) => ack.platform === platform)
        if (!has) {
          const firstEvent = release.eventIds.find((eventId) =>
            state.collectionMatrix.some(
              (cell) => cell.eventId === eventId && cell.platform === platform,
            ),
          )
          const owner = firstEvent ? ruleOwner(state, firstEvent, platform) : '平台负责人'
          const ack: PlatformReleaseAck = {
            id: `ack-seed-${release.id}-${platform}`,
            platform,
            owner,
            status: 'pending',
            comment: '',
            matrixRevision:
              state.collectionMatrix.find(
                (cell) => cell.eventId === firstEvent && cell.platform === platform,
              )?.revision ?? 0,
          }
          release.platformAcks.push(ack)
        }
      })
    }
  })

  if (typeof state.matrixRevision !== 'number') {
    state.matrixRevision = state.collectionMatrix.reduce(
      (max, cell) => Math.max(max, cell.revision),
      0,
    )
  }
  return state
}

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = normalizeState(createSeedState())
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return normalizeState(JSON.parse(raw) as Partial<GovernanceState>)
  } catch {
    const seed = normalizeState(createSeedState())
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

/** 演示用：下一次写入抛错，用于验证“写入失败后从完整矩阵恢复” */
let failNextWrite = false
export const armNextWriteFailure = (): void => {
  failNextWrite = true
}
export const isWriteFailureArmed = (): boolean => failNextWrite

export const saveState = (state: GovernanceState): void => {
  if (failNextWrite) {
    failNextWrite = false
    throw new Error('本地存储写入失败（模拟网络抖动/配额异常）')
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(structuredClone(state)))
}

export const resetState = (): GovernanceState => {
  const seed = normalizeState(createSeedState())
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 另一个窗口完成写入后，本窗口从本地存储读取完整矩阵对账 */
export const subscribeExternalState = (onChange: (state: GovernanceState) => void): (() => void) => {
  const handler = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY || !event.newValue) return
    try {
      onChange(normalizeState(JSON.parse(event.newValue) as Partial<GovernanceState>))
    } catch {
      // 损坏的外部写入不覆盖当前内存状态
    }
  }
  window.addEventListener('storage', handler)
  return () => window.removeEventListener('storage', handler)
}

export const ALL_PLATFORMS = PLATFORMS
