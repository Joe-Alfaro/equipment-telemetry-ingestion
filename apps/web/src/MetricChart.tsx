import type { Reading } from '@telemetry/shared'
import { defineChart, type ChartFocusStrategy } from '@tanstack/charts'
import { dot } from '@tanstack/charts/dot'
import { lineY } from '@tanstack/charts/line'
import { Chart } from '@tanstack/charts/react'
import { ruleX, ruleY } from '@tanstack/charts/rule'
import { scaleLinear } from '@tanstack/charts/scales/linear'
import { text } from '@tanstack/charts/text'
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { formatClock, formatClockTick, formatTick, formatValue } from './chartFormat'
import { GAP_MS, xTicks, yDomain, yTicks, type Point, type Series } from './series'

export type MetricChartVariant = 'card' | 'page'

interface MetricChartProps {
  metric: string
  series: Series
  /** The shared x domain in epoch ms (rule 4). */
  domain: [number, number]
  now: number
  variant: MetricChartVariant
}

interface Margin {
  top: number
  right: number
  bottom: number
  left: number
}

/** Fixed plot margins: the right one holds the end label, the bottom one the x tick labels. */
const LAYOUT: Record<MetricChartVariant, { height: number; initialWidth: number; margin: Margin }> =
  {
    card: { height: 64, initialWidth: 220, margin: { top: 8, right: 76, bottom: 16, left: 4 } },
    page: { height: 240, initialWidth: 640, margin: { top: 12, right: 92, bottom: 26, left: 48 } },
  }

// Colors are CSS custom properties so they follow light and dark mode (styles.css).
const SERIES = 'var(--series-1)'
const SURFACE = 'var(--surface)'
const TEXT = 'var(--text)'
const MUTED = 'var(--muted)'
const GRID = 'var(--grid)'

/**
 * The library's own focus is turned off: the chart is still a focusable role="img" SVG, but focus,
 * arrow keys, pointer snapping, the crosshair and the role="tooltip" are ours (rule 13), so focus
 * starts on the latest reading and every reading is reachable.
 */
const NO_LIBRARY_FOCUS: ChartFocusStrategy<Point | Label, number, number> = {
  resolve: () => [],
  group: () => [],
  navigation: () => [],
}

function flagsOf(reading: Reading) {
  return [
    reading.late && 'late',
    reading.outOfOrder && 'out of order',
    reading.future && 'future',
  ].filter((flag): flag is string => typeof flag === 'string')
}

function isFlagged(point: Point) {
  return flagsOf(point.reading).length > 0
}

/** "temperature, current 72.4, range 68.1 to 75.0 over the last 10 minutes, 1 gap" (rule 14). */
function summarize(metric: string, series: Series) {
  const gaps = series.segments.length - 1
  const gapText = gaps > 0 ? `, ${gaps} ${gaps === 1 ? 'gap' : 'gaps'}` : ''
  const current = series.latest ? formatValue(series.latest.value) : 'none'
  return `${metric}, current ${current}, range ${formatValue(series.min ?? 0)} to ${formatValue(
    series.max ?? 0,
  )} over the last 10 minutes${gapText}`
}

/**
 * One metric's last 10 minutes (rules 7-14): a 2px line per gap-free segment, an end dot with the
 * current value beside it, and on the history page y ticks, clock-time x ticks, hairline grid and
 * hollow rings on flagged readings. All visible chart text is SVG text inside the role="img".
 */
