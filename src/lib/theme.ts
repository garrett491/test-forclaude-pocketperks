/**
 * Theme.
 *
 * The whole site already runs on CSS custom properties, so changing the look
 * means writing values rather than fighting hardcoded styles. This module is
 * the single source of truth for what can be changed and what the defaults
 * are — the admin Design page and the public site both read it, so they
 * cannot disagree about what a token means.
 *
 * Colours are a fixed swatch set, not a free colour picker. An unrestricted
 * picker eventually produces pale green text on white at 2.4:1, which is
 * unreadable in a car park in July — and that is where a lot of this site
 * gets used. Every swatch below is either a brand colour, a shade of one, or
 * a neutral, and the Design page shows the live contrast for each pairing.
 */

export interface Swatch {
  id: string;
  label: string;
  value: string;
  group: 'brand' | 'white' | 'grey' | 'black' | 'beige' | 'special';
}

export const SWATCHES: Swatch[] = [
  { id: 'transparent', label: 'Clear', value: 'transparent', group: 'special' },

  // Sampled from the logo, plus four shades derived from those.
  { id: 'green-900', label: 'Pocket green', value: '#093814', group: 'brand' },
  { id: 'green-800', label: 'Deep green',   value: '#0C4A1A', group: 'brand' },
  { id: 'green-700', label: 'Wordmark green', value: '#12611B', group: 'brand' },
  { id: 'green-500', label: 'Perk lime',    value: '#56A837', group: 'brand' },
  { id: 'green-300', label: 'Light lime',   value: '#A8DE8F', group: 'brand' },

  { id: 'white-100', label: 'Pure white',   value: '#FFFFFF', group: 'white' },
  { id: 'white-200', label: 'Soft white',   value: '#FCFCFB', group: 'white' },
  { id: 'white-300', label: 'Paper',        value: '#F7F6F2', group: 'white' },
  { id: 'white-400', label: 'Warm white',   value: '#F2F1EB', group: 'white' },
  { id: 'white-500', label: 'Dim white',    value: '#EAE9E3', group: 'white' },

  { id: 'grey-200', label: 'Light grey',    value: '#D8D9D4', group: 'grey' },
  { id: 'grey-400', label: 'Grey',          value: '#A8ABA4', group: 'grey' },
  { id: 'grey-500', label: 'Mid grey',      value: '#7C8079', group: 'grey' },
  { id: 'grey-600', label: 'Slate grey',    value: '#5A6B5C', group: 'grey' },
  { id: 'grey-700', label: 'Dark grey',     value: '#4E5D50', group: 'grey' },

  { id: 'black-400', label: 'Soft black',   value: '#2B2F2C', group: 'black' },
  { id: 'black-500', label: 'Charcoal',     value: '#1E211E', group: 'black' },
  { id: 'black-600', label: 'Ink navy',     value: '#060E22', group: 'black' },
  { id: 'black-700', label: 'Near black',   value: '#101310', group: 'black' },
  { id: 'black-900', label: 'Black',        value: '#000000', group: 'black' },

  { id: 'beige-100', label: 'Pale beige',   value: '#F6F1E7', group: 'beige' },
  { id: 'beige-200', label: 'Beige',        value: '#EFE7D7', group: 'beige' },
  { id: 'beige-300', label: 'Sand',         value: '#E3D7C0', group: 'beige' },
  { id: 'beige-400', label: 'Warm sand',    value: '#D4C4A8', group: 'beige' },
  { id: 'beige-500', label: 'Deep sand',    value: '#B9A684', group: 'beige' },
];

export function swatchValue(id: string | undefined): string | null {
  if (!id) return null;
  return SWATCHES.find((s) => s.id === id)?.value ?? null;
}

/* ------------------------------------------------------------------ */
/* Fonts                                                               */
/* ------------------------------------------------------------------ */

export interface FontChoice {
  id: string;
  label: string;
  family: string;
  stack: string;
  /** Google Fonts family spec, or null for a system stack that loads nothing. */
  google: string | null;
  /** Bundled with the site (see global.css), so no request to Google is made. */
  selfHosted?: boolean;
  role: 'display' | 'body' | 'both';
}

/**
 * Ten families, curated rather than free text. A typo in a font name renders
 * the whole site in Times New Roman with no error and no way to warn you,
 * which is a bad trade for flexibility nobody needs.
 */
