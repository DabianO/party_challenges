import { useEffect } from 'react';
import type { Branding } from '@challenge/contract';
import { resolveMedia } from './media';

type Rgb = [number, number, number];

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_RE.test(value);
}

function hexToRgb(hex: string): Rgb {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

function luminance([r, g, b]: Rgb): number {
  const lin = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `hex`. */
export function contrastColor(hex: string): string {
  return contrastRatio(hex, '#000000') >= contrastRatio(hex, '#ffffff') ? '#000000' : '#ffffff';
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Nudges `hex` towards white or black until it reaches AA contrast (4.5:1) against
 * `background`, so an accent colour can also be used as text on that background.
 */
export function readableOn(hex: string, background: string): string {
  if (contrastRatio(hex, background) >= 4.5) return hex;
  const base = hexToRgb(hex);
  const target: Rgb = luminance(hexToRgb(background)) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  for (let t = 0.1; t <= 1; t += 0.1) {
    const candidate = rgbToHex(mix(base, target, t));
    if (contrastRatio(candidate, background) >= 4.5) return candidate;
  }
  return rgbToHex(target);
}

const THEME_BG: Record<'dark' | 'light', string> = { dark: '#0f1220', light: '#f4f5fb' };

const SAFE_URL_RE = /^(\/media\/[A-Za-z0-9_.-]+|https?:\/\/[^\s"'()\\]+)$/;

/**
 * Applies a game's branding (FR-60) to the document: theme, accent colour and background
 * image. Cleans up when the component unmounts or the branding changes.
 */
export function useBranding(branding: Branding | undefined | null, defaultTheme: 'dark' | 'light' = 'dark'): void {
  const theme = branding?.theme === 'light' || branding?.theme === 'dark' ? branding.theme : defaultTheme;
  const accent = isHexColor(branding?.accentColor) ? branding.accentColor : undefined;
  const background = branding?.background ? resolveMedia(branding.background) : undefined;

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    root.dataset.theme = theme;
    if (accent) {
      root.style.setProperty('--accent', accent);
      root.style.setProperty('--accent-contrast', contrastColor(accent));
      root.style.setProperty('--accent-text', readableOn(accent, THEME_BG[theme]));
    }
    if (background && SAFE_URL_RE.test(background)) {
      body.style.setProperty('--bg-image', `url("${background}")`);
      body.classList.add('has-bg-image');
    }
    return () => {
      root.dataset.theme = 'dark';
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-contrast');
      root.style.removeProperty('--accent-text');
      body.style.removeProperty('--bg-image');
      body.classList.remove('has-bg-image');
    };
  }, [theme, accent, background]);
}
