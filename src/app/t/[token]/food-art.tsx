/**
 * Illustrated stand-ins for dishes that don't have a photo yet. Picked from
 * the item / category name so every card has an appetising visual. Uploading
 * a real photo in Admin → Menu replaces it automatically.
 */
export type FoodKind = "pizza" | "deal" | "fries" | "wings" | "bread" | "sticks" | "dessert" | "shake" | "drink" | "water" | "default";

const RULES: [RegExp, FoodKind][] = [
  [/deal|combo|feast|bundle/i, "deal"],
  [/wing|nugget|boti(?!.*pizza)/i, "wings"],
  [/fries|chips/i, "fries"],
  [/garlic|bread/i, "bread"],
  [/stick/i, "sticks"],
  [/cake|brownie|dessert|lava|nutella|sweet/i, "dessert"],
  [/shake|smoothie|margarita|lassi|mojito/i, "shake"],
  [/water/i, "water"],
  [/7up|pepsi|coke|cola|sprite|drink|soda|juice|dew/i, "drink"],
  [/pizza|margherita|crust|pie/i, "pizza"],
];

export function foodKind(name: string, category = ""): FoodKind {
  for (const [re, kind] of RULES) if (re.test(name)) return kind;
  for (const [re, kind] of RULES) if (re.test(category)) return kind;
  return /pizza/i.test(category) ? "pizza" : "default";
}

const BG: Record<FoodKind, [string, string]> = {
  pizza: ["#fde68a", "#fb923c"],
  deal: ["#fecaca", "#f97316"],
  fries: ["#fef08a", "#facc15"],
  wings: ["#fed7aa", "#ea580c"],
  bread: ["#fde68a", "#d97706"],
  sticks: ["#fef3c7", "#f59e0b"],
  dessert: ["#fbcfe8", "#a855f7"],
  shake: ["#fce7f3", "#ec4899"],
  drink: ["#bbf7d0", "#10b981"],
  water: ["#bae6fd", "#0ea5e9"],
  default: ["#fde68a", "#fb923c"],
};

function Pizza({ variant = 0 }: { variant?: number }) {
  const toppings = [
    [-14, -12], [12, -16], [18, 6], [-6, 14], [-20, 6], [4, -2], [-2, -24], [22, -8],
  ];
  const tone = ["#b91c1c", "#7c2d12", "#166534"][variant % 3];
  return (
    <g>
      <circle r="38" fill="#c2410c" />
      <circle r="33" fill="#dc2626" />
      <circle r="31" fill="#fde047" />
      <path d="M-24 -12 q8 -6 16 0 t16 0 t16 2" stroke="#fef9c3" strokeWidth="5" fill="none" strokeLinecap="round" opacity=".7" />
      {toppings.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 3 === 2 ? 3.5 : 5} fill={i % 3 === 2 ? "#15803d" : tone} />
      ))}
      <path d="M0 0 L36 -14 A38 38 0 0 1 38 4 Z" fill="#fff" opacity=".18" />
    </g>
  );
}

