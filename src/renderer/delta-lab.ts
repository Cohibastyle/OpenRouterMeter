type Direction = 'up' | 'down';

interface EventReason {
  label: string;
  delta: number;
  direction: Direction;
  requests: number;
  reason: string;
}

interface Variant {
  id: string;
  name: string;
  subtitle: string;
  easing: (t: number) => number;
  durationMs: number;
}

interface CardUi {
  value: HTMLElement;
  chipSlot: HTMLElement;
  reason: HTMLElement;
  log: HTMLUListElement;
}

interface CardState {
  variant: Variant;
  value: number;
  activeAnimation: number;
  pendingRollTimer: number | null;
}

const ROLL_START_DELAY_MS = 200;
const CHIP_HOLD_MS = 3000;
const CHIP_FADE_MS = 5000;
const CHIP_LIFETIME_MS = CHIP_HOLD_MS + CHIP_FADE_MS;

const EVENTS: EventReason[] = [
  { label: 'New usage burst', delta: 0.216, direction: 'up', requests: 3, reason: 'usage' },
  { label: 'Single expensive call', delta: 1.12, direction: 'up', requests: 1, reason: 'usage' },
  { label: 'Late bucket arrived', delta: 0.074, direction: 'up', requests: 2, reason: 'late bucket' },
  { label: 'Interval recalculation', delta: 0.191, direction: 'down', requests: 0, reason: 'recalc' },
  { label: 'Backfilled correction', delta: 0.043, direction: 'down', requests: 0, reason: 'correction' },
];

const VARIANTS: Variant[] = [
  {
    id: 'linear',
    name: 'Version A — Linear roll',
    subtitle: 'Constant speed, no overshoot.',
    easing: (t) => t,
    durationMs: 3000,
  },
  {
    id: 'ease-out',
    name: 'Version B — Ease-out roll',
    subtitle: 'Fast start, gentle settle, no overshoot.',
    easing: (t) => 1 - Math.pow(1 - t, 3),
    durationMs: 3000,
  },
  {
    id: 'ease-in-out',
    name: 'Version C — Ease-in-out roll',
    subtitle: 'Balanced acceleration/deceleration, no overshoot.',
    easing: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
    durationMs: 3000,
  },
];

const cards = new Map<string, { ui: CardUi; state: CardState }>();
const autoplayBtn = document.getElementById('btn-autoplay') as HTMLButtonElement;
let eventIndex = 0;
let autoplayTimer: number | null = null;

function requireEvent(eventReason: EventReason | undefined): EventReason {
  if (eventReason) return eventReason;
  throw new Error('Animation lab has no events configured.');
}

function money(value: number): string {
  return `$${value.toFixed(3)}`;
}

function buildCard(variant: Variant): HTMLElement {
  const card = document.createElement('article');
  card.className = 'card';

  const heading = document.createElement('h2');
  heading.textContent = variant.name;
  card.appendChild(heading);

  const sub = document.createElement('p');
  sub.className = 'subtitle';
  sub.textContent = variant.subtitle;
  card.appendChild(sub);

  const mainLine = document.createElement('div');
  mainLine.className = 'main-line';
  card.appendChild(mainLine);

  const value = document.createElement('div');
  value.className = 'main-value';
  value.textContent = money(4.835);
  mainLine.appendChild(value);

  const chipSlot = document.createElement('div');
  chipSlot.className = 'chip-slot';
  mainLine.appendChild(chipSlot);

  const reason = document.createElement('div');
  reason.className = 'reason';
  reason.textContent = 'Waiting for event…';
  card.appendChild(reason);

  const log = document.createElement('ul');
  log.className = 'event-log';
  card.appendChild(log);

  cards.set(variant.id, {
    ui: { value, chipSlot, reason, log },
    state: { variant, value: 4.835, activeAnimation: 0, pendingRollTimer: null },
  });

  return card;
}

function pushLog(log: HTMLUListElement, line: string): void {
  const item = document.createElement('li');
  item.textContent = line;
  log.prepend(item);
  while (log.children.length > 5) {
    log.removeChild(log.lastElementChild as Element);
  }
}

