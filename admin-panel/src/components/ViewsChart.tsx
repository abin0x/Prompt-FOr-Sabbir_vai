import { useEffect, useRef, useState } from "react";
import { formatCount } from "../lib/media";

const HEIGHT = 220;
const MARGIN = { top: 12, right: 8, bottom: 26, left: 44 };
const MAX_BAR = 24;

/** Rounds up to a clean axis top, such as 1,500 instead of 1,240. */
export function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 3, 4, 5, 8, 10]) {
    if (step * magnitude >= value) return step * magnitude;
  }
  return 10 * magnitude;
}

function shortDate(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function ViewsChart({ daily }: { daily: { day: string; views: number }[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const plotWidth = Math.max(width - MARGIN.left - MARGIN.right, 10);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const top = niceMax(Math.max(...daily.map((d) => d.views), 0));
  const band = plotWidth / Math.max(daily.length, 1);
  const barWidth = Math.min(band - 2, MAX_BAR);
  const y = (value: number) => MARGIN.top + plotHeight * (1 - value / top);
  const ticks = [0, top / 2, top];
  // Keep labels apart at narrow widths; the last day is always labeled.
  const labelEvery = band < 34 ? 4 : band < 56 ? 2 : 1;

  const current = active == null ? null : daily[active];
  const centerX = active == null ? 0 : MARGIN.left + band * (active + 0.5);

  return (
    <div className="chart" ref={box}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={`Daily views for the last ${daily.length} days, peaking at ${formatCount(Math.max(...daily.map((d) => d.views), 0))}`}
        onPointerLeave={() => setActive(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              className="chart-grid"
            />
            <text x={MARGIN.left - 8} y={y(tick) + 4} textAnchor="end" className="chart-tick">
              {formatCount(tick)}
            </text>
          </g>
        ))}
        {daily.map((point, index) => {
          const center = MARGIN.left + band * (index + 0.5);
          const barHeight = plotHeight * (point.views / top);
          const left = center - barWidth / 2;
          const base = MARGIN.top + plotHeight;
          const radius = Math.min(4, barHeight, barWidth / 2);
          const showLabel = (daily.length - 1 - index) % labelEvery === 0;
          return (
            <g key={point.day}>
              {barHeight > 0 && (
                <path
                  className={active === index ? "chart-bar on" : "chart-bar"}
                  d={`M${left},${base}V${base - barHeight + radius}Q${left},${base - barHeight} ${left + radius},${base - barHeight}H${left + barWidth - radius}Q${left + barWidth},${base - barHeight} ${left + barWidth},${base - barHeight + radius}V${base}Z`}
                />
              )}
              {showLabel && (
                <text x={center} y={HEIGHT - 8} textAnchor="middle" className="chart-tick">
                  {shortDate(point.day)}
                </text>
              )}
              {/* The whole column is the hover and keyboard target. */}
              <rect
                x={MARGIN.left + band * index}
                y={MARGIN.top}
                width={band}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                aria-label={`${shortDate(point.day)}: ${point.views} views`}
                onPointerEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
              />
            </g>
          );
        })}
      </svg>
      {current && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(centerX, 60), width - 60),
            top: Math.max(y(current.views) - 52, 0),
          }}
        >
          <strong>{current.views.toLocaleString("en")}</strong>
          <span>{shortDate(current.day)}</span>
        </div>
      )}
      <details className="chart-table">
        <summary>View as table</summary>
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th className="num">Views</th>
            </tr>
          </thead>
          <tbody>
            {daily.map((point) => (
              <tr key={point.day}>
                <td>{shortDate(point.day)}</td>
                <td className="num">{point.views.toLocaleString("en")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
