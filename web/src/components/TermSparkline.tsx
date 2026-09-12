"use client";

interface Props {
  history: number[]; // recent term values, oldest first
  color: string;
}

export default function TermSparkline({ history, color }: Props) {
  if (history.length < 2) return null;
  const w = 200, h = 32;
  const max = Math.max(...history, 1);
  const points = history
    .map((t, i) => `${(i / (history.length - 1)) * w},${h - (t / max) * h}`)
    .join(" ");

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} opacity={0.8} />
    </svg>
  );
}