export function MetricChart({ metric, series, domain, now, variant }: MetricChartProps) {
  const tooltipId = useId()
  const [active, setActive] = useState<number | null>(null)
  const { height, initialWidth, margin } = LAYOUT[variant]
  const points = useMemo(() => series.segments.flat(), [series])
  const activePoint = active === null ? undefined : points[Math.min(active, points.length - 1)]

  const definition = useMemo(
    () => buildDefinition({ series, points, domain, now, variant, margin, activePoint }),
    [series, points, domain, now, variant, margin, activePoint],
  )

  /** Snaps to the reading nearest the pointer's time; the whole plot is the hit area. */
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect()
    const plotWidth = box.width - margin.left - margin.right
    if (plotWidth <= 0 || points.length === 0) {
      return
    }
    const fraction = (event.clientX - box.left - margin.left) / plotWidth
    const time = domain[0] + fraction * (domain[1] - domain[0])
    const nearest = points.reduce(
      (best, point, index) =>
        Math.abs(point.time - time) < Math.abs((points[best]?.time ?? 0) - time) ? index : best,
      0,
    )
    setActive(nearest)
  }

  function onPointerLeave(event: PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(document.activeElement)) {
      setActive(null)
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const last = points.length - 1
    const current = active ?? last
    const next: Record<string, number> = {
      ArrowLeft: Math.max(0, current - 1),
      ArrowRight: Math.min(last, current + 1),
      Home: 0,
      End: last,
    }
    if (event.key === 'Escape') {
      setActive(null)
      return
    }
    if (event.key in next && last >= 0) {
      event.preventDefault()
      setActive(next[event.key] ?? last)
    }
  }

  return (
    <div
      className={`metric-chart metric-chart-${variant}`}
      onFocus={() => setActive(points.length - 1)}
      onBlur={() => setActive(null)}
      onKeyDown={onKeyDown}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <Chart
        definition={definition}
        height={height}
        initialWidth={initialWidth}
        ariaLabel={summarize(metric, series)}
        tabIndex={0}
      />
      {activePoint && (
        <ChartTooltip id={tooltipId} point={activePoint} domain={domain} margin={margin} />
      )}
    </div>
  )
}

interface ChartTooltipProps {
  id: string
  point: Point
  domain: [number, number]
  margin: Margin
}

/** Value (strong), event time, gateway and flags, placed over the crosshair. Text only. */
function ChartTooltip({ id, point, domain, margin }: ChartTooltipProps) {
  const ref = useRef<HTMLDivElement>(null)
  const fraction = (point.time - domain[0]) / (domain[1] - domain[0])
  const flags = flagsOf(point.reading)

  // Beside the crosshair (left of it in the right half), clamped inside the chart so a narrow
  // card never clips it. Measured after layout, since its width depends on the text.
  useLayoutEffect(() => {
    const tooltip = ref.current
    const chart = tooltip?.parentElement
    if (!tooltip || !chart) {
      return
    }
    const width = chart.clientWidth
    const x = margin.left + fraction * (width - margin.left - margin.right)
    const preferred = fraction > 0.5 ? x - tooltip.offsetWidth - 8 : x + 8
    const left = Math.max(0, Math.min(preferred, width - tooltip.offsetWidth))
    tooltip.style.left = `${left}px`
  })

  return (
    <div ref={ref} id={id} role="tooltip" className="chart-tooltip">
      <strong>{formatValue(point.value)}</strong>{' '}
      <time dateTime={point.reading.eventTime}>{formatClock(point.time)}</time>{' '}
      <span>{point.reading.gatewayId}</span>
      {flags.length > 0 && <span className="chart-tooltip-flags"> {flags.join(', ')}</span>}
    </div>
  )
}

interface DefinitionInput {
  series: Series
  points: Point[]
  domain: [number, number]
  now: number
  variant: MetricChartVariant
  margin: Margin
  activePoint: Point | undefined
}

/** A text label at a data position, offset in pixels. */
interface Label {
  x: number
  y: number
  text: string
}

