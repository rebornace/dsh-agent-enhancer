declare module '@deepseek-ai/dsh-mcp-client' {
  import type { Context } from '@deepseek-ai/cordis'

  export const name: string
  export const inject: readonly string[]
  export const Config: unknown
  export function apply(ctx: Context, config: Record<string, unknown>): Promise<void> | void
  export function createMcpToolDefinition(...args: unknown[]): unknown
}
