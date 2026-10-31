declare module '*.module.css' {
  const classNames: Record<string, string>
  export function installCss(): () => void
  export default classNames
}
