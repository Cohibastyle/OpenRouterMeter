/**
 * Rolling-digit animation for the headline values.
 *
 * The headline is rebuilt on every snapshot, so the animation runs from the
 * value that was on screen to the value that replaces it. Each digit is a
 * vertical strip of 0-9 translated to the digit's position, so the number reads
 * as a counter rolling to its new value instead of a value that jumps.
 *
 * Each column makes one pass and stops: a digit travels at most nine steps from
 * its old value to its new one, and a digit that does not change does not move
 * at all. A carry-chain counter would instead drag every column through the
 * whole numeric delta, so `$4.123` to `$6.456` would spin the last column 2333
 * times; here the same change is eleven digit steps.
 *
 * Columns run least significant first. Each one starts a fixed beat after the
 * column to its right, so the carry reads as an odometer cascade, and each digit
 * decelerates into place with no overshoot.
 */

/**
 * Cell height in em; must match `.odo-cell` in app.css.
 *
 * Every character, digit or not, occupies a cell of exactly one line box, so
 * the fixed `$` and `.` line up with the rolling digits.
 */
const CELL_EM = 1;

/**
 * Visible window height in em; must match `.odo` in app.css.
 *
 * The window is shorter than a cell and centred on the glyph's ink, so a digit
 * at rest fills it and a digit mid-roll shows only a thin sliver of its
 * neighbour. A window as tall as the cell would show both halves of two digits
 * at once, which reads as a broken glyph rather than as motion.
 */
const WINDOW_EM = 0.78;

/** Distance from the cell top to the window top, used to centre the ink. */
const WINDOW_OFFSET_EM = (CELL_EM - WINDOW_EM) / 2;

/**
 * Cells in one column's strip.
 *
 * A single pass can end as far as eighteen cells from the start (a column that
 * wraps, such as 8 to 2 in four steps), so the strip holds more than two
 * decades. It only ever translates forward through them.
 */
const STRIP_CELLS = 21;

/**
 * Brisk cascade timing, chosen against four candidate arrival curves.
 *
 * Each digit takes `STEP_MS` to move, and each column starts one `BEAT_MS` after
 * the column to its right. The ratios are fixed rather than fitted to a window
 * because a settle time that swings with the size of the increase makes the
 * counter feel inconsistent between one refresh and the next; a roll that
 * finishes early simply rests on its new value.
 *
 * The arrival curve is `easeOutCubic`, so a digit decelerates into place and
 * stops dead. Overshoot was measured and rejected: an easeOutBack kicks past the
 * target by a fraction of the column's own travel, so a two-digit increase
 * reverses through a whole digit while a one-cent increase moves imperceptibly,
 * and a number that travels backwards reads as a counting error.
 */
const STEP_MS = 105;
const BEAT_MS = 170;

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Whether the user has allowed motion. Reduced and off are both treated as off:
 * a counter that slides while everything else is still is the worse outcome.
 */
export function motionAllowed(): boolean {
  const mode = document.documentElement.dataset.animations;
  return mode !== 'off' && mode !== 'reduced';
}

/** One column's part in a roll. */
export interface ColumnRoll {
  /** Character index in the formatted text, left to right. */
  index: number;
  /** Digit the column starts on. */
  from: number;
  /** Digit it finishes on. */
  to: number;
  /** Digits travelled, 0-9: a single pass, never a lap. */
  steps: number;
  /** Time from the start of the roll at which the column begins moving. */
  startMs: number;
  /** Time the column takes to travel one digit. */
  stepMs: number;
}

/** A whole roll, resolved against the window it has to fit in. */
export interface RollPlan {
  /** Rolling columns only, least significant first. */
  columns: ColumnRoll[];
  /** Time the roll takes; never longer than the window it was given. */
  durationMs: number;
  /** Digits travelled by all columns together. */
  totalSteps: number;
}

/**
 * Compare two formatted values digit by digit.
 *
 * Both strings are the same length here, so comparing their digits as text is
 * exact at any magnitude, where reading them as one integer would lose digits
 * once the value passes what a double can hold.
 */
