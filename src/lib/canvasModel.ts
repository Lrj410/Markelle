/** Minimal canvas board stored as JSON under vault `.markelle/canvas/`. */

export interface CanvasCard {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

export interface CanvasDoc {
  version: 1;
  cards: CanvasCard[];
  updatedAt: number;
}

export function emptyCanvas(): CanvasDoc {
  return { version: 1, cards: [], updatedAt: Date.now() };
}

export function parseCanvas(raw: string): CanvasDoc {
  try {
    const v = JSON.parse(raw) as CanvasDoc;
    if (v?.version !== 1 || !Array.isArray(v.cards)) return emptyCanvas();
    return {
      version: 1,
      cards: v.cards.map((c, i) => ({
        id: String(c.id ?? `c${i}`),
        x: Number(c.x) || 0,
        y: Number(c.y) || 0,
        w: Math.max(120, Number(c.w) || 200),
        h: Math.max(80, Number(c.h) || 120),
        text: String(c.text ?? ""),
      })),
      updatedAt: Number(v.updatedAt) || Date.now(),
    };
  } catch {
    return emptyCanvas();
  }
}

export function newCard(partial?: Partial<CanvasCard>): CanvasCard {
  return {
    id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    x: 40 + Math.random() * 80,
    y: 40 + Math.random() * 80,
    w: 220,
    h: 140,
    text: "",
    ...partial,
  };
}