export const FONTS: FontChoice[] = [
  { id: 'playfair', label: 'Playfair Display', family: 'Playfair Display',
    stack: "'Playfair Display', 'Iowan Old Style', Georgia, serif",
    google: 'Playfair+Display:wght@700', role: 'display', selfHosted: true },
  { id: 'fraunces', label: 'Fraunces', family: 'Fraunces',
    stack: "'Fraunces', Georgia, serif", google: 'Fraunces:opsz,wght@9..144,700', role: 'display' },
  { id: 'bitter', label: 'Bitter', family: 'Bitter',
    stack: "'Bitter', Georgia, serif", google: 'Bitter:wght@700', role: 'display' },
  { id: 'space-grotesk', label: 'Space Grotesk', family: 'Space Grotesk',
    stack: "'Space Grotesk', 'Helvetica Neue', sans-serif",
    google: 'Space+Grotesk:wght@500;700', role: 'both' },
  { id: 'archivo', label: 'Archivo', family: 'Archivo',
    stack: "'Archivo', 'Helvetica Neue', sans-serif", google: 'Archivo:wght@600;700', role: 'both' },

  { id: 'dm-sans', label: 'DM Sans', family: 'DM Sans',
    stack: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    google: 'DM+Sans:wght@400;600', role: 'body', selfHosted: true },
  { id: 'inter', label: 'Inter', family: 'Inter',
    stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    google: 'Inter:wght@400;600', role: 'body' },
  { id: 'source-sans', label: 'Source Sans 3', family: 'Source Sans 3',
    stack: "'Source Sans 3', -apple-system, 'Segoe UI', sans-serif",
    google: 'Source+Sans+3:wght@400;600', role: 'body' },
  { id: 'work-sans', label: 'Work Sans', family: 'Work Sans',
    stack: "'Work Sans', -apple-system, 'Segoe UI', sans-serif",
    google: 'Work+Sans:wght@400;600', role: 'body' },
  { id: 'system', label: 'System default (fastest)', family: 'System',
    stack: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    google: null, role: 'body' },
];