function buildDefinition({
  series,
  points,
  domain,
  now,
  variant,
  margin,
  activePoint,
}: DefinitionInput) {
  // The history page may widen the padded domain to whole tick steps (yTicks).
  const ticks = variant === 'page' ? yTicks(yDomain(series)) : null
  const [low, high] = ticks?.domain ?? yDomain(series)
  const lastPoint = points.at(-1)
  const lines = series.segments
    .filter((segment) => segment.length > 1)
    .map((segment) => lineY(segment, { x: 'time', y: 'value', stroke: SERIES, strokeWidth: 2 }))
  // A one-reading segment has no line to draw, so it is a small dot (rule 5).
  const lonePoints = series.segments.filter((segment) => segment.length === 1).flat()
  const stale = lastPoint !== undefined && now - lastPoint.time > GAP_MS
  // The "as of" line goes on the side of the end label with more room.
  const asOfBelow = lastPoint !== undefined && lastPoint.value > (low + high) / 2
  const endLabels: Label[] = lastPoint
    ? [{ x: lastPoint.time, y: lastPoint.value, text: formatValue(lastPoint.value) }]
    : []
  const asOfLabels: Label[] =
    lastPoint && stale
      ? [{ x: lastPoint.time, y: lastPoint.value, text: `as of ${formatClock(lastPoint.time)}` }]
      : []
  const guides =
    ticks === null ? cardGuides(series, domain, now, low) : pageGuides(domain, low, ticks)

  return defineChart({
    marks: [
      ...guides.grid.map((value) =>
        ruleY([value], { stroke: GRID, strokeWidth: 1, strokeOpacity: 1 }),
      ),
      ...(activePoint
        ? [ruleX([activePoint.time], { stroke: MUTED, strokeWidth: 1, strokeOpacity: 1 })]
        : []),
      ...lines,
      dot(lonePoints, { x: 'time', y: 'value', r: 2.5, fill: SERIES }),
      // Rule 12: flagged readings get a hollow ring, so the flag never rests on color alone.
      dot(variant === 'page' ? points.filter(isFlagged) : [], {
        x: 'time',
        y: 'value',
        r: 4,
        fill: SURFACE,
        stroke: SERIES,
        strokeWidth: 1.5,
      }),
      // The end dot: 8px of series color inside a 2px ring of the surface color.
      dot(lastPoint ? [lastPoint] : [], {
        x: 'time',
        y: 'value',
        r: 5,
        fill: SERIES,
        stroke: SURFACE,
        strokeWidth: 2,
      }),
      dot(activePoint ? [activePoint] : [], {
        x: 'time',
        y: 'value',
        r: 4,
        fill: 'none',
        stroke: TEXT,
        strokeWidth: 1.5,
      }),
      text(endLabels, {
        x: 'x',
        y: 'y',
        text: 'text',
        anchor: 'start',
        dx: 9,
        fill: TEXT,
        fontSize: variant === 'card' ? 13 : 14,
        fontWeight: 600,
      }),
      text(asOfLabels, {
        x: 'x',
        y: 'y',
        text: 'text',
        anchor: 'start',
        dx: 9,
        dy: asOfBelow ? 14 : -14,
        fill: MUTED,
        fontSize: 10,
      }),
      ...guides.labels.map(({ labels, anchor, dx, dy }) =>
        text(labels, { x: 'x', y: 'y', text: 'text', anchor, dx, dy, fill: MUTED, fontSize: 10 }),
      ),
    ],
    scales: {
      // Configured instances, not factories: a factory would infer its domain from the marks.
      x: { scale: scaleLinear().domain(domain) },
      y: { scale: scaleLinear().domain([low, high]) },
    },
    guides: false,
    margin,
    focus: NO_LIBRARY_FOCUS,
    focusRing: false,
    keyboard: true,
  })
}

interface LabelGroup {
  labels: Label[]
  anchor: 'start' | 'middle' | 'end'
  dx: number
  dy: number
}

interface Guides {
  grid: number[]
  labels: LabelGroup[]
}

/** Rule 11: "−10m" and "now" under the line's ends, and a muted "min–max" between them. */
function cardGuides(
  series: Series,
  [start, end]: [number, number],
  now: number,
  low: number,
): Guides {
  const range = `${formatValue(series.min ?? 0)}–${formatValue(series.max ?? 0)}`
  return {
    grid: [],
    labels: [
      { labels: [{ x: start, y: low, text: '−10m' }], anchor: 'start', dx: 0, dy: 11 },
      { labels: [{ x: (start + end) / 2, y: low, text: range }], anchor: 'middle', dx: 0, dy: 11 },
      { labels: [{ x: now, y: low, text: 'now' }], anchor: 'end', dx: 0, dy: 11 },
    ],
  }
}

/** Rule 12: 4-5 clean y ticks with hairline grid rules, and clock-time x ticks every 2 minutes. */
function pageGuides(
  domain: [number, number],
  low: number,
  { values, step }: { values: number[]; step: number },
): Guides {
  return {
    grid: values,
    labels: [
      {
        labels: values.map((value) => ({ x: domain[0], y: value, text: formatTick(value, step) })),
        anchor: 'end',
        dx: -8,
        dy: 0,
      },
      {
        labels: xTicks(domain).map((time) => ({ x: time, y: low, text: formatClockTick(time) })),
        anchor: 'middle',
        dx: 0,
        dy: 16,
      },
    ],
  }
}