function compareDigits(fromText: string, toText: string): number {
  for (let i = 0; i < toText.length; i += 1) {
    if (!isDigit(toText[i]!)) continue;
    const delta = Number(toText[i]) - Number(fromText[i]);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * Plan a single-pass roll from one formatted value to another.
 *
 * Every column travels the shortest forward distance from its old digit to its
 * new one, so at most nine digits, and a column whose digit does not change is
 * left out entirely. Columns are returned least significant first, in the order
 * the cascade plays.
 *
 * `windowMs` is a ceiling rather than a target: the cascade runs at its natural
 * pace and is only compressed if it would overrun the window.
 *
 * Returns null when the strings do not share a shape (a digit that appears or
 * disappears cannot roll in place), when the value does not rise, or when there
 * is nothing to animate.
 */
export function planRoll(fromText: string, toText: string, windowMs: number): RollPlan | null {
  if (!(windowMs > 0) || fromText === toText) return null;
  if (fromText.length !== toText.length) return null;
  for (let i = 0; i < toText.length; i += 1) {
    if (isDigit(fromText[i]!) !== isDigit(toText[i]!)) return null;
  }

  // A roll only runs forwards. A fall is repainted instead, because counting
  // down through the old value would read as a second, separate event.
  if (compareDigits(fromText, toText) <= 0) return null;

  const rolling: Array<Omit<ColumnRoll, 'startMs' | 'stepMs'>> = [];
  for (let i = toText.length - 1; i >= 0; i -= 1) {
    const char = toText[i]!;
    if (!isDigit(char)) continue;
    const from = Number(fromText[i]!);
    const to = Number(char);
    const steps = (to - from + 10) % 10;
    if (steps === 0) continue;
    rolling.push({ index: i, from, to, steps });
  }
  if (rolling.length === 0) return null;

  // Each column starts one beat after the one to its right, so the carry
  // cascades right to left rather than every digit moving at once. The window is
  // a ceiling, not a target: the natural cascade is used unless it would overrun,
  // in which case the whole thing is compressed uniformly so the beats and the
  // travel stay in proportion.
  const natural = rolling.map((column, i) => ({
    ...column,
    startMs: i * BEAT_MS,
    stepMs: STEP_MS,
  }));
  const naturalMs = Math.max(
    ...natural.map((column) => column.startMs + column.steps * column.stepMs),
  );
  const fit = Math.min(1, windowMs / naturalMs);
  const columns = natural.map((column) => ({
    ...column,
    startMs: column.startMs * fit,
    stepMs: column.stepMs * fit,
  }));
  const totalSteps = rolling.reduce((sum, column) => sum + column.steps, 0);
  return { columns, durationMs: naturalMs * fit, totalSteps };
}

/** The transform that parks a strip on `position`, which may be fractional. */
function translateFor(position: number): string {
  const offset = position * CELL_EM + WINDOW_OFFSET_EM;
  return `translateY(${(-offset).toFixed(4)}em)`;
}

/** A built digit column, parked and ready to roll. */
interface Column {
  strip: HTMLElement;
  /** Character index in the formatted text, left to right. */
  index: number;
  /** Digit the column rests on before the roll. */
  from: number;
}

/**
 * Build one column per character, each strip parked on its starting digit.
 *
 * Returns null when the two strings do not share a shape, because a digit that
 * appears or disappears cannot roll in place.
 */
function buildColumns(
  fromText: string,
  toText: string,
): { fragment: DocumentFragment; columns: Column[] } | null {
  if (fromText.length !== toText.length) return null;
  for (let i = 0; i < toText.length; i += 1) {
    if (isDigit(fromText[i]!) !== isDigit(toText[i]!)) return null;
  }

  const fragment = document.createDocumentFragment();
  const columns: Column[] = [];
  for (let i = 0; i < toText.length; i += 1) {
    const char = toText[i]!;
    if (!isDigit(char)) {
      const fixed = document.createElement('span');
      fixed.className = 'odo-fixed';
      fixed.textContent = char;
      fragment.appendChild(fixed);
      continue;
    }
    const column = document.createElement('span');
    column.className = 'odo';
    const strip = document.createElement('span');
    strip.className = 'odo-strip';
    // The strip is more than two decades deep, so a column can travel a single
    // pass of up to nine digits forwards without running out of cells.
    for (let cell = 0; cell < STRIP_CELLS; cell += 1) {
      const digit = document.createElement('span');
      digit.className = 'odo-cell';
      digit.textContent = String(cell % 10);
      strip.appendChild(digit);
    }
    const from = Number(fromText[i]!);
    strip.style.transform = translateFor(from);
    column.appendChild(strip);
    fragment.appendChild(column);
    columns.push({ strip, index: i, from });
  }
  return { fragment, columns };
}

/**
 * Roll `element` from `from` to `to` over `windowMs`.
 *
 * The element is left holding the exact formatted target text once the roll
 * finishes, so a value that gained or lost a digit settles cleanly. A value that
 * falls is painted directly: a backwards roll would read as a second event
 * rather than as the same number decreasing.
 */
export function animateHeadline(
  element: HTMLElement,
  from: number,
  to: number,
  format: (value: number) => string,
  windowMs: number,
  onDone?: () => void,
): void {
  const fromText = format(from);
  const toText = format(to);
  element.setAttribute('aria-label', toText);

  if (fromText === toText || !motionAllowed() || windowMs <= 0) {
    element.textContent = toText;
    onDone?.();
    return;
  }

  // A fall is repainted, not rolled: counting down through the old value reads
  // as a second event, and a backwards roll has no forward pass to make.
  if (compareDigits(fromText, toText) < 0) {
    element.textContent = toText;
    onDone?.();
    return;
  }

  const plan = planRoll(fromText, toText, windowMs);
  const built = plan ? buildColumns(fromText, toText) : null;
  if (!plan || !built) {
    countUp(element, from, to, format, windowMs, onDone);
    return;
  }

  element.replaceChildren(built.fragment);

  const byIndex = new Map<number, ColumnRoll>();
  for (const column of plan.columns) byIndex.set(column.index, column);

  const start = performance.now();

  const frame = (now: number) => {
    const elapsed = now - start;
    for (const column of built.columns) {
      const roll = byIndex.get(column.index);
      if (!roll) continue;
      const progress = Math.min(
        1,
        Math.max(0, elapsed - roll.startMs) / (roll.steps * roll.stepMs),
      );
      column.strip.style.transform = translateFor(roll.from + roll.steps * easeOutCubic(progress));
    }
    if (elapsed < plan.durationMs) requestAnimationFrame(frame);
    else {
      element.textContent = toText;
      onDone?.();
    }
  };
  requestAnimationFrame(frame);
}

/** Fallback for values whose digit count changes, where columns cannot roll. */
function countUp(
  element: HTMLElement,
  from: number,
  to: number,
  format: (value: number) => string,
  durationMs: number,
  onDone?: () => void,
): void {
  const start = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    element.textContent = format(from + (to - from) * easeOutCubic(t));
    if (t < 1) requestAnimationFrame(frame);
    else {
      element.textContent = format(to);
      onDone?.();
    }
  };
  requestAnimationFrame(frame);
}

/**
 * The text a rolling headline is currently showing.
 *
 * `textContent` is wrong for a built column headline: it is the concatenation of
 * every digit in every strip, so a four-digit number reads as eighty-odd
 * characters and the fit shrinks the headline to its floor. The visible glyphs
 * are the fixed characters plus one digit per column, read from the strip's
 * current transform.
 */
function visibleText(element: HTMLElement): string {
  const nodes = Array.from(element.childNodes);
  // A headline that has never been animated has no columns at all.
  if (!nodes.some((node) => node instanceof HTMLElement && node.classList.contains('odo'))) {
    return element.textContent ?? '';
  }

  let text = '';
  for (const node of nodes) {
    if (!(node instanceof HTMLElement) || node.classList.contains('odo-fixed')) {
      text += node.textContent ?? '';
      continue;
    }
    const strip = node.querySelector<HTMLElement>('.odo-strip');
    if (!strip) {
      text += node.textContent ?? '';
      continue;
    }
    // The parked position is a whole digit; a mid-roll column is fractional but
    // still contributes exactly one character, so it is rounded to the nearest.
    const match = /translateY\(([-\d.]+)em\)/.exec(strip.style.transform);
    const position = match ? Math.round(-Number(match[1]) - WINDOW_OFFSET_EM) : 0;
    text += strip.children[position]?.textContent ?? '0';
  }
  return text;
}

/**
 * Grow a headline until it fills its box, or shrink it until it fits.
 *
 * In a small window the number is the whole point of the view, so a fixed font
 * step either wastes the space or clips. The size is found by measuring the
 * rendered text against the box and scaling by the ratio, which converges in
 * one step because text width is linear in font size.
 *
 * The text is measured on a detached clone rather than on the element itself:
 * the element clips its overflow, so its own `scrollWidth` reports the clipped
 * box instead of the width the text actually wants.
 *
 * The result is clamped to a floor and a ceiling: below the floor the number
 * stops being legible, and above the ceiling it stops looking like a readout.
 *
 * `reserveHeight` is space inside the box that the number must leave for
 * something else, such as an increase chip stacked under it.
 */
export function fitHeadline(
  element: HTMLElement,
  box: HTMLElement,
  options: { min: number; max: number; fill: number; reserveHeight?: number },
): void {
  const { min, max, fill, reserveHeight = 0 } = options;
  const availableWidth = box.clientWidth;
  const availableHeight = Math.max(0, box.clientHeight - reserveHeight);
  if (availableWidth <= 0) return;

  const probe = document.createElement('span');
  probe.textContent = visibleText(element);
  probe.style.cssText = [
    'position:absolute',
    'left:-9999px',
    'top:0',
    'visibility:hidden',
    'white-space:nowrap',
    'font-variant-numeric:tabular-nums',
    'letter-spacing:-0.02em',
    'font-weight:650',
    'line-height:1.05',
    `font-size:${max}px`,
  ].join(';');
  document.body.appendChild(probe);
  const textWidth = probe.getBoundingClientRect().width;
  const textHeight = probe.getBoundingClientRect().height;
  probe.remove();
  if (textWidth <= 0) return;

  const byWidth = (availableWidth * fill) / textWidth;
  const byHeight = availableHeight > 0 ? (availableHeight * fill) / textHeight : byWidth;
  const size = Math.max(min, Math.min(max, max * Math.min(byWidth, byHeight)));
  element.style.fontSize = `${size.toFixed(2)}px`;
}
