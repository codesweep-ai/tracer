import { useEffect, useRef } from "react";
import { useChartTheme } from "@codesweep-ai/ui";

/** the ✕ that marks an errored event, drawn over its kind colour. A surface
 * casing under the stroke keeps it legible on every fill (amber included). */
export function drawErrorMark(ctx: CanvasRenderingContext2D, x: number, y: number, side: number, surface: string, errorColor: string): void {
  if (side < 5) return; // below this the glyph is mush; the overview band carries errors instead
  const inset = Math.max(1, side * 0.17);
  const x0 = x + inset, y0 = y + inset, x1 = x + side - inset, y1 = y + side - inset;
  const stroke = () => { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.moveTo(x1, y0); ctx.lineTo(x0, y1); ctx.stroke(); };
  const previousCap = ctx.lineCap, previousWidth = ctx.lineWidth, previousStroke = ctx.strokeStyle;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2.5, side * 0.38); ctx.strokeStyle = surface; stroke();
  ctx.lineWidth = Math.max(1.5, side * 0.22); ctx.strokeStyle = errorColor; stroke();
  ctx.lineCap = previousCap; ctx.lineWidth = previousWidth; ctx.strokeStyle = previousStroke;
}

/** the error entry must depict the TREATMENT the strip draws (a ✕ over a cell),
 *  not a colour — errors are no longer a fill. The cell under the glyph is the strip's own
 *  track colour, standing in for "any kind". */
export function ErrorSwatch({ size = 12 }: { size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = useChartTheme();
  useEffect(() => {
    const node = canvas.current; if (!node) return;
    const ratio = window.devicePixelRatio || 1;
    node.width = size * ratio; node.height = size * ratio;
    const ctx = node.getContext("2d"); if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = theme.gridLine || theme.muted; ctx.globalAlpha = 0.35; ctx.fillRect(0, 0, size, size); ctx.globalAlpha = 1;
    drawErrorMark(ctx, 0, 0, size, theme.bg, theme.error);
  }, [size, theme]);
  return <canvas ref={canvas} aria-hidden="true" className="error-swatch" style={{ width: size, height: size }} />;
}
