/**
 * Player colours: every player keeps one colour for the whole game (graphs, territories, any
 * module that colours players), assigned in join order. Hues a golden angle apart stay distinct
 * for any number of players; alternating lightness separates neighbours further.
 */
export function playerColor(index: number): string {
  const h = (index * 137.508 + 12) % 360;
  const s = 0.74;
  const l = index % 2 ? 0.6 : 0.52;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Distinct, easy-to-tell-apart icons: one per player in join order (100 before any repeats). */
export const PLAYER_ICONS = [
  '🦊', '🐼', '🐸', '🦁', '🐙', '🦄', '🐝', '🐢', '🦉', '🐧',
  '🐳', '🦋', '🐨', '🐯', '🦖', '🐞', '🦀', '🐬', '🦩', '🐮',
  '🐷', '🐵', '🦒', '🦓', '🦔', '🦦', '🦥', '🐿️', '🦜', '🐊',
  '🍕', '🍩', '🍉', '🍓', '🥑', '🌮', '🍔', '🧁', '🍦', '🍪',
  '🍋', '🍒', '🍍', '🥕', '🌶️', '🥨', '🍿', '🧀', '🍄', '🌽',
  '⚽', '🏀', '🎾', '🎳', '🎯', '🎲', '🧩', '🎸', '🎺', '🥁',
  '🚀', '🛸', '🚲', '⛵', '🚂', '🚁', '🏎️', '🛹', '🎈', '🪁',
  '🌵', '🌻', '🌈', '⭐', '🌙', '☀️', '❄️', '🔥', '🌊', '⚡',
  '👑', '🎩', '🕶️', '🎀', '💎', '🔮', '🧲', '🔑', '📯', '🧭',
  '🦕', '🐉', '🦚', '🦞', '🐌', '🦘', '🦭', '🐫', '🦙', '🐓',
];

export function playerIcon(index: number): string {
  return PLAYER_ICONS[((index % PLAYER_ICONS.length) + PLAYER_ICONS.length) % PLAYER_ICONS.length]!;
}