export function fontById(id: string | undefined): FontChoice | null {
  return FONTS.find((f) => f.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

export interface ThemeTokens {
  page_bg?: string;
  surface_bg?: string;
  text?: string;
  muted?: string;
  heading?: string;
  link?: string;
  button_bg?: string;
  button_text?: string;
  header_bg?: string;
  header_text?: string;
  footer_bg?: string;
  footer_text?: string;
  accent?: string;

  font_display?: string;
  font_body?: string;

  /** Percentage of the base 16px body size, 88–120. */
  text_scale?: number;
  /** Percentage applied to headings on top of text_scale, 85–130. */
  heading_scale?: number;
  /** compact | normal | roomy */
  density?: string;
}

/** What the site looks like with nothing set. Reset writes this back. */
export const DEFAULT_THEME: Required<ThemeTokens> = {
  page_bg: 'white-300',
  surface_bg: 'white-100',
  text: 'black-600',
  muted: 'grey-700',
  heading: 'black-600',
  link: 'green-700',
  button_bg: 'green-500',
  button_text: 'black-600',
  header_bg: 'white-100',
  header_text: 'black-600',
  footer_bg: 'green-900',
  footer_text: 'white-100',
  accent: 'green-500',
  font_display: 'playfair',
  font_body: 'dm-sans',
  text_scale: 100,
  heading_scale: 100,
  density: 'normal',
};

export const COLOR_FIELDS: { key: keyof ThemeTokens; label: string; hint: string; against?: keyof ThemeTokens }[] = [
  { key: 'page_bg',     label: 'Page background', hint: 'Behind everything.' },
  { key: 'surface_bg',  label: 'Card background', hint: 'Deal and business cards.' },
  { key: 'text',        label: 'Body text',       hint: 'Most words on the page.', against: 'surface_bg' },
  { key: 'muted',       label: 'Secondary text',  hint: 'Dates, categories, small print.', against: 'surface_bg' },
  { key: 'heading',     label: 'Headings',        hint: 'Titles and deal headlines.', against: 'surface_bg' },
  { key: 'link',        label: 'Links',           hint: 'Text people can click.', against: 'surface_bg' },
  { key: 'button_bg',   label: 'Button colour',   hint: 'The main action buttons.' },
  { key: 'button_text', label: 'Button text',     hint: 'Words on those buttons.', against: 'button_bg' },
  { key: 'header_bg',   label: 'Header bar',      hint: 'The strip along the top.' },
  { key: 'header_text', label: 'Header text',     hint: 'Navigation links.', against: 'header_bg' },
  { key: 'footer_bg',   label: 'Footer',          hint: 'The block at the bottom.' },
  { key: 'footer_text', label: 'Footer text',     hint: 'Words in the footer.', against: 'footer_bg' },
  { key: 'accent',      label: 'Accent',          hint: 'Badges and the stitched edge.' },
];

/* ------------------------------------------------------------------ */
/* Contrast                                                            */
/* ------------------------------------------------------------------ */

function channel(hex: string): number[] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channel(hex).map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. */
export function contrastRatio(a: string, b: string): number | null {
  if (!a || !b || a === 'transparent' || b === 'transparent') return null;
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return Math.round(((l1! + 0.05) / (l2! + 0.05)) * 100) / 100;
}

export function contrastVerdict(ratio: number | null): { level: string; tone: 'ok' | 'warn' | 'bad'; note: string } | null {
  if (ratio === null) return null;
  if (ratio >= 7) return { level: 'AAA', tone: 'ok', note: `${ratio}:1 — excellent, readable in bright sun.` };
  if (ratio >= 4.5) return { level: 'AA', tone: 'ok', note: `${ratio}:1 — meets the standard for body text.` };
  if (ratio >= 3) return { level: 'Large only', tone: 'warn', note: `${ratio}:1 — fine for big headings, too weak for body text.` };
  return { level: 'Fails', tone: 'bad', note: `${ratio}:1 — hard to read, especially outdoors. Aim for 4.5:1 or higher.` };
}

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

export function resolveTheme(raw: unknown): Required<ThemeTokens> {
  const tokens = (raw && typeof raw === 'object' ? raw : {}) as ThemeTokens;
  return { ...DEFAULT_THEME, ...tokens };
}

/** The Google Fonts href for the chosen pair, or null when neither needs one. */
export function fontHref(theme: Required<ThemeTokens>): string | null {
  // The default pair ships with the site. Google is only contacted when the
  // Design page has picked a different family.
  const families = [fontById(theme.font_display), fontById(theme.font_body)]
    .filter((f) => f && !f.selfHosted)
    .map((f) => f?.google)
    .filter((g): g is string => !!g);
  const unique = [...new Set(families)];
  if (!unique.length) return null;
  return `https://fonts.googleapis.com/css2?${unique.map((f) => `family=${f}`).join('&')}&display=swap`;
}

const DENSITY: Record<string, number> = { compact: 0.85, normal: 1, roomy: 1.18 };

/**
 * Produces the CSS custom property overrides for the chosen theme.
 * Injected as a <style> element in the head — a style, never a script, so the
 * strict script-src policy is untouched.
 */
export function themeCss(theme: Required<ThemeTokens>): string {
  const c = (key: keyof ThemeTokens) => swatchValue(theme[key] as string);
  const display = fontById(theme.font_display)?.stack;
  const body = fontById(theme.font_body)?.stack;
  const scale = Math.min(120, Math.max(88, theme.text_scale)) / 100;
  const headingScale = Math.min(130, Math.max(85, theme.heading_scale)) / 100;
  const space = DENSITY[theme.density] ?? 1;

  const lines: string[] = [];
  const set = (name: string, value: string | null | undefined) => {
    if (value) lines.push(`  ${name}: ${value};`);
  };

  set('--pp-bg', c('page_bg'));
  set('--pp-bg-raised', c('surface_bg'));
  // Components read --pp-surface and --pp-muted directly. Without these two
  // lines the "Card background" and "Secondary text" controls did nothing.
  set('--pp-surface', c('surface_bg'));
  set('--pp-text', c('text'));
  set('--pp-text-muted', c('muted'));
  set('--pp-muted', c('muted'));
  set('--pp-heading', c('heading'));
  set('--pp-link', c('link'));
  set('--pp-action-bg', c('button_bg'));
  set('--pp-action-text', c('button_text'));
  set('--pp-header-bg', c('header_bg'));
  set('--pp-header-text', c('header_text'));
  set('--pp-footer-bg', c('footer_bg'));
  set('--pp-footer-text', c('footer_text'));
  set('--pp-accent', c('accent'));

  set('--pp-font-display', display);
  set('--pp-font-body', body);

  set('--pp-text-xs', `${(0.78 * scale).toFixed(3)}rem`);
  set('--pp-text-sm', `${(0.875 * scale).toFixed(3)}rem`);
  set('--pp-text-base', `${(1 * scale).toFixed(3)}rem`);
  set('--pp-text-lg', `${(1.125 * scale).toFixed(3)}rem`);
  set('--pp-text-xl', `clamp(${(1.25 * scale * headingScale).toFixed(3)}rem, 1.1rem + 0.6vw, ${(1.5 * scale * headingScale).toFixed(3)}rem)`);
  set('--pp-text-2xl', `clamp(${(1.5 * scale * headingScale).toFixed(3)}rem, 1.3rem + 1.1vw, ${(2 * scale * headingScale).toFixed(3)}rem)`);
  set('--pp-text-3xl', `clamp(${(1.9 * scale * headingScale).toFixed(3)}rem, 1.5rem + 2vw, ${(2.9 * scale * headingScale).toFixed(3)}rem)`);

  for (const [i, base] of [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].entries()) {
    set(`--pp-space-${i + 1}`, `${(base * space).toFixed(3)}rem`);
  }

  return lines.length ? `:root {\n${lines.join('\n')}\n}` : '';
}
