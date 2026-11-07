type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('on') && typeof value === 'string') {
      // Handlers are attached separately; never eval strings.
      continue;
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function icon(path: string, viewBox = '0 0 16 16'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

export const ICONS = {
  spending: 'M2 12h2V6H2v6zm4 0h2V3H6v9zm4 0h2V8h-2v4zm4 0h2V2h-2v10z',
  requests: 'M2 3h12v1.5H2V3zm0 4h12v1.5H2V7zm0 4h8v1.5H2V11z',
  models: 'M8 1.5 14 5v6l-6 3.5L2 11V5l6-3.5zm0 1.7L3.5 5.6 8 7.9l4.5-2.3L8 3.2zM3.5 7.1v3.4L7.3 12V8.7L3.5 7.1zm9 0L8.7 8.7V12l3.8-1.5V7.1z',
  log: 'M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1 3v1.4h8V5H4zm0 3v1.4h8V8H4zm0 3v1.4h5V11H4z',
  // A key, not a padlock: this tab lists API keys, and the padlock was the
  // only tab icon that described access control rather than the tab's contents.
  // The bow is drawn as two opposing circles, so the nonzero fill rule leaves a
  // hole; the shaft and its two teeth hang off the bow to the right.
  api: 'M4.5 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM4.5 6.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM7.9 7.2H15V8.8H13.8V10.6H12.2V8.8H11.1V11.4H9.5V8.8H7.9Z',
  settings:
    'M6.39 3.05 6.78 1.11h2.44l.39 1.94a5.2 5.2 0 0 1 .75.32l1.66-1.1 1.71 1.71-1.1 1.66a5.2 5.2 0 0 1 .32.75l1.94.39v2.44l-1.94.39a5.2 5.2 0 0 1-.32.75l1.1 1.66-1.71 1.71-1.66-1.1a5.2 5.2 0 0 1-.75.32l-.39 1.94H6.78l-.39-1.94a5.2 5.2 0 0 1-.75-.32l-1.66 1.1-1.71-1.71 1.1-1.66a5.2 5.2 0 0 1-.32-.75l-1.94-.39V6.78l1.94-.39a5.2 5.2 0 0 1 .32-.75l-1.1-1.66 1.71-1.71 1.66 1.1a5.2 5.2 0 0 1 .75-.32ZM8 5.7a2.3 2.3 0 1 0 0 4.6 2.3 2.3 0 0 0 0-4.6Z',
  chevron: 'M6 3.5 10.5 8 6 12.5 4.9 11.4 8.3 8 4.9 4.6z',
  back: 'M9.5 3.5 5 8l4.5 4.5 1.1-1.1L7.2 8l3.4-3.4z',
  prev: 'M10 3.5 5.5 8 10 12.5 11.1 11.4 7.7 8l3.4-3.4z',
  next: 'M6 3.5 10.5 8 6 12.5 4.9 11.4 8.3 8 4.9 4.6z',
};

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: number | undefined;
  return ((...args: never[]) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  }) as T;
}
