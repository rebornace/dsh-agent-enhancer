import type { AutoTierRoute } from './types.ts'

const byAgent = new WeakMap<object, AutoTierRoute>()
const bySession = new WeakMap<object, AutoTierRoute>()

export function getSessionResolvedRoute(agent: object | undefined): AutoTierRoute | undefined {
  if (agent === undefined) return undefined
  return byAgent.get(agent)
}

export function getSessionResolvedRouteForSession(session: object | undefined): AutoTierRoute | undefined {
  if (session === undefined) return undefined
  return bySession.get(session)
}

export function setSessionResolvedRoute(agent: object, route: AutoTierRoute): void {
  byAgent.set(agent, route)
  const session = (agent as { session?: object }).session
  if (session !== undefined) bySession.set(session, route)
}

export function setSessionResolvedRouteForSession(session: object, route: AutoTierRoute): void {
  bySession.set(session, route)
}

export function clearSessionResolvedRoute(agent: object): void {
  byAgent.delete(agent)
  const session = (agent as { session?: object }).session
  if (session !== undefined) bySession.delete(session)
}
