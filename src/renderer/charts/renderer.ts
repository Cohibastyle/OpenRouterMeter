import {
  createTimeAxis,
  generateTicks,
  generateValueTicks,
  hitTest,
  type TimeAxis,
} from '../../shared/timeAxis.js';
import { barGrowthFrame, planBarGrowth, BAR_SOLID_MS, type BarGrowth } from '../../shared/barGrowth.js';
import { formatAge, formatAxisValue, formatSpend, formatTokensCompact } from '../../shared/format.js';
import type { ChartData } from '../../shared/types.js';
import { motionAllowed } from '../components/odometer.js';

export interface ChartOptions {
  metric: 'spend' | 'tokens';
  onBinClick?: (index: number) => void;
  /**
   * Whether the axis rides the clock instead of the fetched period.
   *
   * A live chart must pan continuously: a 10-minute chart moves one minute of x
   * axis per minute, not one step per fetch. The window is therefore anchored to
   * `Date.now()` and keeps the span the data was fetched with, so the axis slides
   * smoothly between refreshes while the bars stay pinned to their own
   * timestamps.
   *
   * A pinned chart is the exception. It shows a period the user deliberately
   * paged back to, so its axis must stay where it is.
   */
  live: boolean;
}

interface RenderedBin {
  start: number;
  end: number;
  value: number;
  input: number;
  output: number;
  partial: boolean;
  missing: boolean;
}

/** Share of a bar's width left empty on each side, and the pixel bounds. */
const BAR_GAP_RATIO = 0.3;
const BAR_GAP_MIN_PX = 2;
const BAR_GAP_MAX_PX = 16;

/**
 * Smallest vertical gap between two value-axis labels, in CSS pixels.
 *
 * The labels are drawn at 9px, so this keeps a grid line and its neighbour from
 * running together when the plot is compressed by a short window.
 */
const VALUE_TICK_MIN_GAP = 26;

/**
 * Smallest left gutter, so a plot of zeros still keeps its axis off the edge.
 * The gutter grows past this when a label needs the room.
 */
const VALUE_AXIS_MIN_PAD_LEFT = 26;
/** Minimum overlay height so a live increment is visibly distinct. */
const GROWTH_MIN_VISIBLE_PX = 2;

const COLORS = {
  spend: '#34d399',
  // Tokens use the tab's orange accent so the chart, the selected interval, and
  // the interval values all read as one measure. Output is a lighter tint of the
  // same hue rather than a second colour, so the stack still reads as one bar.
  input: '#fb923c',
  output: '#fdba74',
  gridMajor: 'rgba(240,246,252,0.16)',
  gridMinor: 'rgba(240,246,252,0.07)',
  label: '#6e7681',
  partial: 'rgba(251,191,36,0.55)',
  growth: '#fbbf24',
  missing: 'rgba(240,246,252,0.06)',
  crosshair: 'rgba(240,246,252,0.35)',
};

/**
 * Canvas chart renderer.
 *
 * The time axis is linear: a bucket's width on screen is proportional to how
 * long that bucket was, so a bar can be read as a duration as well as a value.
 */
export class ChartRenderer {
  private host: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tooltip: HTMLDivElement;
  private data: ChartData | null = null;
  private options: ChartOptions;
  private axis: TimeAxis | null = null;
  private bins: RenderedBin[] = [];
  private hoverIndex = -1;
  /**
   * Where the pointer last was, in client coordinates, or null when it is away.
   *
   * Kept so the hovered bucket can be recomputed as the axis pans under a
   * motionless pointer.
   */
  private pointer: { x: number; y: number } | null = null;
  private width = 0;
  private height = 0;
  private dpr = 1;
  /**
   * Where the plot area sits, in CSS pixels, as of the last frame.
   *
   * Hit-testing has to use the same geometry the bars were drawn with. Measuring
   * the canvas instead put the pointer up to a gutter's width away from the bin
   * under it — about 26 px at the left edge — so the tooltip named a bar the
   * pointer was not over, and on a live chart the error grew as the axis panned.
   */
  private plotLeft = 0;
  private plotWidth = 0;
  private observer: ResizeObserver | null = null;
  private rafId = 0;
  /** The clock-driven repaint loop's handle, alive only while the chart is live. */
  private panId = 0;
  /**
   * Rising overlays keyed by bin start.
   *
   * Kept across setData so a snapshot that only adds to the current bar grows
   * from the previous top instead of jumping, and so a DOM rebuild that
   * reattaches this canvas can resume the four-second solidify.
   */
  private growths = new Map<number, BarGrowth>();
  /** Last drawn values, used to detect a rise on the next payload. */
  private lastValues = new Map<number, number>();
  /** Scale+metric identity; a change of question drops in-flight growth. */
  private lastSeries = '';
  /** Extra raf while a pinned chart still has an overlay to finish. */
  private growthId = 0;