function Art({ kind, seed }: { kind: FoodKind; seed: number }) {
  switch (kind) {
    case "pizza":
    case "default":
      return <Pizza variant={seed} />;
    case "deal":
      return (
        <g>
          <g transform="translate(-10 4) scale(.85)">
            <Pizza variant={seed} />
          </g>
          <g transform="translate(26 -6)">
            <rect x="-9" y="-22" width="18" height="40" rx="4" fill="#ef4444" />
            <rect x="-9" y="-10" width="18" height="10" fill="#fff" opacity=".85" />
            <path d="M3 -22 L8 -38" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          </g>
          <g transform="translate(-34 22)">
            <path d="M-10 -6 h20 l-3 16 h-14 z" fill="#ef4444" />
            {[-6, -2, 2, 6].map((x) => (
              <rect key={x} x={x - 1.5} y="-16" width="3" height="12" rx="1" fill="#facc15" />
            ))}
          </g>
        </g>
      );
    case "fries":
      return (
        <g>
          {[-18, -10, -2, 6, 14, 20].map((x, i) => (
            <rect key={x} x={x - 3} y={-34 + (i % 3) * 5} width="6" height="34" rx="2" fill="#facc15" stroke="#eab308" />
          ))}
          <path d="M-26 -6 h52 l-7 40 h-38 z" fill="#dc2626" />
          <path d="M-26 -6 h52 l-2 8 h-48 z" fill="#b91c1c" />
          <circle cx="0" cy="16" r="7" fill="#fff" opacity=".9" />
        </g>
      );
    case "wings":
      return (
        <g>
          {[[-14, 4, -25], [14, -2, 20], [0, 18, 0]].map(([x, y, a], i) => (
            <g key={i} transform={`translate(${x} ${y}) rotate(${a})`}>
              <ellipse rx="15" ry="11" fill="#c2410c" />
              <ellipse rx="10" ry="6" cx="-3" cy="-3" fill="#ea580c" />
              <rect x="12" y="-3" width="12" height="6" rx="3" fill="#fef3c7" />
            </g>
          ))}
        </g>
      );
    case "bread":
      return (
        <g transform="rotate(-12)">
          {[-24, -8, 8, 24].map((x) => (
            <g key={x}>
              <rect x={x - 7} y="-22" width="14" height="44" rx="5" fill="#d97706" />
              <rect x={x - 5} y="-19" width="10" height="38" rx="4" fill="#fde68a" />
              <circle cx={x} cy="-6" r="2" fill="#16a34a" />
              <circle cx={x - 2} cy="6" r="1.5" fill="#16a34a" />
            </g>
          ))}
        </g>
      );
    case "sticks":
      return (
        <g>
          {[-20, -8, 4, 16].map((x, i) => (
            <g key={x} transform={`rotate(${-20 + i * 12})`}>
              <rect x={x - 5} y="-28" width="10" height="56" rx="5" fill="#f59e0b" />
              <rect x={x - 3} y="-30" width="6" height="8" rx="3" fill="#fef9c3" />
            </g>
          ))}
        </g>
      );
    case "dessert":
      return (
        <g>
          <ellipse cy="26" rx="36" ry="8" fill="#fff" opacity=".8" />
          <path d="M-24 22 L-20 -10 Q0 -20 20 -10 L24 22 Z" fill="#5b2a0e" />
          <path d="M-20 -10 Q0 -20 20 -10 Q12 2 0 -2 Q-12 2 -20 -10" fill="#3f1d0a" />
          <path d="M-6 -6 q4 14 0 30 M6 -6 q-2 10 2 30" stroke="#7c2d12" strokeWidth="4" fill="none" />
          <circle cx="6" cy="-18" r="6" fill="#dc2626" />
          <path d="M6 -24 q4 -6 8 -6" stroke="#16a34a" strokeWidth="2" fill="none" />
        </g>
      );
    case "shake":
      return (
        <g>
          <path d="M-18 -18 h36 l-6 50 h-24 z" fill="#fff" opacity=".9" />
          <path d="M-16 -10 h32 l-5 40 h-22 z" fill="#ec4899" />
          <circle cx="-10" cy="-20" r="10" fill="#fdf2f8" />
          <circle cx="6" cy="-22" r="12" fill="#fdf2f8" />
          <circle cx="0" cy="-34" r="5" fill="#dc2626" />
          <path d="M10 -28 L20 -48" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" />
        </g>
      );
    case "water":
      return (
        <g>
          <rect x="-12" y="-30" width="24" height="62" rx="8" fill="#e0f2fe" stroke="#0284c7" strokeWidth="2" />
          <rect x="-6" y="-38" width="12" height="9" rx="2" fill="#0284c7" />
          <rect x="-12" y="-4" width="24" height="16" fill="#38bdf8" opacity=".6" />
        </g>
      );
    case "drink":
      return (
        <g>
          <path d="M-18 -20 h36 l-5 52 h-26 z" fill="#ffffff" opacity=".9" />
          <path d="M-16 -8 h32 l-4 38 h-24 z" fill="#16a34a" />
          {[[-6, 4], [4, 14], [-2, 22], [7, 0]].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="2.2" fill="#dcfce7" />
          ))}
          <rect x="-14" y="-16" width="10" height="8" rx="2" fill="#e0f2fe" transform="rotate(-12)" />
          <path d="M6 -20 L14 -42" stroke="#ef4444" strokeWidth="4" strokeLinecap="round" />
        </g>
      );
  }
}

export function FoodArt({ name, category, className = "" }: { name: string; category?: string; className?: string }) {
  const kind = foodKind(name, category);
  const [a, b] = BG[kind];
  const seed = [...name].reduce((s, c) => s + c.charCodeAt(0), 0);
  const id = `g${seed}${kind}`;
  return (
    <svg viewBox="-50 -50 100 100" className={className} role="img" aria-label={name} preserveAspectRatio="xMidYMid slice">
      <defs>
        <radialGradient id={id} cx="30%" cy="25%" r="90%">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </radialGradient>
      </defs>
      <rect x="-50" y="-50" width="100" height="100" fill={`url(#${id})`} />
      <circle cx="-34" cy="-36" r="16" fill="#fff" opacity=".18" />
      <circle cx="40" cy="38" r="22" fill="#fff" opacity=".12" />
      <g transform={`rotate(${(seed % 5) * 6 - 12})`}>
        <Art kind={kind} seed={seed} />
      </g>
    </svg>
  );
}

export const CATEGORY_ICON: Record<string, string> = {
  deal: "🔥",
  pizza: "🍕",
  fries: "🍟",
  wings: "🍗",
  bread: "🥖",
  sticks: "🧀",
  dessert: "🍫",
  shake: "🥤",
  drink: "🥤",
  water: "💧",
  default: "🍽️",
};
