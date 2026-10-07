import type { GovernanceState } from '@/models/domain'
import { createSeedState } from '@/models/seed'

const STORAGE_KEY = 'eventrail-governance-v1'

/** 兼容旧版本持久化数据：补齐按端采集矩阵相关字段。 */
const normalizeState = (raw: GovernanceState): GovernanceState => ({
  ...raw,
  collectionMatrix: raw.collectionMatrix ?? [],
  matrixDrafts: raw.matrixDrafts ?? [],
  matrixRevision: raw.matrixRevision ?? 0,
  releases: (raw.releases ?? []).map((release) => ({
    ...release,
    matrixSnapshot: release.matrixSnapshot ?? [],
  })),
  rollbacks: (raw.rollbacks ?? []).map((record) => ({
    ...record,
    matrixChecks: record.matrixChecks ?? [],
  })),
})

export const loadState = (): GovernanceState => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  try {
    return normalizeState(JSON.parse(raw) as GovernanceState)
  } catch {
    const seed = createSeedState()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
}

export const saveState = (state: GovernanceState): void => {
  // JSON 序列化即可深拷贝，且能穿透 Vue 响应式代理（structuredClone 无法克隆 Proxy）
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

export const resetState = (): GovernanceState => {
  const seed = createSeedState()
  saveState(seed)
  return seed
}

export const createId = (prefix: string): string =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
