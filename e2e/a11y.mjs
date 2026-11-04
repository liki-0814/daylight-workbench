// Heuristic accessibility checks. These are NOT axe-core: report results as "heuristic, not verified with axe".
export function relativeLuminance([r, g, b]) { const f = value => (value /= 255) <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); }
export function contrastRatio(a, b) { const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x); return (high + 0.05) / (low + 0.05); }
export const parseHex = hex => { const text = hex.replace('#', ''); const full = text.length === 3 ? [...text].map(c => c + c).join('') : text; return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16)); };

// Controls that have no accessible name (button, link, switch/checkbox, role=button/switch/tab).
export const unnamedControls = page => page.evaluate(() => {
  const visible = element => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return (box.width > 0 && box.height > 0 || element.type === 'checkbox') && style.visibility !== 'hidden' && !element.closest('[hidden], [inert]'); };
  const name = element => (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') && element.getAttribute('aria-labelledby').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ') || element.labels?.[0]?.textContent || element.textContent || element.getAttribute('title') || '').trim();
  return [...document.querySelectorAll('button, a[href], input[type=checkbox], input[type=radio], [role=button], [role=switch], [role=tab]')].filter(visible).filter(element => !name(element)).map(element => element.outerHTML.slice(0, 120));
});

// Interactive elements smaller than the minimum target (default 24px hard floor; 28px is the design target).
export const smallTargets = (page, { min = 24, selector = 'button, a[href], input[type=checkbox], input[type=radio], [role=button], [role=switch], [role=tab]' } = {}) => page.evaluate(({ min, selector }) => [...document.querySelectorAll(selector)].filter(element => !element.closest('[hidden], [inert]')).map(element => { const box = element.getBoundingClientRect(); const label = element.closest('label')?.getBoundingClientRect(); const width = Math.max(box.width, label?.width || 0), height = Math.max(box.height, label?.height || 0); return { html: element.outerHTML.slice(0, 100), width: Math.round(width), height: Math.round(height) }; }).filter(item => item.width > 0 && (item.width < min || item.height < min)), { min, selector });

// Presses Tab `steps` times and records where focus lands: visible focus indicator and whether focus is lost to <body>.
export async function focusWalk(page, steps = 20) {
  const visited = [];
  await page.evaluate(() => { document.activeElement?.blur?.(); window.scrollTo(0, 0); });
  for (let index = 0; index < steps; index++) {
    await page.keyboard.press('Tab');
    visited.push(await page.evaluate(() => {
      const element = document.activeElement, style = getComputedStyle(element), box = element.getBoundingClientRect();
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2, shadow = style.boxShadow !== 'none' && /\d+px/.test(style.boxShadow);
      return { tag: element.tagName.toLowerCase(), name: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 30), onBody: element === document.body, focusVisible: outline || shadow, inViewport: box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth };
    }));
  }
  return visited;
}

export const horizontalOverflow = page => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth, overflow: document.documentElement.scrollWidth > innerWidth + 1 }));