  constructor(container: HTMLElement, options: ChartOptions) {
    this.host = container;
    this.options = options;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'chart-tooltip';
    this.tooltip.hidden = true;
    container.appendChild(this.tooltip);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.observer = new ResizeObserver(() => this.scheduleRender());
    this.observer.observe(container);

    this.canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.canvas.addEventListener('pointerleave', () => this.onPointerLeave());
    this.canvas.addEventListener('click', (e) => this.onClick(e));

    this.scheduleRender();
  }

  setData(data: ChartData): void {
    this.syncGrowth(data);
    this.data = data;
    this.scheduleRender();
    this.syncPan();
    this.syncGrowthLoop();
  }

  /**
   * Move the canvas into a new host without dropping in-flight growth.
   *
   * The view is rebuilt on every snapshot. Destroying the renderer there is
   * what froze the last bar until the user changed the time span: the new
   * canvas painted the previous payload as a first frame, with no previous
   * height to grow from.
   */
  reattach(container: HTMLElement): void {
    if (this.host === container && this.canvas.parentElement === container) return;
    this.host = container;
    container.appendChild(this.canvas);
    container.appendChild(this.tooltip);
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.scheduleRender());
    this.observer.observe(container);
    this.scheduleRender();
  }

  setOptions(options: Partial<ChartOptions>): void {
    this.options = { ...this.options, ...options };
    this.scheduleRender();
    this.syncPan();
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this.panId) cancelAnimationFrame(this.panId);
    this.panId = 0;
    if (this.growthId) cancelAnimationFrame(this.growthId);
    this.growthId = 0;
    this.canvas.remove();
    this.tooltip.remove();
  }

  private seriesKey(data: ChartData): string {
    return `${data.metric}:${data.scale}`;
  }

  private binValue(data: ChartData, index: number): number {
    const bin = data.bins[index];
    if (!bin || bin.missing) return 0;
    return this.options.metric === 'spend'
      ? (bin.spend_micro ?? 0)
      : (bin.input_tokens ?? 0) + (bin.output_tokens ?? 0);
  }

  private syncGrowth(data: ChartData): void {
    const now = Date.now();
    const series = this.seriesKey(data);
    const animate = motionAllowed();
    if (series !== this.lastSeries) {
      this.growths.clear();
      this.lastValues.clear();
      this.lastSeries = series;
      for (let i = 0; i < data.bins.length; i += 1) {
        const start = new Date(data.bins[i]!.start).getTime();
        this.lastValues.set(start, this.binValue(data, i));
      }
      return;
    }

    const nextValues = new Map<number, number>();
    const nextGrowths = new Map<number, BarGrowth>();
    for (let i = 0; i < data.bins.length; i += 1) {
      const start = new Date(data.bins[i]!.start).getTime();
      const value = this.binValue(data, i);
      nextValues.set(start, value);
      const planned = planBarGrowth(
        this.lastValues.get(start),
        value,
        now,
        this.growths.get(start),
        animate,
      );
      if (planned) nextGrowths.set(start, planned);
    }
    this.lastValues = nextValues;
    this.growths = nextGrowths;
  }

  private growthActive(): boolean {
    const now = Date.now();
    for (const growth of this.growths.values()) {
      if (now - growth.startedAt < BAR_SOLID_MS) return true;
    }
    return false;
  }

  private syncGrowthLoop(): void {
    const shouldRun = this.growthActive() && !this.options.live;
    if (shouldRun && !this.growthId) {
      this.growthId = requestAnimationFrame(this.growthTick);
    } else if (!shouldRun && this.growthId) {
      cancelAnimationFrame(this.growthId);
      this.growthId = 0;
    }
  }

  private readonly growthTick = (): void => {
    if (!this.growthActive()) {
      this.growthId = 0;
      this.scheduleRender();
      return;
    }
    this.growthId = requestAnimationFrame(this.growthTick);
    this.render();
  };

  private scheduleRender(): void {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      this.render();
    });
  }

  /**
   * Start or stop the clock-driven repaint.
   *
   * Called whenever the data or the options change, so a chart that becomes live
   * starts moving at once and one that is pinned stops dead. The loop only
   * repaints: the axis position is read from the clock inside `render`, so there
   * is no offset to advance and nothing to go stale.
   */
  private syncPan(): void {
    const shouldPan = this.options.live && !!this.data;
    if (shouldPan && !this.panId) {
      this.panId = requestAnimationFrame(this.panTick);
    } else if (!shouldPan && this.panId) {
      cancelAnimationFrame(this.panId);
      this.panId = 0;
      this.scheduleRender();
    }
  }

  private readonly panTick = (): void => {
    this.panId = requestAnimationFrame(this.panTick);
    // A redraw per frame is the point: the axis is a continuous function of the
    // clock, so anything slower would visibly step.
    this.render();
    // The plot slid, so the bucket under a motionless pointer is a different one.
    this.refreshHover();
    // Even when the hovered bin does not change, age/partial context evolves
    // while the axis pans, so the tooltip content must be refreshed.
    this.refreshTooltipWhilePanning();
  };

  private render(): void {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) return;

    this.dpr = window.devicePixelRatio || 1;
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);

    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);

    if (!this.data || this.data.bins.length === 0) {
      ctx.fillStyle = COLORS.label;
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data for this period', this.width / 2, this.height / 2);
      return;
    }

    const padTop = 8;
    const padBottom = 14;
    const padRight = 6;
    // A left gutter holds the value labels. Its width is measured from the
    // widest label the axis will actually draw rather than assumed, so a long
    // label such as `$12.34K` shortens the plot instead of being clipped at
    // the left edge of the canvas.
    const padLeft = this.padLeftForHeight(this.height - padTop - padBottom);
    const plotWidth = Math.max(1, this.width - padLeft - padRight);
    const plotHeight = Math.max(1, this.height - padTop - padBottom);
    // Remember the geometry so hit-testing uses the same rectangle the bars were
    // drawn into rather than a guess derived from the canvas size.
    this.plotLeft = padLeft;
    this.plotWidth = plotWidth;

    const periodEnd = new Date(this.data.period_end).getTime();
    const periodStart = new Date(this.data.period_start).getTime();

    // A live chart's window ends now, not at the instant the data was fetched,
    // so the axis advances with the clock and the bars slide leftwards under it.
    // The span comes from the data, so the window keeps the period's full width
    // and a 10-minute chart covers exactly ten minutes. A pinned chart draws the
    // fetched period as it was fetched.
    const span = periodEnd - periodStart;
    const now = Date.now();
    const tEnd = this.options.live ? Math.max(periodEnd, now) : periodEnd;
    const tStart = tEnd - span;

    // The axis does not clamp: a bin whose bucket has slid past the left edge
    // must leave the plot, not pin itself to it and read as the newest value.
    this.axis = createTimeAxis(tStart, tEnd, { clamp: false });

    this.bins = this.data.bins.map((bin) => {
      const start = new Date(bin.start).getTime();
      const nominalEnd = new Date(bin.end).getTime();
      // A live current bucket grows to the clock between fetches. The payload
      // keeps the full bucket end so this clamp can ride `now` instead of
      // freezing at whatever instant the data was built.
      const end = Math.min(nominalEnd, tEnd, this.options.live ? now : tEnd);
      return {
        start,
        end: Math.max(start, end),
        value: this.options.metric === 'spend' ? (bin.spend_micro ?? 0) : (bin.input_tokens ?? 0) + (bin.output_tokens ?? 0),
        input: bin.input_tokens ?? 0,
        output: bin.output_tokens ?? 0,
        partial: bin.partial || (this.options.live && nominalEnd > now),
        missing: bin.missing,
      };
    });

    const rawMax = Math.max(
      0,
      ...this.bins.map((b) => (this.options.metric === 'spend' ? b.value : b.input + b.output)),
    );
    // Round the top of the scale up to a labelled tick so the tallest bar never
    // touches an unlabelled edge. A short plot gets fewer grid lines: the labels
    // are 9px tall, so packing five of them into a compressed chart would make
    // them collide.
    const valueTickCount = Math.min(4, Math.max(1, Math.floor(plotHeight / VALUE_TICK_MIN_GAP)));
    const valueTicks = generateValueTicks(rawMax, valueTickCount, this.minValueStep());
    const maxValue = Math.max(1, valueTicks[valueTicks.length - 1] ?? rawMax);

    // Grid lines first, so data sits above them.
    this.drawGrid(ctx, padLeft, padTop, plotWidth, plotHeight);
    this.drawValueAxis(ctx, padLeft, padTop, plotWidth, plotHeight, valueTicks, maxValue);

    // Bars.
    const barTop = padTop;
    const barHeight = plotHeight;
    // A panning axis puts bins outside the plot, so the bars are clipped to it.
    // Without this a bin that has slid off the left edge would be drawn over the
    // value axis and its labels.
    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, barTop, plotWidth, barHeight);
    ctx.clip();
    for (const bin of this.bins) {
      const rawStart = padLeft + this.axis.positionOf(bin.start) * plotWidth;
      const rawEnd = padLeft + this.axis.positionOf(bin.end) * plotWidth;
      const rawWidth = Math.max(1, rawEnd - rawStart);

      // Inset each bar so neighbouring bars are separated. The gap is a share of
      // the bar's own width, so a narrow bucket keeps the same visual rhythm as a
      // wide one, and it is capped so a wide bar does not lose most of its area.
      const gap = Math.min(BAR_GAP_MAX_PX, Math.max(BAR_GAP_MIN_PX, rawWidth * BAR_GAP_RATIO));
      const inset = Math.min(gap / 2, Math.max(0, (rawWidth - 1) / 2));
      const xStart = rawStart + inset;
      const w = Math.max(1, rawWidth - inset * 2);

      if (bin.missing) {
        // A visible gap, never a zero-height bar pretending to be zero usage.
        ctx.fillStyle = COLORS.missing;
        ctx.fillRect(xStart, barTop + barHeight - 2, w, 2);
        continue;
      }

      const growth = this.growths.get(bin.start);
      const frame = growth ? barGrowthFrame(growth, now) : null;
      const shown = frame ? frame.shown : bin.value;
      const base = frame && !frame.solid ? frame.base : shown;

      if (this.options.metric === 'spend') {
        const h = Math.max(1, (shown / maxValue) * barHeight);
        if (frame && !frame.solid) {
          const baseH = (base / maxValue) * barHeight;
          if (baseH > 0) {
            ctx.fillStyle = COLORS.spend;
            ctx.fillRect(xStart, barTop + barHeight - baseH, w, baseH);
          }
          ctx.fillStyle = COLORS.growth;
          const growthH = h - baseH;
          const overlayH = growthH > 0 ? Math.max(GROWTH_MIN_VISIBLE_PX, growthH) : 0;
          if (overlayH > 0) {
            const overlayTop = barTop + barHeight - baseH - overlayH;
            ctx.fillRect(xStart, overlayTop, w, overlayH);
          }
        } else {
          ctx.fillStyle = COLORS.spend;
          ctx.fillRect(xStart, barTop + barHeight - h, w, h);
        }
      } else {
        const total = bin.input + bin.output;
        const totalH = Math.max(1, (shown / maxValue) * barHeight);
        const inputH = total > 0 ? (bin.input / total) * totalH : 0;
        const outputH = totalH - inputH;
        ctx.fillStyle = COLORS.input;
        ctx.fillRect(xStart, barTop + barHeight - inputH, w, inputH);
        ctx.fillStyle = COLORS.output;
        ctx.fillRect(xStart, barTop + barHeight - inputH - outputH, w, outputH);
        if (frame && !frame.solid) {
          const baseH = (base / maxValue) * barHeight;
          const growthH = totalH - baseH;
          const overlayH = growthH > 0 ? Math.max(GROWTH_MIN_VISIBLE_PX, growthH) : 0;
          if (overlayH > 0) {
            const overlayTop = barTop + barHeight - baseH - overlayH;
            ctx.fillStyle = COLORS.growth;
            ctx.fillRect(xStart, overlayTop, w, overlayH);
          }
        }
      }
    }
    ctx.restore();

    // Crosshair.
    if (this.hoverIndex >= 0 && this.hoverIndex < this.bins.length) {
      const bin = this.bins[this.hoverIndex]!;
      const cx = padLeft + this.axis.positionOf((bin.start + bin.end) / 2) * plotWidth;
      ctx.strokeStyle = COLORS.crosshair;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, padTop);
      ctx.lineTo(Math.round(cx) + 0.5, padTop + plotHeight);
      ctx.stroke();
    }

    // Baseline.
    ctx.strokeStyle = COLORS.gridMajor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop + plotHeight + 0.5);
    ctx.lineTo(padLeft + plotWidth, padTop + plotHeight + 0.5);
    ctx.stroke();

    // Axis labels.
    this.drawLabels(ctx, padLeft, padTop + plotHeight + 2, plotWidth);
  }



  /**
   * Horizontal grid lines and their value labels.
   *
   * The value axis is always linear: a log value axis would make a bar's height
   * meaningless to read.
   */
  private drawValueAxis(
    ctx: CanvasRenderingContext2D,
    padLeft: number,
    padTop: number,
    plotWidth: number,
    plotHeight: number,
    ticks: ReadonlyArray<number>,
    maxValue: number,
  ): void {
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';

    for (const value of ticks) {
      const y = padTop + plotHeight - (value / maxValue) * plotHeight;
      ctx.strokeStyle = value === 0 ? COLORS.gridMajor : COLORS.gridMinor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, Math.round(y) + 0.5);
      ctx.lineTo(padLeft + plotWidth, Math.round(y) + 0.5);
      ctx.stroke();

      ctx.fillStyle = COLORS.label;
      ctx.fillText(this.formatValue(value), padLeft - 6, y);
    }
  }

  /**
   * Gutter width for the value labels, measured from the labels themselves.
   *
   * The tick values depend on the plot height, which depends on the gutter, so
   * this estimates the tick count from the available height rather than
   * iterating: the estimate only affects how wide the gutter is, and a tick
   * count that lands one off still fits because the measurement uses the
   * longest label the axis formats at that height.
   */
  private padLeftForHeight(availableHeight: number): number {
    const tickCount = Math.min(4, Math.max(1, Math.floor(Math.max(1, availableHeight) / VALUE_TICK_MIN_GAP)));
    const maxValue = this.data
      ? Math.max(
          0,
          ...this.data.bins.map((bin) =>
            this.options.metric === 'spend'
              ? (bin.spend_micro ?? 0)
              : (bin.input_tokens ?? 0) + (bin.output_tokens ?? 0),
          ),
        )
      : 0;
    const ticks = generateValueTicks(maxValue, tickCount, this.minValueStep());
    // The measurement must use the same font the labels are drawn with.
    this.ctx.font = '9px -apple-system, system-ui, sans-serif';
    let widest = 0;
    for (const value of ticks) {
      const width = this.ctx.measureText(this.formatValue(value)).width;
      if (width > widest) widest = width;
    }
    // 6px between the label and the plot, plus a pixel of rounding slack.
    return Math.ceil(Math.max(VALUE_AXIS_MIN_PAD_LEFT, widest + 7));
  }

  /**
   * Label for a value-axis tick, in the chart's own units.
   *
   * The axis uses the tighter digit budget so a label never outgrows the left
   * gutter: four significant digits, no finer than $0.001, K/M above thousands.
   */
  private formatValue(value: number): string {
    // Values are micro-dollars for spend and raw counts for tokens.
    return formatAxisValue(this.options.metric, value);
  }

  /**
   * Smallest step the value axis may take.
   *
   * A spend axis never resolves below $0.001, so a plot of fractions of a cent
   * does not sprout a fourth decimal place. The bars still scale to the true
   * maximum; only the labelled grid is floored.
   */
  private minValueStep(): number {
    return this.options.metric === 'spend' ? 1000 : 1;
  }

  private drawGrid(
    ctx: CanvasRenderingContext2D,
    padLeft: number,
    padTop: number,
    plotWidth: number,
    plotHeight: number,
  ): void {
    if (!this.axis) return;
    const ticks = generateTicks(this.axis, {
      width: plotWidth,
      minLabelSpacing: 48,
      calendarNatural: this.data?.scale === '24h',
      nowLabel: 'now',
    });

    const majorX: number[] = [];
    const minorX: number[] = [];
    for (const tick of ticks) {
      const x = padLeft + tick.position * plotWidth;
      if (tick.major) majorX.push(x);
      else minorX.push(x);
    }

    const drawTickSet = (positions: number[], color: string) => {
      if (positions.length === 0) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const x of positions) {
        // Keep sub-pixel x so every line pans continuously with the bars.
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + plotHeight);
      }
      ctx.stroke();
    };

    drawTickSet(minorX, COLORS.gridMinor);
    drawTickSet(majorX, COLORS.gridMajor);
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    padLeft: number,
    y: number,
    plotWidth: number,
  ): void {
    if (!this.axis) return;
    const ticks = generateTicks(this.axis, {
      width: plotWidth,
      minLabelSpacing: 48,
      calendarNatural: this.data?.scale === '24h',
      nowLabel: 'now',
    });

    ctx.fillStyle = COLORS.label;
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';

    for (const tick of ticks) {
      if (!tick.label) continue;
      const x = padLeft + tick.position * plotWidth;
      ctx.textAlign = tick.position > 0.92 ? 'right' : tick.position < 0.08 ? 'left' : 'center';
      ctx.fillText(tick.label, x, y);
    }
  }

  private pointerToIndex(event: PointerEvent): number {
    if (!this.axis) return -1;
    const rect = this.canvas.getBoundingClientRect();
    // Plot-relative, not canvas-relative: the value gutter on the left is not
    // part of the plot, and counting it shifts every hit.
    const x = event.clientX - rect.left - this.plotLeft;
    return hitTest(this.axis, this.bins, x, Math.max(1, this.plotWidth), 8);
  }

  private onPointerMove(event: PointerEvent): void {
    this.pointer = { x: event.clientX, y: event.clientY };
    const index = this.pointerToIndex(event);
    if (index === this.hoverIndex) {
      this.positionTooltip(this.pointer);
      return;
    }
    this.hoverIndex = index;
    this.scheduleRender();
    this.updateTooltip();
    this.positionTooltip(this.pointer);
  }

  /**
   * Re-read the bin under a motionless pointer.
   *
   * A live chart slides beneath the pointer, so the bucket being pointed at
   * changes without the pointer moving. Refreshing only on `pointermove` left the
   * tooltip naming whichever bucket happened to be under the pointer when it last
   * moved, while the crosshair followed the pan — the tooltip would still say
   * "5m ago" after the window had carried that bucket past the left edge.
   */
  private refreshHover(): void {
    if (!this.pointer || !this.axis) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = this.pointer.x - rect.left - this.plotLeft;
    const index = hitTest(this.axis, this.bins, x, Math.max(1, this.plotWidth), 8);
    if (index === this.hoverIndex) return;
    this.hoverIndex = index;
    this.updateTooltip();
    this.positionTooltip(this.pointer);
  }

  /**
   * Keep hovered values current while the axis moves under a still pointer.
   */
  private refreshTooltipWhilePanning(): void {
    if (!this.pointer || !this.options.live || this.hoverIndex < 0) return;
    this.updateTooltip();
    this.positionTooltip(this.pointer);
  }

  private onPointerLeave(): void {
    this.pointer = null;
    this.hoverIndex = -1;
    this.tooltip.hidden = true;
    this.scheduleRender();
  }

  private onClick(event: PointerEvent): void {
    const index = this.pointerToIndex(event);
    if (index >= 0) this.options.onBinClick?.(index);
  }

  private positionTooltip(at: { x: number; y: number }): void {
    if (this.tooltip.hidden) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = at.x - rect.left;
    const y = at.y - rect.top;
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    const left = Math.min(Math.max(2, x + 10), rect.width - tw - 2);
    const top = Math.max(2, y - th - 8);
    this.tooltip.style.left = `${left}px`;
    this.tooltip.style.top = `${top}px`;
  }

  private updateTooltip(): void {
    if (this.hoverIndex < 0 || !this.data) {
      this.tooltip.hidden = true;
      return;
    }
    const bin = this.bins[this.hoverIndex];
    const raw = this.data.bins[this.hoverIndex];
    if (!bin || !raw) {
      this.tooltip.hidden = true;
      return;
    }

    const age = this.axis ? this.axis.tEnd - (bin.start + bin.end) / 2 : 0;
    const title = `${formatAge(age)} ago`;
    const rows: string[] = [];

    if (bin.missing) {
      rows.push('<div class="tt-row"><span>No data</span><span>\u2013</span></div>');
    } else if (this.options.metric === 'spend') {
      rows.push(
        `<div class="tt-row"><span>Spend</span><span>${formatSpend(raw.spend_micro)}</span></div>`,
      );
    } else {
      rows.push(
        `<div class="tt-row"><span>Input</span><span>${formatTokensCompact(raw.input_tokens)}</span></div>`,
        `<div class="tt-row"><span>Output</span><span>${formatTokensCompact(raw.output_tokens)}</span></div>`,
      );
    }

    if (bin.partial) {
      rows.push('<div class="tt-row"><span>Partial</span><span>in progress</span></div>');
    }

    const start = new Date(bin.start);
    const end = new Date(bin.end);
    rows.push(
      `<div class="tt-row"><span>${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</span><span>${end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}</span></div>`,
    );

    this.tooltip.innerHTML = `<div class="tt-title">${title}</div>${rows.join('')}`;
    this.tooltip.hidden = false;
  }
}
