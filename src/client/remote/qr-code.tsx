import { useMemo } from 'react'
import { encodeQr, qrModulesPath } from './qr.ts'

export interface QrCodeProps {
  /** Payload to encode. For WeChat this is `qrUrl`, never a page to open. */
  readonly value: string
  /** Rendered edge length in px; the SVG scales, so this is only a hint. */
  readonly size?: number
  readonly label: string
}

/**
 * QR for the login URL. Rendered as one path with crisp edges so it scans from
 * the settings card without exporting an image.
 */
export function QrCode({ value, size = 180, label }: QrCodeProps) {
  const view = useMemo(() => {
    const matrix = encodeQr(value)
    return {
      path: qrModulesPath(matrix, 4),
      extent: matrix.size + 8,
    }
  }, [value])

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${view.extent} ${view.extent}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={view.extent} height={view.extent} fill="#ffffff" />
      <path d={view.path} fill="#000000" />
    </svg>
  )
}