function rollValue(ui: CardUi, state: CardState, to: number): void {
  const from = state.value;
  const start = performance.now();
  state.activeAnimation += 1;
  const marker = state.activeAnimation;

  const step = (now: number) => {
    if (state.activeAnimation !== marker) return;
    const elapsed = now - start;
    const t = Math.min(1, elapsed / state.variant.durationMs);
    const eased = state.variant.easing(t);
    const next = from + (to - from) * eased;
    ui.value.textContent = money(next);
    if (t < 1) {
      requestAnimationFrame(step);
      return;
    }
    state.value = to;
    ui.value.textContent = money(to);
  };

  requestAnimationFrame(step);
}

function renderChip(ui: CardUi, eventReason: EventReason): void {
  ui.chipSlot.textContent = '';

  const chip = document.createElement('div');
  chip.className = `chip ${eventReason.direction === 'down' ? 'down' : ''}`;

  const arrow = eventReason.direction === 'up' ? '↑' : '↓';
  const sign = eventReason.direction === 'up' ? '+' : '-';
  const amount = `${sign}${money(eventReason.delta)}`;
  const value = document.createElement('span');
  value.className = 'value';
  value.textContent = `${arrow} ${amount}`;
  chip.appendChild(value);

  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent =
    eventReason.direction === 'up'
      ? `${eventReason.requests} req`
      : 'Recalc';
  chip.appendChild(meta);

  ui.chipSlot.appendChild(chip);
  chip.style.animationDelay = `${CHIP_HOLD_MS}ms`;
  chip.style.animationDuration = `${CHIP_FADE_MS}ms`;

  window.setTimeout(() => {
    if (chip.parentElement) chip.remove();
  }, CHIP_LIFETIME_MS);
}

function applyEvent(eventReason: EventReason): void {
  for (const { ui, state } of cards.values()) {
    const signed = eventReason.direction === 'up' ? eventReason.delta : -eventReason.delta;
    const target = Math.max(0, state.value + signed);
    // Stop any in-flight roll now, so the chip is always seen first.
    state.activeAnimation += 1;
    if (state.pendingRollTimer !== null) {
      window.clearTimeout(state.pendingRollTimer);
      state.pendingRollTimer = null;
    }
    renderChip(ui, eventReason);
    state.pendingRollTimer = window.setTimeout(() => {
      state.pendingRollTimer = null;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          rollValue(ui, state, target);
        });
      });
    }, ROLL_START_DELAY_MS);
    ui.reason.textContent = `${eventReason.label} · ${eventReason.reason}`;
    pushLog(ui.log, `${eventReason.label}: ${eventReason.direction === 'up' ? '+' : '-'}${money(eventReason.delta)}`);
  }
}

function nextEvent(): EventReason {
  const item = requireEvent(EVENTS[eventIndex % EVENTS.length]);
  eventIndex += 1;
  return item;
}

function randomEvent(): EventReason {
  return requireEvent(EVENTS[Math.floor(Math.random() * EVENTS.length)]);
}

function setAutoplay(on: boolean): void {
  if (!on) {
    if (autoplayTimer !== null) {
      window.clearInterval(autoplayTimer);
      autoplayTimer = null;
    }
    autoplayBtn.setAttribute('aria-pressed', 'false');
    autoplayBtn.textContent = 'Autoplay: Off';
    return;
  }
  if (autoplayTimer !== null) return;
  autoplayTimer = window.setInterval(() => applyEvent(nextEvent()), 2600);
  autoplayBtn.setAttribute('aria-pressed', 'true');
  autoplayBtn.textContent = 'Autoplay: On';
}

function init(): void {
  const cardsRoot = document.getElementById('cards');
  if (!cardsRoot) return;

  for (const variant of VARIANTS) cardsRoot.appendChild(buildCard(variant));

  const nextBtn = document.getElementById('btn-next') as HTMLButtonElement | null;
  const randomBtn = document.getElementById('btn-random') as HTMLButtonElement | null;

  nextBtn?.addEventListener('click', () => applyEvent(nextEvent()));
  randomBtn?.addEventListener('click', () => applyEvent(randomEvent()));
  autoplayBtn?.addEventListener('click', () => {
    const enabled = autoplayBtn.getAttribute('aria-pressed') === 'true';
    setAutoplay(!enabled);
  });
}

init();
